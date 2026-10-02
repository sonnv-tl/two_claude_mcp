import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { format } from "node:util";

// `--log <file>`: ghi log (UTF-8) ra file, dùng khi chạy nền (scripts/hub-service.ps1)
const logArg = process.argv.indexOf("--log");
if (logArg > 0 && process.argv[logArg + 1]) {
  const logFile = process.argv[logArg + 1];
  mkdirSync(dirname(logFile), { recursive: true });
  const write = (level: string, args: unknown[]) =>
    appendFileSync(logFile, `${new Date().toISOString()} ${level} ${format(...args)}\n`);
  console.log = (...a: unknown[]) => write("INFO ", a);
  console.error = (...a: unknown[]) => write("ERROR", a);
  process.on("uncaughtException", (e) => {
    write("FATAL", [e]);
    process.exit(1);
  });
}
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  BROADCAST,
  DEFAULT_HUB_PORT,
  MESSAGE_TYPES,
  ATTACHMENT_EXT,
  BUG_SEVERITIES,
  BUG_STATUSES,
  BUG_STATUS_LABEL,
  BUG_TRANSITIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_DISPUTE_ROUNDS,
  STEPS,
  STEP_LABEL,
  boardMarkdown,
  stepSummary,
  parseStep,
  type Board,
  type Bug,
  type BugSeverity,
  type BugStatus,
  type MessageType,
  type Step,
  buildKickoff,
  isAddressedTo,
  type KickoffMeta,
  type ChatMessage,
  type ClientOp,
  type HookRequest,
  type HookResponse,
  type Participant,
  type ParticipantKind,
  type ServerOp,
} from "@tcm/shared";
import { Store, HUMAN_NAME, type ParticipantRow } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const PORT = Number(process.env.HUB_PORT ?? DEFAULT_HUB_PORT);
const HOST = process.env.HUB_HOST ?? "127.0.0.1";
const DB_FILE = process.env.HUB_DB ?? join(repoRoot, "data", "hub.db");
const WEB_DIST = process.env.HUB_WEB_DIST ?? join(repoRoot, "packages", "web", "dist");
const NAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;

/** Lỗi do dữ liệu client gửi sai: trả lỗi cho client, không log như sự cố */
class OpError extends Error {}

const store = new Store(DB_FILE);
const ATT_DIR = process.env.HUB_ATTACHMENTS ?? join(dirname(DB_FILE), "attachments");
/** Số tin agent↔agent liên tiếp không tiến triển trước khi cảnh báo (x2: yêu cầu agent dừng, hỏi user) */
const IDLE_WARN = Math.max(4, Number(process.env.HUB_IDLE_WARN ?? 20));

// ---------- board: tiến độ + bug + chống vòng lặp ----------

interface RoomRuntime {
  idleChatter: number;
  /** 0: chưa cảnh báo, 1: đã cảnh báo trên web, 2: đã yêu cầu agent dừng */
  warned: 0 | 1 | 2;
}
const roomRts = new Map<string, RoomRuntime>();
function roomRt(room: string): RoomRuntime {
  let r = roomRts.get(room);
  if (!r) roomRts.set(room, (r = { idleChatter: 0, warned: 0 }));
  return r;
}

function boardOf(room: string): Board {
  const r = roomRt(room);
  return {
    steps: store.listSteps(room),
    bugs: store.listBugs(room),
    report: store.latestReport(room),
    reportVersions: store.countReports(room),
    closedAt: store.closedAt(room),
    idleChatter: r.idleChatter,
    warning:
      r.warned > 0
        ? `${r.idleChatter} tin agent↔agent liên tiếp mà không đổi bước, không đổi trạng thái bug, user cũng không nhắn. Có thể đang bế tắc.`
        : null,
  };
}

function broadcastBoard(room: string) {
  const board = boardOf(room);
  const op: ServerOp = { op: "board", room, board };
  for (const c of roomViewers(room)) send(c, op);
  // Cảnh báo cho user (web kêu + thông báo desktop khi text đổi)
  const waitUser = board.bugs.filter((b) => b.status === "need_user").map((b) => b.code);
  const text = [
    waitUser.length ? `⚖️ ${waitUser.join(", ")} chờ bạn phân xử` : null,
    board.warning && "🔁 Agent có thể đang lặp",
    board.report && !board.closedAt && board.report.author !== HUMAN_NAME && "📄 Báo cáo B7 chờ bạn duyệt",
  ]
    .filter(Boolean)
    .join(" · ");
  setAttention(room, HUMAN_NAME, text || null);
}

/** Có tiến triển (đổi bước, đổi trạng thái bug, user nhắn) → reset bộ đếm vòng lặp */
function progress(room: string) {
  const r = roomRt(room);
  const changed = r.idleChatter !== 0 || r.warned !== 0;
  Object.assign(r, { idleChatter: 0, warned: 0 });
  return changed;
}

