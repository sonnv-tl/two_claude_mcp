// Terminal của agent chạy ngầm trong hub (pseudo-terminal): web mở ra xem / gõ, đóng lại thì session vẫn chạy.
// Mỗi terminal có một xterm headless giữ màn hình hiện tại, để web mở lúc nào cũng thấy đúng trạng thái.
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as pty from "@lydell/node-pty";
import xtermHeadless from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import type { ServerOp, TermInfo } from "@tcm/shared";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

/** Cấu hình một agent, lấy từ .team-hub.json (agents.dev / agents.qa) */
export interface AgentLaunch {
  model?: string;
  permissionMode?: string;
  skipPermissions?: boolean;
  browser?: boolean;
  channel?: boolean;
}

/** Cấu hình chạy agent của một phòng, do tcm start / resume gửi lên */
export interface RoomLaunch {
  /** Repo đích (đường dẫn Windows) */
  repoDir?: string;
  /** Repo nằm trong WSL: đường dẫn Linux + distro */
  wslCwd?: string;
  distro?: string;
  agents?: Record<string, AgentLaunch>;
}

export const DEFAULT_ROLES = ["dev", "qa"];
const NAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;
const MODEL_RE = /^[a-zA-Z0-9_.:[\]-]{1,60}$/;
const COLS = 120;
const ROWS = 34;

type Viewer = (op: ServerOp) => void;

interface Entry {
  room: string;
  name: string;
  role: string;
  proc: pty.IPty | null;
  term: InstanceType<typeof Terminal>;
  ser: InstanceType<typeof SerializeAddon>;
  viewers: Set<Viewer>;
  startedAt: string;
  exitCode: number | null;
}

