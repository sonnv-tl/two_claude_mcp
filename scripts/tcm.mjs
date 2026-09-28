#!/usr/bin/env node
// tcm: mở một ticket cho cặp DEV/QA bằng một lệnh.
//   tcm init                      tạo .team-hub.json + .team-hub.local.json, thêm file của tcm/agent vào .git/info/exclude
//   tcm start <TICKET> [options]  bảo đảm hub chạy → lưu thông tin kickoff → mở Windows Terminal 2 pane (DEV | QA)
//                                 → mở web → chờ 2 agent online rồi gửi kickoff
//       --room <tên>     tên phòng (mặc định = mã ticket)
//       --figma <url>    link Figma thay cho link trong ticket (ghi đè .team-hub.json)
//       --account "<user> / <pass>"   tài khoản test (ghi đè)
//       --notes "<text>" ghi chú thêm vào kickoff
//       --manual         không tự gửi kickoff (soạn/gửi bằng nút 🎫 Kickoff trên web)
//       --no-open        không mở web
//       --no-terminal    không mở terminal (tự mở bằng claude-as)
//       --dry-run        chỉ in lệnh wt.exe, không mở terminal
//   tcm vscode                    thêm task vào .vscode/tasks.json: 2 terminal DEV | QA chia đôi ngay trong VS Code
//   tcm stop <ROOM>               tắt chế độ trực (agent kết thúc lượt khi xong việc)
//   tcm status                    hub + danh sách phòng
// Chạy từ WSL qua scripts/tcm (wrapper bash), từ PowerShell/cmd qua scripts\tcm.cmd.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.HUB_PORT ?? 4747);
const HUB = `http://127.0.0.1:${PORT}`;
const NAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;

// ---------- args ----------
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  } else pos.push(a);
}
const [cmd, arg1] = pos;
const cwd = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
/** Chạy từ WSL: đường dẫn Linux của repo + tên distro (do wrapper bash truyền vào) */
const wslCwd = typeof opts["wsl-cwd"] === "string" ? opts["wsl-cwd"] : null;
const distro = typeof opts.distro === "string" ? opts.distro : "Ubuntu";

const die = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config ----------
function findConfigDir(start) {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, ".team-hub.json")) || existsSync(join(d, ".team-hub.local.json"))) return d;
    const up = dirname(d);
    if (up === d || parsePath(d).root === d) return null;
    d = up;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (existsSync(file)) die(`${file} không phải JSON hợp lệ: ${e.message}`);
    return {};
  }
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v;
  }
  return out;
}

function loadConfig() {
  const dir = findConfigDir(cwd);
  if (!dir) return { dir: null, cfg: {} };
  return { dir, cfg: merge(readJson(join(dir, ".team-hub.json")), readJson(join(dir, ".team-hub.local.json"))) };
}