/** Tin agent↔agent không kèm tiến triển: đếm, quá ngưỡng thì cảnh báo / yêu cầu dừng */
function chatter(room: string) {
  const r = roomRt(room);
  r.idleChatter++;
  if (r.idleChatter >= IDLE_WARN && r.warned === 0) {
    r.warned = 1;
    systemMessage(room, `⚠️ ${r.idleChatter} tin agent↔agent liên tiếp không có tiến triển. Xem lại có đang lặp không.`);
    return true;
  }
  if (r.idleChatter >= IDLE_WARN * 2 && r.warned === 1) {
    r.warned = 2;
    hubMessage(
      room,
      `⚠️ **Dừng trao đổi qua lại.** Đã ${r.idleChatter} tin giữa các agent mà không đổi bước, không đổi trạng thái bug. ` +
        "Mỗi bên gửi `user` **1 tin** tóm tắt đang vướng gì và cần user quyết gì, rồi `wait_for_messages` chờ user. " +
        "Không nhắn tiếp cho nhau tới khi user trả lời.",
      "question",
    );
    return true;
  }
  return false;
}

/** Tin do hub gửi mà agent NHẬN được (khác system message chỉ hiện trên web) */
function hubMessage(room: string, content: string, type: MessageType = "chat", replyTo: number | null = null) {
  const msg = store.addMessage({ room, from: "hub", to: BROADCAST, type, content, replyTo });
  deliver(msg);
  return msg;
}

/** Ghi bước cho participant. Trả về true nếu bước đổi. */
function recordStep(room: string, name: string, step: Step | null): boolean {
  if (!step || !STEPS.includes(step)) return false;
  return store.setStep(room, name, step);
}

// ---------- trạng thái kết nối ----------

type Conn =
  | { ws: WebSocket; alive: boolean; kind: "viewer"; room: string }
  | { ws: WebSocket; alive: boolean; kind: ParticipantKind; room: string; name: string }
  | { ws: WebSocket; alive: boolean; kind: null };

/** room -> name -> socket của participant đang online */
const online = new Map<string, Map<string, Conn>>();
/** room -> các socket viewer (web UI) */
const viewers = new Map<string, Set<Conn>>();

function roomOnline(room: string) {
  let m = online.get(room);
  if (!m) online.set(room, (m = new Map()));
  return m;
}
function roomViewers(room: string) {
  let s = viewers.get(room);
  if (!s) viewers.set(room, (s = new Set()));
  return s;
}

function send(conn: Conn, op: ServerOp) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(op));
}

// ---------- trạng thái runtime (không lưu DB) ----------

interface Runtime {
  waiting: boolean;
  lastWaitAt: number;
  /** Lần gần nhất Stop hook chặn agent kết thúc lượt */
  lastBlockAt: number;
  attention: string | null;
}
const runtimes = new Map<string, Runtime>();
function rt(room: string, name: string): Runtime {
  const k = `${room}/${name}`;
  let r = runtimes.get(k);
  if (!r) runtimes.set(k, (r = { waiting: false, lastWaitAt: 0, lastBlockAt: 0, attention: null }));
  return r;
}
function setAttention(room: string, name: string, text: string | null) {
  const r = rt(room, name);
  if (r.attention === text) return;
  r.attention = text;
  broadcastParticipants(room);
}

function toParticipant(room: string, p: ParticipantRow): Participant {
  const r = rt(room, p.name);
  return {
    waiting: r.waiting,
    attention: r.attention,
    name: p.name,
    role: p.role,
    kind: p.kind,
    status: p.status,
    lastSeen: p.lastSeen,
    // "user" online khi có ít nhất một tab web đang mở phòng
    online: roomOnline(room).has(p.name) || (p.name === HUMAN_NAME && roomViewers(room).size > 0),
  };
}

function participantsOf(room: string): Participant[] {
  return store.listParticipants(room).map((p) => toParticipant(room, p));
}

function broadcastParticipants(room: string) {
  const op: ServerOp = { op: "participants", room, participants: participantsOf(room) };
  for (const c of roomOnline(room).values()) send(c, op);
  for (const c of roomViewers(room)) send(c, op);
}

function deliver(msg: ChatMessage) {
  const op: ServerOp = { op: "message", message: msg };
  for (const [name, c] of roomOnline(msg.room)) {
    // Người gửi cũng nhận lại tin của mình để đồng bộ (bridge tự lọc)
    if (name === msg.from || isAddressedTo(msg, name)) send(c, op);
  }
  for (const c of roomViewers(msg.room)) send(c, op);
}

function systemMessage(room: string, content: string) {
  deliver(store.addMessage({ room, from: "hub", to: BROADCAST, type: "system", content, replyTo: null }));
}

// ---------- xử lý op từ client ----------