function toWslPath(winPath: string) {
  const m = winPath.replace(/\\/g, "/").match(/^([a-zA-Z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : winPath;
}

/** Lệnh mở session agent qua scripts/claude-as (giống tcm mở Windows Terminal), không qua shell nên không cần escape */
export function agentCommand(repoRoot: string, room: string, role: string, launch: RoomLaunch, resume: boolean, hubUrl: string) {
  if (!NAME_RE.test(room) || !NAME_RE.test(role)) throw new Error("Tên phòng / vai trò không hợp lệ");
  const a = launch.agents?.[role] ?? {};
  if (a.model && !MODEL_RE.test(a.model)) throw new Error(`model không hợp lệ: ${a.model}`);
  if (a.permissionMode && !/^[a-zA-Z]{1,30}$/.test(a.permissionMode)) throw new Error(`permissionMode không hợp lệ: ${a.permissionMode}`);
  const noBrowser = role === "qa" && a.browser === false;
  // Smoke test: chạy agent giả thay cho claude (JSON mảng lệnh, thêm role + room ở cuối)
  if (process.env.HUB_AGENT_CMD) {
    const [file, ...args] = JSON.parse(process.env.HUB_AGENT_CMD) as string[];
    return { file, args: [...args, role, room], cwd: repoRoot };
  }

  if (launch.wslCwd) {
    if (!launch.wslCwd.startsWith("/") || /["'`$\\\n]/.test(launch.wslCwd)) throw new Error(`đường dẫn WSL không hợp lệ: ${launch.wslCwd}`);
    const distro = launch.distro || "Ubuntu";
    if (!NAME_RE.test(distro)) throw new Error(`distro không hợp lệ: ${distro}`);
    const env = [
      `HUB_URL=${hubUrl}`,
      resume && "RESUME=1",
      noBrowser && "NO_BROWSER=1",
      a.model && `MODEL=${a.model}`,
      a.permissionMode && `PERMISSION_MODE=${a.permissionMode}`,
      a.skipPermissions !== false && "SKIP_PERMISSIONS=1",
      a.channel && "CHANNEL=1",
    ].filter(Boolean);
    const line = `${env.join(" ")} bash '${toWslPath(repoRoot)}/scripts/claude-as.sh' ${role} ${room}`.trim();
    return { file: "wsl.exe", args: ["-d", distro, "--cd", launch.wslCwd, "--", "bash", "-lc", line], cwd: repoRoot };
  }

  const cwd = launch.repoDir;
  if (!cwd || !existsSync(cwd)) throw new Error(`Không thấy repo "${cwd ?? ""}": chạy tcm start / tcm resume trong repo`);
  const args = ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(repoRoot, "scripts", "claude-as.ps1"), "-Role", role, "-Room", room, "-HubUrl", hubUrl];
  if (noBrowser) args.push("-NoBrowser");
  if (a.model) args.push("-Model", a.model);
  if (a.permissionMode) args.push("-PermissionMode", a.permissionMode);
  if (a.skipPermissions !== false) args.push("-SkipPermissions");
  if (a.channel) args.push("-Channel");
  if (resume) args.push("-Resume");
  return { file: "powershell.exe", args, cwd };
}

export class Terminals {
  private entries = new Map<string, Entry>();

  /** onChange: danh sách terminal của phòng đổi (chạy / thoát) */
  constructor(private onChange: (room: string) => void) {}

  private key(room: string, name: string) {
    return `${room}/${name}`;
  }

  get(room: string, name: string) {
    return this.entries.get(this.key(room, name));
  }

  isRunning(room: string, name: string) {
    return !!this.get(room, name)?.proc;
  }

  list(room: string): Omit<TermInfo, "canStart">[] {
    return [...this.entries.values()]
      .filter((e) => e.room === room)
      .map((e) => ({ name: e.name, role: e.role, running: !!e.proc, pid: e.proc?.pid || null, startedAt: e.startedAt, exitCode: e.exitCode }));
  }

  start(room: string, name: string, role: string, cmd: { file: string; args: string[]; cwd: string }) {
    this.stop(room, name);
    const old = this.get(room, name);
    const term = new Terminal({ cols: old?.term.cols ?? COLS, rows: old?.term.rows ?? ROWS, scrollback: 3000, allowProposedApi: true });
    const ser = new SerializeAddon();
    term.loadAddon(ser);
    const proc = pty.spawn(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: term.cols,
      rows: term.rows,
      cwd: cmd.cwd,
      env: process.env as Record<string, string>,
    });
    const e: Entry = { room, name, role, proc, term, ser, viewers: old?.viewers ?? new Set(), startedAt: new Date().toISOString(), exitCode: null };
    this.entries.set(this.key(room, name), e);

    // Gửi cho web sau khi xterm headless đã xử lý: snapshot lúc attach luôn khớp với dòng dữ liệu phía sau
    proc.onData((data) => term.write(data, () => this.emit(e, { op: "term_data", name, data })));
    proc.onExit(({ exitCode }) => {
      if (e.proc !== proc) return; // đã có session mới thay thế
      e.proc = null;
      e.exitCode = exitCode;
      const note = `\r\n\x1b[2m[session đã thoát, mã ${exitCode}]\x1b[0m\r\n`;
      term.write(note, () => {
        this.emit(e, { op: "term_data", name, data: note });
        this.emit(e, { op: "term_exit", name, code: exitCode });
      });
      this.onChange(room);
    });
    // Web đang mở terminal này (session cũ) → gửi màn hình mới
    for (const v of e.viewers) v({ op: "term_snapshot", name, data: "", cols: term.cols, rows: term.rows });
    this.onChange(room);
    return e;
  }

  stop(room: string, name: string) {
    const e = this.get(room, name);
    if (!e?.proc) return false;
    const proc = e.proc;
    e.proc = null;
    e.exitCode = null;
    try {
      proc.kill();
    } catch {
      /* đã thoát */
    }
    this.onChange(room);
    return true;
  }

  stopAll() {
    for (const e of this.entries.values()) {
      try {
        e.proc?.kill();
      } catch {
        /* bỏ qua */
      }
    }
  }

  attach(room: string, name: string, viewer: Viewer, cols?: number, rows?: number) {
    const e = this.get(room, name);
    if (!e) throw new Error(`${name} chưa có terminal trên hub (tcm start / tcm resume để chạy ngầm)`);
    if (cols && rows) this.resize(room, name, cols, rows);
    // Chờ xterm xử lý hết dữ liệu đang xếp hàng rồi mới chụp màn hình và nhận stream
    e.term.write("", () => {
      e.viewers.add(viewer);
      viewer({ op: "term_snapshot", name, data: e.ser.serialize(), cols: e.term.cols, rows: e.term.rows });
    });
  }

  detach(room: string, name: string, viewer: Viewer) {
    this.get(room, name)?.viewers.delete(viewer);
  }

  detachAll(viewer: Viewer) {
    for (const e of this.entries.values()) e.viewers.delete(viewer);
  }

  input(room: string, name: string, data: string) {
    this.get(room, name)?.proc?.write(data);
  }

  resize(room: string, name: string, cols: number, rows: number) {
    const e = this.get(room, name);
    if (!e) return;
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    if (c === e.term.cols && r === e.term.rows) return;
    e.term.resize(c, r);
    try {
      e.proc?.resize(c, r);
    } catch {
      /* đang thoát */
    }
  }

  /** Gõ một dòng vào prompt của session rồi Enter (đánh thức agent đang nghỉ) */
  type(room: string, name: string, text: string) {
    const proc = this.get(room, name)?.proc;
    if (!proc) return false;
    proc.write(text.replace(/[\r\n]+/g, " "));
    // Enter tách riêng: gõ liền một khối thì ô nhập có thể coi là dán, không gửi
    setTimeout(() => proc.write("\r"), 150);
    return true;
  }

  private emit(e: Entry, op: ServerOp) {
    for (const v of e.viewers) v(op);
  }
}