// ---------- hub ----------
async function hubUp() {
  try {
    const r = await fetch(`${HUB}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureHub() {
  if (await hubUp()) return;
  console.log("… hub chưa chạy, đang khởi động");
  const waitUp = async (ms) => {
    for (let t = 0; t < ms; t += 500) {
      await sleep(500);
      if (await hubUp()) return true;
    }
    return false;
  };
  // Task TeamHub (hub-service.ps1) chỉ chạy hub ở port mặc định
  if (PORT === 4747 && spawnSync("schtasks", ["/Run", "/TN", "TeamHub"], { stdio: "ignore" }).status === 0 && (await waitUp(5000)))
    return console.log(`✔ hub: ${HUB} (task TeamHub)`);
  const hubJs = join(ROOT, "packages/hub/dist/index.js");
  if (!existsSync(hubJs)) die(`chưa build hub: chạy "npm run build" trong ${ROOT}`);
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", hubJs, "--log", process.env.HUB_LOG || join(ROOT, "data", "hub.log")], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  }).unref();
  if (await waitUp(10_000)) return console.log(`✔ hub: ${HUB}`);
  die(`không khởi động được hub. Xem log: ${join(ROOT, "data/hub.log")}`);
}

async function api(path, body) {
  const r = await fetch(`${HUB}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) die(data.error ?? `${path}: HTTP ${r.status}`);
  return data;
}

// ---------- terminal ----------
function toWslPath(winPath) {
  const m = winPath.replace(/\\/g, "/").match(/^([a-zA-Z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : winPath;
}

function agentCmd(role, room, agentCfg) {
  const a = agentCfg ?? {};
  if (wslCwd) {
    const env = [];
    if (role === "qa" && a.browser === false) env.push("NO_BROWSER=1");
    if (a.model) env.push(`MODEL=${a.model}`);
    if (a.permissionMode) env.push(`PERMISSION_MODE=${a.permissionMode}`);
    if (a.skipPermissions !== false) env.push("SKIP_PERMISSIONS=1");
    if (a.channel) env.push("CHANNEL=1");
    const script = `${toWslPath(ROOT)}/scripts/claude-as.sh`;
    // Không dùng ";" (wt coi là dấu tách lệnh). Claude thoát thì giữ shell lại.
    const line = `${env.join(" ")} bash ${script} ${role} ${room} || true && exec bash`.trim();
    return ["wsl.exe", "-d", distro, "--cd", wslCwd, "--", "bash", "-lc", line];
  }
  const ps = ["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "claude-as.ps1"), "-Role", role, "-Room", room];
  if (role === "qa" && a.browser === false) ps.push("-NoBrowser");
  if (a.model) ps.push("-Model", a.model);
  if (a.permissionMode) ps.push("-PermissionMode", a.permissionMode);
  if (a.skipPermissions !== false) ps.push("-SkipPermissions");
  if (a.channel) ps.push("-Channel");
  return ps;
}

function openTerminals(room, cfg) {
  const agents = cfg.agents ?? {};
  const d = wslCwd ? [] : ["-d", cwd];
  const args = [
    "-w", `tcm-${room}`,
    "new-tab", "--title", `DEV · ${room}`, ...d, ...agentCmd("dev", room, agents.dev),
    ";",
    "split-pane", "-V", "--title", `QA · ${room}`, ...d, ...agentCmd("qa", room, agents.qa),
  ];
  if (opts["dry-run"]) {
    console.log("[dry-run] wt.exe " + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return true;
  }
  const r = spawnSync("wt.exe", args, { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.warn("⚠ không mở được Windows Terminal (wt.exe). Tự mở 2 terminal:");
    console.warn(wslCwd ? `   bash ${toWslPath(ROOT)}/scripts/claude-as.sh dev ${room}\n   bash ${toWslPath(ROOT)}/scripts/claude-as.sh qa ${room}`
      : `   powershell -ExecutionPolicy Bypass -File ${join(ROOT, "scripts", "claude-as.ps1")} -Role dev -Room ${room}\n   … -Role qa -Room ${room}`);
    return false;
  }
  console.log(`✔ đã mở Windows Terminal: DEV | QA (cửa sổ "tcm-${room}")`);
  return true;
}

function openWeb(room) {
  spawn("cmd", ["/c", "start", "", `${HUB}/#/${encodeURIComponent(room)}`], { stdio: "ignore", detached: true }).unref();
}

async function waitAgents(room, timeoutMs) {
  const start = Date.now();
  let onlineAt = 0;
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const ps = await api(`/api/rooms/${encodeURIComponent(room)}/participants`);
    const dev = ps.find((p) => p.name === "dev");
    const qa = ps.find((p) => p.name === "qa");
    const state = `dev: ${dev?.online ? (dev.waiting ? "chờ việc" : "online") : "—"} · qa: ${qa?.online ? (qa.waiting ? "chờ việc" : "online") : "—"}`;
    if (state !== last) {
      console.log(`  ${state}`);
      last = state;
    }
    if (dev?.online && qa?.online) {
      onlineAt ||= Date.now();
      // cả hai đã vào chế độ chờ, hoặc online đủ lâu (tin kickoff vẫn được giao qua hộp thư)
      if ((dev.waiting && qa.waiting) || Date.now() - onlineAt > 30_000) return true;
    }
    await sleep(1500);
  }
  return false;
}

// ---------- git exclude (cá nhân, không đụng .gitignore) ----------

/** Đường dẫn .git/info/exclude của repo chứa `start` (hỗ trợ cả worktree: .git là file "gitdir: …") */
function findExcludeFile(start) {
  let d = resolve(start);
  for (;;) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      let gitDir = g;
      try {
        const txt = readFileSync(g, "utf8"); // chỉ đọc được nếu .git là file
        const m = txt.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          const p = m[1].trim();
          // worktree trong WSL ghi đường dẫn Linux → đổi sang UNC nếu đang chạy qua WSL
          gitDir = p.startsWith("/") && wslCwd ? join(cwd.slice(0, cwd.length - wslCwd.length), p) : resolve(d, p);
        }
      } catch {
        /* .git là thư mục */
      }
      return join(gitDir, "info", "exclude");
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Các file/thư mục do tcm và agent tạo ra trong repo */
function personalEntries(cfg) {
  const p = cfg.paths ?? {};
  return [
    ".team-hub.json",
    ".team-hub.local.json",
    ".vscode/tasks.json",
    `${(p.plan || "docs/plan").replace(/\/$/, "")}/`,
    `${(p.testcases || "qa/testcases").replace(/\/$/, "")}/`,
    `${(p.runs || "qa/runs").replace(/\/$/, "")}/`,
    "qa/screenshots/",
    ".playwright-mcp/",
  ];
}

function ensureExclude(entries, { quiet = false } = {}) {
  const file = findExcludeFile(cwd);
  if (!file) {
    if (!quiet) console.log("… không thấy thư mục .git: bỏ qua .git/info/exclude");
    return;
  }
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = entries.filter((e) => !have.has(e) && !have.has(`/${e}`));
  if (!add.length) return;
  mkdirSync(dirname(file), { recursive: true });
  const header = have.has("# team-hub (tcm)") ? "" : "\n# team-hub (tcm)\n";
  appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${header}${add.join("\n")}\n`);
  console.log(`✔ thêm vào .git/info/exclude: ${add.join(", ")}`);
}

// ---------- commands ----------
async function cmdInit() {
  const main = join(cwd, ".team-hub.json");
  const local = join(cwd, ".team-hub.local.json");
  if (existsSync(main)) die(`${main} đã tồn tại`);
  const cfg = {
    figma: "",
    app: { run: "npm run dev", url: "http://localhost:8888" },
    paths: { plan: "docs/plan", testcases: "qa/testcases", runs: "qa/runs" },
    notes: "",
    agents: {
      dev: { model: "", permissionMode: "", skipPermissions: true },
      qa: { model: "", permissionMode: "", skipPermissions: true, browser: false },
    },
  };
  writeFileSync(main, JSON.stringify(cfg, null, 2) + "\n");
  if (!existsSync(local)) writeFileSync(local, JSON.stringify({ testAccount: "100000 / Password_1" }, null, 2) + "\n");
  console.log(`✔ tạo ${main}\n✔ tạo ${local} (tài khoản test)`);
  ensureExclude(personalEntries(cfg));
  console.log(`  "skipPermissions": true = chạy claude với --dangerously-skip-permissions (không hỏi duyệt quyền).`);
  console.log(`  "agents.qa.browser": false = QA dùng browser MCP có sẵn của project (vd. playwright), không nạp thêm.`);
}

async function cmdStart() {
  const ticket = arg1;
  if (!ticket) die("cách dùng: tcm start <TICKET> [--room X] [--figma URL] [--account \"u / p\"] [--manual]");
  const room = typeof opts.room === "string" ? opts.room : ticket;
  if (!NAME_RE.test(room)) die(`tên phòng không hợp lệ: ${room} (chỉ chữ, số, _ . -)`);

  const { dir, cfg } = loadConfig();
  if (dir) console.log(`✔ config: ${dir}`);
  else console.log("… không thấy .team-hub.json (chạy `tcm init` để tạo). Dùng mặc định.");

  const meta = {
    ticket,
    figma: typeof opts.figma === "string" ? opts.figma : cfg.figma,
    testAccount: typeof opts.account === "string" ? opts.account : cfg.testAccount,
    appRun: cfg.app?.run,
    appUrl: cfg.app?.url,
    planDir: cfg.paths?.plan,
    testcaseDir: cfg.paths?.testcases,
    runsDir: cfg.paths?.runs,
    notes: typeof opts.notes === "string" ? opts.notes : cfg.notes,
  };
  ensureExclude(personalEntries(cfg), { quiet: true });
  if (!meta.testAccount) console.log("… chưa có tài khoản test (thêm vào .team-hub.local.json hoặc --account)");

  await ensureHub();
  const rooms = await api("/api/rooms");
  const existing = rooms.find((r) => r.name === room);
  if (existing?.messageCount) console.log(`… phòng "${room}" đã có ${existing.messageCount} tin. Muốn làm lại từ đầu thì dùng --room ${room}-2`);
  await api(`/api/rooms/${encodeURIComponent(room)}/meta`, meta);
  await api(`/api/rooms/${encodeURIComponent(room)}/duty`, { onDuty: true });

  if (!opts["no-terminal"]) openTerminals(room, cfg);
  if (!opts["no-open"]) openWeb(room);

  if (opts.manual) {
    console.log("✔ đã lưu thông tin kickoff. Gửi bằng nút 🎫 Kickoff trên web khi sẵn sàng.");
    return;
  }
  console.log("… chờ DEV và QA online (duyệt các prompt trong terminal nếu có)");
  const ok = await waitAgents(room, 180_000);
  if (!ok) {
    console.log("⚠ chưa thấy đủ 2 agent sau 3 phút. Gửi kickoff bằng nút 🎫 Kickoff trên web khi sẵn sàng.");
    return;
  }
  const r = await api(`/api/rooms/${encodeURIComponent(room)}/kickoff`, { meta, send: true });
  console.log(`✔ đã gửi kickoff #${r.message?.id} tới @all. Theo dõi: ${HUB}/#/${room}`);
}

/** Bỏ comment // và /* *\/ ngoài chuỗi (tasks.json là JSONC) */
function stripJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1"); // dấu phẩy thừa
}

/** Ghi task vào .vscode/tasks.json: 2 terminal DEV | QA chia đôi trong VS Code + 1 task gửi kickoff */
async function cmdVscode() {
  const { cfg } = loadConfig();
  const agents = cfg.agents ?? {};
  const T = "${input:tcmTicket}";
  const pres = (reveal) => ({ group: "tcm", panel: "dedicated", reveal, focus: false, showReuseMessage: false, clear: true });
  let dev, qa, kick;
  if (wslCwd) {
    // VS Code mở repo qua Remote-WSL → task chạy bằng bash trong WSL
    const envOf = (role) => {
      const a = agents[role] ?? {};
      const e = [];
      if (role === "qa" && a.browser === false) e.push("NO_BROWSER=1");
      if (a.model) e.push(`MODEL=${a.model}`);
      if (a.permissionMode) e.push(`PERMISSION_MODE=${a.permissionMode}`);
      if (a.skipPermissions !== false) e.push("SKIP_PERMISSIONS=1");
      if (a.channel) e.push("CHANNEL=1");
      return e.length ? e.join(" ") + " " : "";
    };
    const base = toWslPath(ROOT);
    dev = `${envOf("dev")}bash ${base}/scripts/claude-as.sh dev ${T}`;
    qa = `${envOf("qa")}bash ${base}/scripts/claude-as.sh qa ${T}`;
    kick = `bash ${base}/scripts/tcm start ${T} --no-terminal --no-open`;
  } else {
    const ps = (role) => agentCmd(role, T, agents[role]).slice(1).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    dev = `powershell.exe ${ps("dev").replace("-NoExit ", "")}`;
    qa = `powershell.exe ${ps("qa").replace("-NoExit ", "")}`;
    kick = `"${join(ROOT, "scripts", "tcm.cmd")}" start ${T} --no-terminal --no-open`;
  }
  const tasks = [
    { label: "tcm: DEV", type: "shell", command: dev, isBackground: true, problemMatcher: [], presentation: pres("always") },
    { label: "tcm: QA", type: "shell", command: qa, isBackground: true, problemMatcher: [], presentation: pres("always") },
    // Lưu thông tin kickoff, chờ 2 agent online rồi gửi kickoff (xem output ở terminal thứ 3)
    { label: "tcm: kickoff", type: "shell", command: kick, problemMatcher: [], presentation: { ...pres("silent"), group: "tcm-kickoff" } },
    { label: "tcm: start ticket", dependsOn: ["tcm: DEV", "tcm: QA", "tcm: kickoff"], dependsOrder: "parallel", problemMatcher: [] },
  ];
  const input = { id: "tcmTicket", type: "promptString", description: "Mã ticket (cũng là tên phòng), vd. TLPORTAL-10182" };

  const file = join(cwd, ".vscode", "tasks.json");
  let doc = { version: "2.0.0", tasks: [], inputs: [] };
  if (existsSync(file)) {
    try {
      doc = JSON.parse(stripJsonc(readFileSync(file, "utf8")));
    } catch (e) {
      die(`không đọc được ${file} (${e.message}). Thêm tay các task sau:\n${JSON.stringify({ tasks, inputs: [input] }, null, 2)}`);
    }
  }
  const labels = new Set(tasks.map((t) => t.label));
  doc.version ??= "2.0.0";
  doc.tasks = [...(doc.tasks ?? []).filter((t) => !labels.has(t.label)), ...tasks];
  doc.inputs = [...(doc.inputs ?? []).filter((i) => i.id !== input.id), input];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`✔ ghi ${file}`);
  ensureExclude([".vscode/tasks.json"]);
  console.log(`  VS Code: Ctrl+Shift+P → "Tasks: Run Task" → "tcm: start ticket" → nhập mã ticket.`);
  console.log(`  2 terminal DEV | QA mở chia đôi trong panel. Task "tcm: kickoff" tự gửi kickoff khi 2 agent online.`);
}

async function cmdStop() {
  if (!arg1) die("cách dùng: tcm stop <ROOM>");
  if (!(await hubUp())) die("hub không chạy");
  await api(`/api/rooms/${encodeURIComponent(arg1)}/duty`, { onDuty: false });
  console.log(`✔ phòng "${arg1}": đã tắt chế độ trực. Agent sẽ kết thúc lượt khi xong việc.`);
}

async function cmdStatus() {
  if (!(await hubUp())) {
    console.log(`hub: không chạy (${HUB}). Cài chạy nền: powershell -ExecutionPolicy Bypass -File ${join(ROOT, "scripts", "hub-service.ps1")} install`);
    return;
  }
  console.log(`hub: ${HUB}`);
  for (const r of await api("/api/rooms")) {
    const ps = await api(`/api/rooms/${encodeURIComponent(r.name)}/participants`);
    const who = ps.filter((p) => p.kind === "agent").map((p) => `${p.name}${p.online ? (p.waiting ? "·chờ" : "·làm") : "·off"}${p.attention ? "⚠" : ""}`);
    console.log(`  #${r.name.padEnd(24)} ${String(r.messageCount).padStart(4)} tin  ${r.onDuty ? "trực" : "nghỉ"}  ${who.join(" ")}`);
  }
}

const commands = { init: cmdInit, start: cmdStart, stop: cmdStop, status: cmdStatus, vscode: cmdVscode };
if (!commands[cmd]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, arr) => arr.slice(0, i + 1).every((x) => x.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