function handle(conn: Conn, op: ClientOp) {
  const reqId = "reqId" in op ? op.reqId : undefined;
  const reply = (data: unknown) => reqId && send(conn, { op: "result", reqId, data });
  const fail = (error: string) => send(conn, { op: "error", reqId, error });

  if (op.op === "hello") {
    if (conn.kind !== null) return fail("Đã hello rồi");
    const room = op.room?.trim();
    if (!room || !NAME_RE.test(room)) return fail(`Tên phòng không hợp lệ: ${op.room}`);
    store.ensureRoom(room);

    if (op.kind === "viewer") {
      Object.assign(conn, { kind: "viewer", room });
      roomViewers(room).add(conn);
      send(conn, { op: "welcome", reqId, room, self: null, unread: [], onDuty: store.isOnDuty(room), closed: !!store.closedAt(room) });
      send(conn, { op: "board", room, board: boardOf(room) });
      broadcastParticipants(room); // "user" chuyển sang online
      return;
    }

    const name = op.name?.trim();
    if (!name || !NAME_RE.test(name) || name === "hub" || name === BROADCAST)
      return fail(`Tên participant không hợp lệ: ${op.name}`);

    // Session restart với cùng tên: thay kết nối cũ
    const existing = roomOnline(room).get(name);
    if (existing) {
      send(existing, { op: "kicked", reason: "Có kết nối mới cùng tên đã thay thế kết nối này" });
      roomOnline(room).delete(name);
      existing.ws.close();
    }

    const row = store.upsertParticipant(room, name, op.role ?? "", op.kind);
    Object.assign(conn, { kind: op.kind, room, name });
    roomOnline(room).set(name, conn);
    const unread = store.unreadFor(room, name, row.lastReadId);
    Object.assign(rt(room, name), { waiting: false, attention: null, lastBlockAt: 0 });
    send(conn, { op: "welcome", reqId, room, self: toParticipant(room, row), unread, onDuty: store.isOnDuty(room), closed: !!store.closedAt(room) });
    broadcastParticipants(room);
    if (!existing) systemMessage(room, `${name} (${op.role || op.kind}) đã tham gia phòng`);
    return;
  }

  if (conn.kind === null) return fail("Cần gửi hello trước");

  if (op.op === "history") {
    return reply(store.history(conn.room, op));
  }
  if (op.op === "participants") {
    return reply(participantsOf(conn.room));
  }
  if (op.op === "board") {
    return reply(boardOf(conn.room));
  }
  if (op.op === "summary") {
    return reply(roomSummary(conn.room, conn.kind === "viewer" ? HUMAN_NAME : conn.name));
  }

  // Web (viewer) chỉ được gửi tin, dưới tên "user"
  if (conn.kind === "viewer" && op.op !== "send" && op.op !== "duty" && op.op !== "bug_update")
    return fail("Viewer chỉ được xem, gửi tin, bật/tắt trực và phân xử bug");
  const room = conn.room;
  const name = conn.kind === "viewer" ? HUMAN_NAME : conn.name;
  store.touch(room, name);
  if (conn.kind !== "viewer" && op.op !== "waiting" && rt(room, name).attention) setAttention(room, name, null);

  switch (op.op) {
    case "send": {
      const content = op.content?.trim();
      if (!content) return fail("Nội dung rỗng");
      const to = (op.to ?? BROADCAST).trim();
      if (to === name) return fail("Không thể gửi tin cho chính mình");
      if (to !== BROADCAST && !store.getParticipant(room, to)) {
        const names = store.listParticipants(room).map((p) => p.name);
        return fail(`Không có participant "${to}" trong phòng. Có: ${[BROADCAST, ...names].join(", ")}`);
      }
      const type = op.type ?? "chat";
      if (!MESSAGE_TYPES.includes(type) || type === "system") return fail(`type không hợp lệ: ${type}`);
      if (type === "report") return fail("Báo cáo B7 gửi bằng tool submit_report (để được lưu làm báo cáo của ticket)");
      const replyTo = op.replyTo ?? null;
      if (replyTo !== null && !store.getMessage(room, replyTo)) return fail(`Không có tin nhắn #${replyTo}`);
      const msg = store.addMessage({ room, from: name, to, type, content, replyTo });
      deliver(msg);
      afterMessage(room, name, conn.kind === "viewer", conn.kind !== "viewer" && recordStep(room, name, parseStep(content)));
      return reply(msg);
    }
    case "status": {
      const text = op.text?.trim() || null;
      store.setStatus(room, name, text);
      broadcastParticipants(room);
      if (recordStep(room, name, op.step ?? parseStep(text))) {
        progress(room);
        broadcastBoard(room);
      }
      return reply(true);
    }
    case "ack": {
      store.ack(room, name, op.upToId);
      return;
    }
    case "waiting": {
      const r = rt(room, name);
      r.waiting = !!op.waiting;
      if (r.waiting) {
        r.lastWaitAt = Date.now();
        r.attention = null; // đã quay lại trực → không còn kẹt ở terminal
      }
      broadcastParticipants(room);
      return;
    }
    case "bug_create": {
      return reply(createBug(room, name, op));
    }
    case "bug_update": {
      return reply(updateBug(room, name, conn.kind === "viewer", op));
    }
    case "report": {
      if (conn.kind === "viewer") return fail("User sửa báo cáo trên web (nút 🏁)");
      return reply(submitReport(room, name, op.content, op.attachments));
    }
    case "upload": {
      return reply(saveAttachment(room, op.filename, op.data));
    }
    case "duty": {
      if (conn.kind !== "viewer") return fail("Chỉ user (web) được bật/tắt chế độ trực");
      setDuty(room, !!op.onDuty);
      return reply(true);
    }
    default:
      return fail(`op không hỗ trợ: ${(op as { op: string }).op}`);
  }
}

