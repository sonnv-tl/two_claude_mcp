import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  BROADCAST,
  DEFAULT_HUB_PORT,
  MESSAGE_TYPES,
  isAddressedTo,
  type ChatMessage,
  type ClientOp,
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

const store = new Store(DB_FILE);

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

function toParticipant(room: string, p: ParticipantRow): Participant {
  return {
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
      send(conn, { op: "welcome", reqId, room, self: null, unread: [] });
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
    send(conn, { op: "welcome", reqId, room, self: toParticipant(room, row), unread });
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

  // Web (viewer) chỉ được gửi tin, dưới tên "user"
  if (conn.kind === "viewer" && op.op !== "send") return fail("Viewer chỉ được xem và gửi tin");
  const room = conn.room;
  const name = conn.kind === "viewer" ? HUMAN_NAME : conn.name;
  store.touch(room, name);

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
      const replyTo = op.replyTo ?? null;
      if (replyTo !== null && !store.getMessage(room, replyTo)) return fail(`Không có tin nhắn #${replyTo}`);
      const msg = store.addMessage({ room, from: name, to, type, content, replyTo });
      deliver(msg);
      return reply(msg);
    }
    case "status": {
      store.setStatus(room, name, op.text?.trim() || null);
      broadcastParticipants(room);
      return reply(true);
    }
    case "ack": {
      store.ack(room, name, op.upToId);
      return;
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
    store.touch(conn.room, conn.name);
    broadcastParticipants(conn.room);
    systemMessage(conn.room, `${conn.name} đã offline`);
  }
}

// ---------- HTTP: REST + web tĩnh ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
  if (p === "/api/rooms") return json(res, 200, store.listRooms());

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
      console.error("[hub] lỗi xử lý op", op, e);
      send(conn, { op: "error", reqId: "reqId" in op ? op.reqId : undefined, error: String(e) });
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

server.listen(PORT, HOST, () => {
  console.log(`[hub] http://${HOST}:${PORT}  (ws: ws://${HOST}:${PORT}/ws)`);
  console.log(`[hub] db: ${DB_FILE}`);
});
