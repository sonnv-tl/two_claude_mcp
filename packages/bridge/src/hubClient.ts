import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  Board,
  Bug,
  BugSeverity,
  BugStatus,
  ChatMessage,
  ClientOp,
  Participant,
  ParticipantKind,
  ServerOp,
  Step,
} from "@tcm/shared";

export interface HubClientOptions {
  url: string;
  room: string;
  name: string;
  role: string;
  kind: ParticipantKind;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Kết nối WebSocket tới hub, tự reconnect.
 * Events: "message" (ChatMessage), "welcome" (unread: ChatMessage[]), "participants" (Participant[]),
 *         "connected", "disconnected".
 */
export class HubClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private retryMs = 500;
  private closed = false;
  connected = false;
  lastError: string | null = null;
  participants: Participant[] = [];
  /** Phòng đang bật chế độ trực (user có thể tắt trên web) */
  onDuty = true;

  constructor(readonly opts: HubClientOptions) {
    super();
  }

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.retryMs = 500;
      this.raw({ op: "hello", kind: this.opts.kind, room: this.opts.room, name: this.opts.name, role: this.opts.role });
    });

    ws.on("message", (data) => {
      let op: ServerOp;
      try {
        op = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onOp(op);
    });

    ws.on("close", () => {
      const was = this.connected;
      this.connected = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Mất kết nối tới hub"));
        this.pending.delete(id);
      }
      if (was) this.emit("disconnected");
      if (!this.closed) {
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    });

    ws.on("error", (e) => {
      this.lastError = e.message;
      log(`ws error: ${e.message}`);
    });
  }

  private onOp(op: ServerOp) {
    switch (op.op) {
      case "welcome":
        this.connected = true;
        this.lastError = null;
        log(`đã kết nối hub, phòng "${op.room}" với tên "${this.opts.name}" (${op.unread.length} tin chưa đọc)`);
        this.emit("connected");
        this.onDuty = op.onDuty ?? true;
        this.emit("welcome", op.unread);
        this.emit("room", this.onDuty);
        break;
      case "message":
        this.emit("message", op.message);
        break;
      case "room":
        this.onDuty = op.onDuty;
        this.emit("room", op.onDuty);
        break;
      case "participants":
        this.participants = op.participants;
        this.emit("participants", op.participants);
        break;
      case "result": {
        const p = this.pending.get(op.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(op.reqId);
          p.resolve(op.data);
        }
        break;
      }
      case "error": {
        const p = op.reqId ? this.pending.get(op.reqId) : undefined;
        if (p && op.reqId) {
          clearTimeout(p.timer);
          this.pending.delete(op.reqId);
          p.reject(new Error(op.error));
        } else {
          this.lastError = op.error;
          log(`hub error: ${op.error}`);
        }
        break;
      }
      case "kicked":
        log(`bị hub ngắt: ${op.reason}`);
        this.lastError = op.reason;
        // Có session khác cùng tên thay thế — không tự reconnect để tránh giành qua giành lại
        this.closed = true;
        break;
    }
  }

  private raw(op: ClientOp) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(op));
  }

  /** Gửi op có reqId và chờ result/error */
  request<T>(op: ClientOp & { reqId?: string }, timeoutMs = 10_000): Promise<T> {
    if (!this.connected) {
      return Promise.reject(
        new Error(
          `Chưa kết nối được hub (${this.opts.url})${this.lastError ? `: ${this.lastError}` : ""}. ` +
            "Hãy chắc chắn hub đang chạy (`npm run hub` trong repo two_claude_mcp).",
        ),
      );
    }
    const reqId = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("Hub không phản hồi (timeout)"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.raw({ ...op, reqId } as ClientOp);
    });
  }

  setWaiting(waiting: boolean) {
    this.raw({ op: "waiting", waiting });
  }

  ack(upToId: number) {
    this.raw({ op: "ack", upToId });
  }

  sendMessage(m: { to: string; content: string; type?: ChatMessage["type"]; replyTo?: number | null }) {
    return this.request<ChatMessage>({ op: "send", ...m });
  }
  history(opts: { limit?: number; beforeId?: number; sinceId?: number }) {
    return this.request<ChatMessage[]>({ op: "history", ...opts });
  }
  listParticipants() {
    return this.request<Participant[]>({ op: "participants" });
  }
  setStatus(text: string | null, step?: Step | null) {
    return this.request<boolean>({ op: "status", text, step });
  }
  board() {
    return this.request<Board>({ op: "board" });
  }
  createBug(b: { title: string; severity?: BugSeverity; tc?: string | null; detail: string; to?: string; attachments?: string[] }) {
    return this.request<{ bug: Bug; message: ChatMessage }>({ op: "bug_create", ...b });
  }
  updateBug(u: { code: string; status: BugStatus; note?: string | null; attachments?: string[] }) {
    return this.request<{ bug: Bug; message: ChatMessage; escalated: boolean }>({ op: "bug_update", ...u });
  }
  upload(filename: string, data: Buffer) {
    return this.request<{ url: string }>({ op: "upload", filename, data: data.toString("base64") }, 30_000);
  }
}

/** Log ra stderr — stdout là kênh MCP, tuyệt đối không ghi vào. */
export function log(...args: unknown[]) {
  console.error("[bridge]", ...args);
}