function onClose(conn: Conn) {
  if (conn.kind === null) return;
  if (conn.kind === "viewer") {
    roomViewers(conn.room).delete(conn);
    if (roomViewers(conn.room).size === 0) broadcastParticipants(conn.room);
    return;
  }
  const map = roomOnline(conn.room);
  // Chỉ xoá nếu socket này vẫn là socket hiện hành (không bị thay thế)
  if (map.get(conn.name) === conn) {
    map.delete(conn.name);
    Object.assign(rt(conn.room, conn.name), { waiting: false, attention: null });
    store.touch(conn.room, conn.name);
    broadcastParticipants(conn.room);
    systemMessage(conn.room, `${conn.name} đã offline`);
  }
}

function setDuty(room: string, onDuty: boolean) {
  if (store.isOnDuty(room) === onDuty) return;
  store.setOnDuty(room, onDuty);
  broadcastRoom(room);
  systemMessage(
    room,
    onDuty
      ? "user đã BẬT chế độ trực: agent sẽ ở lại chờ việc sau mỗi lượt"
      : "user đã TẮT chế độ trực: agent sẽ kết thúc lượt khi xong việc hiện tại",
  );
}

/** Lưu thông tin kickoff của phòng; send=true thì gửi tin kickoff tới @all dưới tên user */
function kickoff(room: string, meta: KickoffMeta, sendNow: boolean): ChatMessage | null {
  if (!meta?.ticket?.trim()) throw new OpError("Thiếu mã ticket");
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === "string" && v.trim()) clean[k] = v.trim();
  store.setMeta(room, clean);
  if (!sendNow) return null;
  if (store.closedAt(room)) reopenRoom(room, "user gửi kickoff: ticket được mở lại");
  if (!store.isOnDuty(room)) setDuty(room, true);
  const msg = store.addMessage({
    room,
    from: HUMAN_NAME,
    to: BROADCAST,
    type: "handoff",
    content: buildKickoff(clean as unknown as KickoffMeta),
    replyTo: null,
  });
  deliver(msg);
  if (progress(room)) broadcastBoard(room);
  return msg;
}

/** Sau mỗi tin: tin của user hoặc có đổi bước = tiến triển; tin agent khác = đếm vòng lặp */
function afterMessage(room: string, from: string, isUser: boolean, stepChanged: boolean) {
  const changed = isUser || stepChanged ? progress(room) || stepChanged : chatter(room);
  if (changed) broadcastBoard(room);
}

function images(urls: string[] | undefined): string {
  const list = (urls ?? []).filter((u) => typeof u === "string" && u.startsWith("/att/"));
  return list.length ? `\n\n${list.map((u, i) => `![ảnh ${i + 1}](${u})`).join("\n")}` : "";
}

function createBug(
  room: string,
  name: string,
  op: { title: string; severity?: BugSeverity; tc?: string | null; detail: string; to?: string; attachments?: string[] },
): { bug: Bug; message: ChatMessage } {
  const title = op.title?.trim();
  const detail = op.detail?.trim();
  if (!title) throw new OpError("Thiếu tiêu đề bug");
  if (!detail) throw new OpError("Thiếu chi tiết bug (bước tái hiện, expected, actual)");
  const severity = op.severity ?? "med";
  if (!BUG_SEVERITIES.includes(severity)) throw new OpError(`severity không hợp lệ: ${severity} (${BUG_SEVERITIES.join("|")})`);
  const others = store.listParticipants(room).filter((p) => p.name !== name && p.kind === "agent");
  const to = op.to?.trim() || others.find((p) => /^dev/i.test(p.role) || p.name === "dev")?.name || BROADCAST;
  if (to === name) throw new OpError("Không gửi bug cho chính mình");
  if (to !== BROADCAST && !store.getParticipant(room, to)) throw new OpError(`Không có participant "${to}"`);
  const tc = op.tc?.trim() || null;
  const code = store.nextBugCode(room);
  const content = `🐞 **${code}** · ${severity}${tc ? ` · ${tc}` : ""}: **${title}**\n\n${detail}${images(op.attachments)}`;
  const message = store.addMessage({ room, from: name, to, type: "bug_report", content, replyTo: null });
  const bug = store.addBug({ room, code, title, severity, tc, reporter: name, assignee: to, msgId: message.id });
  deliver(message);
  progress(room);
  broadcastBoard(room);
  return { bug, message };
}

