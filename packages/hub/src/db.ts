import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, MessageType, ParticipantKind, RoomInfo } from "@tcm/shared";

export interface ParticipantRow {
  name: string;
  role: string;
  kind: ParticipantKind;
  status: string | null;
  lastSeen: string;
  lastReadId: number;
}

const now = () => new Date().toISOString();

/** Participant "user" (bạn, qua web) luôn có sẵn trong mỗi phòng để agent gửi tin được. */
export const HUMAN_NAME = "user";

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        room TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        status TEXT,
        last_seen TEXT NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room, name)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room, id);
    `);
  }

  ensureRoom(room: string): void {
    const t = now();
    this.db.prepare("INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)").run(room, t);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO participants (room, name, role, kind, last_seen) VALUES (?, ?, 'human', 'human', ?)",
      )
      .run(room, HUMAN_NAME, t);
  }

  listRooms(): RoomInfo[] {
    const rows = this.db
      .prepare(
        `SELECT r.name, r.created_at, COUNT(m.id) AS cnt, MAX(m.created_at) AS last_at
         FROM rooms r LEFT JOIN messages m ON m.room = r.name
         GROUP BY r.name ORDER BY COALESCE(MAX(m.created_at), r.created_at) DESC`,
      )
      .all() as { name: string; created_at: string; cnt: number; last_at: string | null }[];
    return rows.map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      messageCount: Number(r.cnt),
      lastMessageAt: r.last_at,
    }));
  }

  upsertParticipant(room: string, name: string, role: string, kind: ParticipantKind): ParticipantRow {
    this.ensureRoom(room);
    this.db
      .prepare(
        `INSERT INTO participants (room, name, role, kind, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (room, name) DO UPDATE SET role = excluded.role, kind = excluded.kind, last_seen = excluded.last_seen`,
      )
      .run(room, name, role, kind, now());
    return this.getParticipant(room, name)!;
  }

  getParticipant(room: string, name: string): ParticipantRow | undefined {
    const r = this.db
      .prepare(
        "SELECT name, role, kind, status, last_seen, last_read_id FROM participants WHERE room = ? AND name = ?",
      )
      .get(room, name) as
      | { name: string; role: string; kind: ParticipantKind; status: string | null; last_seen: string; last_read_id: number }
      | undefined;
    return r && toParticipantRow(r);
  }

  listParticipants(room: string): ParticipantRow[] {
    const rows = this.db
      .prepare(
        "SELECT name, role, kind, status, last_seen, last_read_id FROM participants WHERE room = ? ORDER BY kind, name",
      )
      .all(room) as {
      name: string;
      role: string;
      kind: ParticipantKind;
      status: string | null;
      last_seen: string;
      last_read_id: number;
    }[];
    return rows.map(toParticipantRow);
  }

  touch(room: string, name: string): void {
    this.db.prepare("UPDATE participants SET last_seen = ? WHERE room = ? AND name = ?").run(now(), room, name);
  }

  setStatus(room: string, name: string, status: string | null): void {
    this.db
      .prepare("UPDATE participants SET status = ?, last_seen = ? WHERE room = ? AND name = ?")
      .run(status, now(), room, name);
  }

  ack(room: string, name: string, upToId: number): void {
    this.db
      .prepare("UPDATE participants SET last_read_id = MAX(last_read_id, ?) WHERE room = ? AND name = ?")
      .run(upToId, room, name);
  }

  addMessage(m: {
    room: string;
    from: string;
    to: string;
    type: MessageType;
    content: string;
    replyTo: number | null;
  }): ChatMessage {
    const createdAt = now();
    const res = this.db
      .prepare(
        "INSERT INTO messages (room, from_name, to_name, type, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(m.room, m.from, m.to, m.type, m.content, m.replyTo, createdAt);
    return { id: Number(res.lastInsertRowid), createdAt, ...m };
  }

  getMessage(room: string, id: number): ChatMessage | undefined {
    const r = this.db.prepare(`${SELECT_MSG} WHERE room = ? AND id = ?`).get(room, id) as unknown as MessageDbRow | undefined;
    return r && toMessage(r);
  }

  /** Lịch sử theo thứ tự tăng dần id. `beforeId` để phân trang lùi, `sinceId` để lấy tin mới hơn. */
  history(room: string, opts: { limit?: number; beforeId?: number; sinceId?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    if (opts.sinceId !== undefined) {
      const rows = this.db
        .prepare(`${SELECT_MSG} WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(room, opts.sinceId, limit) as unknown as MessageDbRow[];
      return rows.map(toMessage);
    }
    const rows = this.db
      .prepare(`${SELECT_MSG} WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(room, opts.beforeId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageDbRow[];
    return rows.map(toMessage).reverse();
  }

  /** Tin chưa đọc gửi tới `name` (trực tiếp hoặc @all), không tính tin chính mình gửi. */
  unreadFor(room: string, name: string, lastReadId: number, limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare(
        `${SELECT_MSG} WHERE room = ? AND id > ? AND type != 'system' AND from_name != ? AND (to_name = ? OR to_name = '@all')
         ORDER BY id ASC LIMIT ?`,
      )
      .all(room, lastReadId, name, name, limit) as unknown as MessageDbRow[];
    return rows.map(toMessage);
  }
}

const SELECT_MSG = "SELECT id, room, from_name, to_name, type, content, reply_to, created_at FROM messages";

interface MessageDbRow {
  id: number;
  room: string;
  from_name: string;
  to_name: string;
  type: MessageType;
  content: string;
  reply_to: number | null;
  created_at: string;
}

function toMessage(r: MessageDbRow): ChatMessage {
  return {
    id: Number(r.id),
    room: r.room,
    from: r.from_name,
    to: r.to_name,
    type: r.type,
    content: r.content,
    replyTo: r.reply_to === null ? null : Number(r.reply_to),
    createdAt: r.created_at,
  };
}

function toParticipantRow(r: {
  name: string;
  role: string;
  kind: ParticipantKind;
  status: string | null;
  last_seen: string;
  last_read_id: number;
}): ParticipantRow {
  return {
    name: r.name,
    role: r.role,
    kind: r.kind,
    status: r.status,
    lastSeen: r.last_seen,
    lastReadId: Number(r.last_read_id),
  };
}
