// Giao thức WebSocket dùng chung giữa hub, bridge (MCP) và web UI.

export const DEFAULT_HUB_PORT = 4747;
export const BROADCAST = "@all";

export const MESSAGE_TYPES = [
  "chat", // trao đổi thông thường
  "question", // hỏi, cần người nhận trả lời
  "ac_deviation", // QA phát hiện implement lệch so với Acceptance Criteria
  "test_case", // QA tạo / cập nhật test case
  "bug_report", // QA báo bug (steps / expected / actual)
  "handoff", // bàn giao: "đã xong X, tới lượt bạn"
  "system", // do hub sinh ra
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export type ParticipantKind = "agent" | "human";

export interface ChatMessage {
  id: number;
  room: string;
  from: string;
  /** Tên người nhận, hoặc "@all" */
  to: string;
  type: MessageType;
  content: string;
  replyTo: number | null;
  createdAt: string;
}

export interface Participant {
  name: string;
  role: string;
  kind: ParticipantKind;
  online: boolean;
  status: string | null;
  lastSeen: string;
}

export interface RoomInfo {
  name: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
}

// ---------- client -> hub ----------

export type HelloOp =
  | { op: "hello"; reqId?: string; kind: ParticipantKind; room: string; name: string; role?: string }
  /** Viewer: chỉ xem (web UI), không là participant */
  | { op: "hello"; reqId?: string; kind: "viewer"; room: string };

export type ClientOp =
  | HelloOp
  | { op: "send"; reqId?: string; to: string; type?: MessageType; content: string; replyTo?: number | null }
  | { op: "history"; reqId?: string; limit?: number; beforeId?: number; sinceId?: number }
  | { op: "participants"; reqId?: string }
  | { op: "status"; reqId?: string; text: string | null }
  /** Đánh dấu đã đọc tới id này (dùng cho agent để tính unread khi reconnect) */
  | { op: "ack"; upToId: number };

// ---------- hub -> client ----------

export type ServerOp =
  | { op: "welcome"; reqId?: string; room: string; self: Participant | null; unread: ChatMessage[] }
  | { op: "message"; message: ChatMessage }
  | { op: "participants"; room: string; participants: Participant[] }
  | { op: "result"; reqId: string; data: unknown }
  | { op: "error"; reqId?: string; error: string }
  | { op: "kicked"; reason: string };

/**
 * Tin nhắn này có gửi tới `name` không (trực tiếp hoặc broadcast, không phải do chính mình gửi).
 * Tin system (join/offline) không tính — chỉ để hiển thị trên web, tránh đánh thức agent vô ích.
 */
export function isAddressedTo(msg: ChatMessage, name: string): boolean {
  return msg.type !== "system" && msg.from !== name && (msg.to === BROADCAST || msg.to === name);
}