function updateBug(
  room: string,
  name: string,
  isUser: boolean,
  op: { code: string; status: BugStatus; note?: string | null; attachments?: string[] },
): { bug: Bug; message: ChatMessage; escalated: boolean } {
  const code = store.findBugCode(room, op.code ?? "");
  if (!code) throw new OpError(`Không có bug "${op.code}". Có: ${store.listBugs(room).map((b) => b.code).join(", ") || "(chưa có)"}`);
  const bug = store.getBug(room, code)!;
  let to: BugStatus = op.status;
  if (!BUG_STATUSES.includes(to)) throw new OpError(`status không hợp lệ: ${to} (${BUG_STATUSES.join("|")})`);
  const note = op.note?.trim() || null;
  const rounds = { ...bug.rounds };
  let escalated = false;

  if (!isUser) {
    if (bug.status === "need_user")
      throw new OpError(`${code} đang chờ user phân xử trên web. Đừng tranh luận tiếp, làm việc khác và chờ kết luận của user.`);
    if (to === bug.status) throw new OpError(`${code} đã ở trạng thái ${to}`);
    const allowed = BUG_TRANSITIONS[bug.status];
    if (!allowed.includes(to))
      throw new OpError(`${code}: không thể chuyển ${bug.status} → ${to}. Được phép: ${allowed.join(", ") || "(không)"}`);
    if ((to === "disputed" || to === "open") && !note)
      throw new OpError("Phản biện / giữ quan điểm phải kèm note, trích AC cụ thể");
    // Một lượt tranh luận: DEV phản biện (→ disputed) hoặc QA giữ quan điểm (disputed → open)
    if (to === "disputed" || (bug.status === "disputed" && to === "open")) {
      rounds[name] = (rounds[name] ?? 0) + 1;
      if (rounds[name] > MAX_DISPUTE_ROUNDS) {
        rounds[name] = MAX_DISPUTE_ROUNDS;
        to = "need_user";
        escalated = true;
      }
    }
  }

  const label = (s: BugStatus) => BUG_STATUS_LABEL[s];
  const peer = name === bug.reporter ? bug.assignee : bug.reporter;
  const target = isUser || to === "need_user" ? BROADCAST : peer === name ? BROADCAST : peer;
  const head = isUser
    ? `⚖️ **${code}**: user phân xử → **${label(to)}**`
    : `🐞 **${code}**: ${label(bug.status)} → **${label(to)}**`;
  const type: MessageType = to === "fixed" ? "handoff" : to === "reopened" ? "bug_report" : to === "need_user" ? "question" : "chat";
  const message = store.addMessage({
    room,
    from: isUser ? HUMAN_NAME : name,
    to: target,
    type,
    content: `${head}${note ? `\n\n${note}` : ""}${images(op.attachments)}`,
    replyTo: bug.msgId,
  });
  deliver(message);
  store.updateBug(room, code, to, rounds);
  store.addBugEvent(room, code, { actor: isUser ? HUMAN_NAME : name, from: bug.status, to, note, msgId: message.id });
  if (escalated) {
    hubMessage(
      room,
      `⚖️ **${code}** đã hết ${MAX_DISPUTE_ROUNDS} lượt tranh luận mỗi bên → chuyển **chờ user phân xử**. ` +
        "DEV và QA dừng tranh luận bug này, làm tiếp việc khác. User sẽ quyết trên web, kết luận của user là cuối cùng.",
      "question",
      bug.msgId,
    );
  }
  progress(room);
  broadcastBoard(room);
  return { bug: store.getBug(room, code)!, message, escalated };
}

function saveAttachment(room: string, filename: string, data: string): { url: string } {
  const ext = extname(filename ?? "").toLowerCase();
  if (!(ATTACHMENT_EXT as readonly string[]).includes(ext)) throw new OpError(`Chỉ nhận ảnh: ${ATTACHMENT_EXT.join(", ")}`);
  const buf = Buffer.from(data ?? "", "base64");
  if (!buf.length) throw new OpError("File rỗng");
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new OpError(`Ảnh quá lớn (> ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`);
  const dir = join(ATT_DIR, room);
  mkdirSync(dir, { recursive: true });
  const base = (filename.slice(0, -ext.length).split(/[\\/]/).pop() ?? "img").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40);
  const file = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}-${base}${ext}`;
  writeFileSync(join(dir, file), buf);
  return { url: `/att/${encodeURIComponent(room)}/${file}` };
}

// ---------- Phase 5: báo cáo B7, đóng / mở lại ticket, tóm tắt phòng ----------

/** Agent gửi báo cáo chung (B7): lưu phiên bản mới + tin "report" cho user */
function submitReport(room: string, name: string, content: string, attachments?: string[]) {
  const body = content?.trim();
  if (!body) throw new OpError("Báo cáo rỗng");
  const message = store.addMessage({ room, from: name, to: HUMAN_NAME, type: "report", content: `${body}${images(attachments)}`, replyTo: null });
  const report = store.addReport(room, name, message.content, message.id);
  deliver(message);
  recordStep(room, name, "B7");
  progress(room);
  broadcastBoard(room);
  return { report, message, version: store.countReports(room) };
}

/** User sửa báo cáo trên web: lưu phiên bản mới, không gửi tin cho agent */
function editReport(room: string, content: string) {
  const body = content?.trim();
  if (!body) throw new OpError("Báo cáo rỗng");
  if (store.latestReport(room)?.content === body) return store.latestReport(room)!;
  const report = store.addReport(room, HUMAN_NAME, body, null);
  systemMessage(room, `user đã sửa báo cáo B7 (phiên bản ${store.countReports(room)})`);
  broadcastBoard(room);
  return report;
}

function closeRoom(room: string, report?: string) {
  if (report?.trim()) editReport(room, report);
  if (!store.closedAt(room)) {
    store.setClosed(room, true);
    hubMessage(
      room,
      "🏁 **User đã đóng ticket.** Dừng mọi việc, không gửi thêm tin, không gọi wait_for_messages nữa: kết thúc lượt. " +
        "Ticket được mở lại (tcm resume) thì bạn sẽ được gọi vào bằng session mới.",
    );
  }
  setDuty(room, false);
  broadcastRoom(room);
  broadcastBoard(room);
}

function reopenRoom(room: string, note = "user đã mở lại ticket") {
  if (store.closedAt(room)) {
    store.setClosed(room, false);
    systemMessage(room, note);
  }
  setDuty(room, true);
  broadcastRoom(room);
  broadcastBoard(room);
}

const clip = (s: string, n: number) => {
  const t = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "🖼").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const hhmm = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Tóm tắt phòng (markdown) cho người vào lại: thông tin ticket, tiến độ, bug, việc của mình, việc chờ user, tin gần đây */
function roomSummary(room: string, forName: string | null): string {
  const meta = (store.getMeta(room) ?? {}) as Partial<KickoffMeta>;
  const board = boardOf(room);
  const people = participantsOf(room);
  const ticket = meta.ticket ?? room;
  const info = store.listRooms().find((r) => r.name === room);
  const out: string[] = [
    `# Tóm tắt phòng "${room}" · ticket ${ticket}`,
    `_${board.closedAt ? `ĐÃ ĐÓNG lúc ${hhmm(board.closedAt)}` : "Đang mở"} · trực: ${store.isOnDuty(room) ? "bật" : "tắt"} · ` +
      `${info?.messageCount ?? 0} tin${info?.lastMessageAt ? ` · tin cuối ${hhmm(info.lastMessageAt)}` : ""}_`,
  ];

  const t = meta.ticket ?? room;
  const file = (dir: string | undefined, def: string) => `\`${(dir || def).replace(/\/$/, "")}/${t}.md\``;
  out.push(
    "",
    "## Thông tin ticket",
    ...(meta.figma ? [`- Figma: ${meta.figma}`] : []),
    ...(meta.testAccount ? [`- Tài khoản test: ${meta.testAccount}`] : []),
    ...(meta.appRun || meta.appUrl ? [`- App: ${[meta.appRun && `\`${meta.appRun}\``, meta.appUrl].filter(Boolean).join(" → ")}`] : []),
    `- File: plan ${file(meta.planDir, "docs/plan")} · test case ${file(meta.testcaseDir, "qa/testcases")} · kết quả test ${file(meta.runsDir, "qa/runs")}`,
    ...(meta.notes ? [`- Ghi chú: ${meta.notes}`] : []),
  );

  const steps = stepSummary(board.steps);
  out.push("", "## Thành viên");
  for (const p of people.filter((x) => x.kind === "agent")) {
    const st = steps.get(p.name);
    out.push(
      `- **${p.name}** [${p.role || p.kind}] ${p.online ? "online" : "offline"}` +
        `${st ? ` · đang ở ${st.current} (${STEP_LABEL[st.current]})` : ""}${p.status ? ` · trạng thái cuối: "${p.status}"` : ""}` +
        ` · hoạt động lần cuối ${hhmm(p.lastSeen)}`,
    );
  }

  out.push("", boardMarkdown(board).replace(/^## Tiến độ[\s\S]*?(?=## Bug)/, "").trim());

  const me = forName && people.find((p) => p.name === forName && p.kind === "agent");
  if (me) {
    const mine: string[] = [];
    for (const b of board.bugs) {
      const tag = `${b.code} (${b.severity}, ${BUG_STATUS_LABEL[b.status]}): ${b.title}`;
      if (b.assignee === me.name && ["open", "reopened"].includes(b.status)) mine.push(`- ${tag} → fix rồi update_bug fixed, hoặc phản biện (disputed, trích AC)`);
      if (b.reporter === me.name && b.status === "fixed") mine.push(`- ${tag} → retest: verified hoặc reopened`);
      if (b.reporter === me.name && b.status === "disputed") mine.push(`- ${tag} → trả lời phản biện: rejected (đồng ý) hoặc open (giữ quan điểm, trích AC)`);
      if (b.status === "need_user") mine.push(`- ${tag} → đang chờ user phân xử, đừng tranh luận tiếp`);
    }
    const row = store.getParticipant(room, me.name);
    const unread = row ? store.unreadFor(room, me.name, row.lastReadId).length : 0;
    if (unread) mine.push(`- ${unread} tin chưa đọc gửi cho bạn: sẽ được đính kèm vào kết quả tool hub tiếp theo (hoặc gọi check_inbox).`);
    if (!board.report && !board.closedAt) mine.push("- Chưa có báo cáo B7 (QA gửi bằng submit_report khi xong).");
    out.push("", `## Việc của bạn (${me.name})`, ...(mine.length ? mine : ["- Không có việc tồn đọng trên bảng. Đọc tin gần đây để biết đang dở việc gì."]));
  }

  // Câu hỏi agent gửi user sau tin cuối cùng của user = chưa được trả lời
  const recent = store.history(room, { limit: 200 }).filter((m) => m.type !== "system");
  const lastUser = Math.max(0, ...recent.filter((m) => m.from === HUMAN_NAME).map((m) => m.id));
  const asks = recent.filter((m) => m.id > lastUser && m.from !== HUMAN_NAME && m.type === "question" && (m.to === HUMAN_NAME || m.to === BROADCAST));
  const needUser = board.bugs.filter((b) => b.status === "need_user");
  if (asks.length || needUser.length) {
    out.push(
      "",
      "## Đang chờ user",
      ...needUser.map((b) => `- ${b.code} chờ phân xử: ${b.title}`),
      ...asks.map((m) => `- #${m.id} ${m.from} hỏi: ${clip(m.content, 200)}`),
    );
  }

  out.push(
    "",
    "## Báo cáo B7",
    board.report ? `- Phiên bản ${board.reportVersions}, ${board.report.author} lúc ${hhmm(board.report.createdAt)}` : "- Chưa có.",
  );

  const last = recent.slice(-15);
  if (last.length) {
    out.push("", `## ${last.length} tin gần nhất (đọc đầy đủ bằng get_history)`);
    for (const m of last) out.push(`- #${m.id} ${hhmm(m.createdAt)} ${m.from} → ${m.to} [${m.type}]: ${clip(m.content, 220)}`);
  }
  return out.join("\n");
}

function broadcastRoom(room: string) {
  const op: ServerOp = { op: "room", room, onDuty: store.isOnDuty(room), closed: !!store.closedAt(room) };
  for (const c of roomOnline(room).values()) send(c, op);
  for (const c of roomViewers(room)) send(c, op);
}

// ---------- Claude Code hooks (scripts/hook.mjs) ----------

/** Agent kết thúc lượt liên tiếp trong khoảng này mà không quay lại chờ → thả, tránh vòng lặp đốt token */
const STOP_LOOP_WINDOW_MS = 60_000;

function handleHook(h: HookRequest): HookResponse {
  const { room, name } = h;
  if (!room || !name || !store.getParticipant(room, name)) return {};
  const r = rt(room, name);

  if (h.event === "clear") {
    if (r.attention) setAttention(room, name, null);
    return {};
  }

  if (h.event === "notify") {
    const t = h.input?.notification_type;
    if (t === "permission_prompt") setAttention(room, name, "⚠️ Đang chờ bạn duyệt quyền trong terminal");
    else if (t === "idle_prompt") setAttention(room, name, "💤 Đang rảnh ở terminal (không trực)");
    else if (t === "elicitation_dialog" || t === "agent_needs_input")
      setAttention(room, name, "⚠️ Đang chờ bạn trả lời trong terminal");
    return {};
  }

  // event === "stop"
  if (r.attention) setAttention(room, name, null);
  if (!store.isOnDuty(room)) return {};
  if (!roomOnline(room).has(name)) return {}; // bridge không kết nối → đừng giữ agent lại
  const now = Date.now();
  if (r.lastBlockAt && now - r.lastBlockAt < STOP_LOOP_WINDOW_MS && r.lastWaitAt < r.lastBlockAt) {
    // Vừa bị chặn mà không chịu gọi wait_for_messages → thả ra
    r.lastBlockAt = 0;
    setAttention(room, name, "💤 Đã rời chế độ trực. Gõ vào terminal để gọi lại");
    systemMessage(room, `${name} đã rời chế độ trực (kết thúc lượt liên tục)`);
    return {};
  }
  r.lastBlockAt = now;
  return {
    block: true,
    reason:
      `[team-hub] Phòng "${room}" đang ở CHẾ ĐỘ TRỰC: đừng kết thúc lượt. ` +
      "Gọi tool wait_for_messages để chờ tin tiếp theo (hết timeout thì gọi lại). " +
      "Nếu cần hỏi user điều gì, gửi send_message tới \"user\" rồi wait_for_messages để chờ trả lời. " +
      "Chỉ dừng khi user tắt chế độ trực trên web.",
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---------- HTTP: REST + web tĩnh ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Hub đang chạy. Web UI chưa build: chạy `npm run build` (hoặc `npm run dev:web` để dev).");
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(WEB_DIST, safe);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(WEB_DIST, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;

  if (p === "/api/health") return json(res, 200, { ok: true });
  if (p === "/api/hook" && req.method === "POST") {
    readJson(req)
      .then((body) => json(res, 200, handleHook(body as HookRequest)))
      .catch((e) => json(res, 400, { error: String(e) }));
    return;
  }
  if (p === "/api/rooms") return json(res, 200, store.listRooms());

  const at = p.match(/^\/att\/([^/]+)\/([^/]+)$/);
  if (at) {
    const room = decodeURIComponent(at[1]);
    const file = decodeURIComponent(at[2]);
    const full = join(ATT_DIR, room, file);
    if (!NAME_RE.test(room) || !/^[a-zA-Z0-9_.-]+$/.test(file) || !existsSync(full)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "max-age=86400" });
    res.end(readFileSync(full));
    return;
  }
  const b = p.match(/^\/api\/rooms\/([^/]+)\/board$/);
  if (b) {
    const room = decodeURIComponent(b[1]);
    if (!NAME_RE.test(room)) return json(res, 400, { error: `Tên phòng không hợp lệ: ${room}` });
    return json(res, 200, boardOf(room));
  }

  const t = p.match(/^\/api\/rooms\/([^/]+)\/(summary|report\.md|report|close|reopen)$/);
  if (t) {
    const room = decodeURIComponent(t[1]);
    if (!NAME_RE.test(room) || !store.roomExists(room)) return json(res, 404, { error: `Không có phòng "${room}"` });
    if (t[2] === "summary") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return void res.end(roomSummary(room, url.searchParams.get("for")));
    }
    if (t[2] === "report.md") {
      const r = store.latestReport(room);
      if (!r) return json(res, 404, { error: "Chưa có báo cáo" });
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${(String(store.getMeta(room)?.ticket ?? room)).replace(/[^\w.-]/g, "_")}-report.md"`,
      });
      return void res.end(r.content);
    }
    if (t[2] === "report" && req.method === "GET") return json(res, 200, store.latestReport(room));
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    readJson(req)
      .then((body) => {
        const b = body as { content?: string; report?: string };
        if (t[2] === "report") return json(res, 200, editReport(room, b.content ?? ""));
        if (t[2] === "close") {
          closeRoom(room, b.report);
          return json(res, 200, boardOf(room));
        }
        reopenRoom(room);
        return json(res, 200, boardOf(room));
      })
      .catch((e) => {
        if (!(e instanceof OpError) && !(e instanceof SyntaxError)) console.error("[hub]", p, e);
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      });
    return;
  }

  const k = p.match(/^\/api\/rooms\/([^/]+)\/(meta|kickoff|duty)$/);
  if (k) {
    const room = decodeURIComponent(k[1]);
    if (!NAME_RE.test(room)) return json(res, 400, { error: `Tên phòng không hợp lệ: ${room}` });
    if (k[2] === "meta" && req.method === "GET") return json(res, 200, store.getMeta(room) ?? {});
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    readJson(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        if (k[2] === "duty") {
          store.ensureRoom(room);
          setDuty(room, !!b.onDuty);
          return json(res, 200, { onDuty: store.isOnDuty(room) });
        }
        const msg = kickoff(room, (b.meta ?? b) as KickoffMeta, k[2] === "kickoff" && b.send !== false);
        return json(res, 200, { ok: true, message: msg });
      })
      .catch((e) => json(res, 400, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }

  const m = p.match(/^\/api\/rooms\/([^/]+)\/(messages|participants)$/);
  if (m) {
    const room = decodeURIComponent(m[1]);
    if (m[2] === "participants") return json(res, 200, participantsOf(room));
    const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
    return json(res, 200, store.history(room, { limit: num("limit"), beforeId: num("beforeId"), sinceId: num("sinceId") }));
  }
  if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });

  serveStatic(req, res, p);
});

const wss = new WebSocketServer({ server, path: "/ws" });
const conns = new Set<Conn>();

wss.on("connection", (ws) => {
  const conn: Conn = { ws, alive: true, kind: null };
  conns.add(conn);
  ws.on("pong", () => (conn.alive = true));
  ws.on("message", (raw) => {
    let op: ClientOp;
    try {
      op = JSON.parse(raw.toString());
    } catch {
      return send(conn, { op: "error", error: "JSON không hợp lệ" });
    }
    try {
      handle(conn, op);
    } catch (e) {
      if (!(e instanceof OpError)) console.error("[hub] lỗi xử lý op", op.op, e);
      send(conn, { op: "error", reqId: "reqId" in op ? op.reqId : undefined, error: e instanceof Error ? e.message : String(e) });
    }
  });
  ws.on("close", () => {
    conns.delete(conn);
    onClose(conn);
  });
  ws.on("error", (e) => console.error("[hub] ws error", e.message));
});

// Heartbeat: dọn kết nối chết (vd. session Claude bị kill mà không đóng socket)
const heartbeat = setInterval(() => {
  for (const conn of conns) {
    if (!conn.alive) {
      conn.ws.terminate();
      continue;
    }
    conn.alive = false;
    conn.ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[hub] port ${PORT} đang được dùng: có thể hub đã chạy sẵn (http://${HOST}:${PORT}).`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`[hub] http://${HOST}:${PORT}  (ws: ws://${HOST}:${PORT}/ws)`);
  console.log(`[hub] db: ${DB_FILE}`);
});
