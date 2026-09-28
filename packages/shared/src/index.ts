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
  /** Agent đang đứng chờ trong wait_for_messages (chế độ trực) */
  waiting: boolean;
  /** Cần user chú ý ở terminal (vd. chờ duyệt quyền), do hook Claude Code báo lên */
  attention: string | null;
}

export interface RoomInfo {
  name: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  onDuty: boolean;
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
  | { op: "ack"; upToId: number }
  /** Bridge báo đang / thôi chờ trong wait_for_messages */
  | { op: "waiting"; waiting: boolean }
  /** Web: bật / tắt chế độ trực của phòng (tắt = cho agent kết thúc lượt) */
  | { op: "duty"; reqId?: string; onDuty: boolean };

// ---------- hub -> client ----------

export type ServerOp =
  | { op: "welcome"; reqId?: string; room: string; self: Participant | null; unread: ChatMessage[]; onDuty: boolean }
  | { op: "room"; room: string; onDuty: boolean }
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

/** Body của POST /api/hook, gửi từ scripts/hook.mjs (Claude Code hooks) */
export interface HookRequest {
  event: "stop" | "notify" | "clear";
  room: string;
  name: string;
  input?: { notification_type?: string; message?: string; stop_hook_active?: boolean };
}
export interface HookResponse {
  block?: boolean;
  reason?: string;
}

// ---------- Kickoff ticket ----------

/** Thông tin để soạn tin kickoff. Lưu theo phòng, lấy từ .team-hub.json (tcm start) hoặc form trên web. */
export interface KickoffMeta {
  ticket: string;
  /** Link Figma dùng THAY cho link trong ticket */
  figma?: string;
  /** vd. "100000 / Password_1" */
  testAccount?: string;
  appRun?: string;
  appUrl?: string;
  planDir?: string;
  testcaseDir?: string;
  runsDir?: string;
  /** Ghi chú thêm (phạm vi, lưu ý…) */
  notes?: string;
}

export const KICKOFF_DEFAULTS = { planDir: "docs/plan", testcaseDir: "qa/testcases", runsDir: "qa/runs" } as const;

export function buildKickoff(meta: KickoffMeta): string {
  const t = meta.ticket.trim();
  const plan = `${(meta.planDir || KICKOFF_DEFAULTS.planDir).replace(/\/$/, "")}/${t}.md`;
  const tc = `${(meta.testcaseDir || KICKOFF_DEFAULTS.testcaseDir).replace(/\/$/, "")}/${t}.md`;
  const runs = `${(meta.runsDir || KICKOFF_DEFAULTS.runsDir).replace(/\/$/, "")}/${t}.md`;
  const info: string[] = [];
  if (meta.figma?.trim())
    info.push(`- Figma: ${meta.figma.trim()} (dùng link này thay cho link trong ticket, xem bằng figma-console)`);
  if (meta.testAccount?.trim()) info.push(`- Tài khoản test: ${meta.testAccount.trim()} (không ghi mật khẩu vào file)`);
  if (meta.appRun?.trim() || meta.appUrl?.trim())
    info.push(`- App: ${[meta.appRun?.trim() && `\`${meta.appRun.trim()}\``, meta.appUrl?.trim()].filter(Boolean).join(" → ")}`);
  return [
    `🎫 **Kickoff ticket ${t}**`,
    "",
    `Đọc ticket **${t}** trên Backlog (mô tả, AC, comment, file đính kèm) và chạy quy trình B1 → B7.`,
    ...info,
    "",
    `- **@dev**: B1 tự xem design + viết plan \`${plan}\` → B2 review test case của QA → B3 implement + unit test → B4 chạy app, handoff URL cho QA → B5–B6 fix hoặc phản biện bug.`,
    `- **@qa**: B1 tự xem design + viết test case \`${tc}\` → B2 review plan của DEV → B3 soát code, báo lệch AC sớm → B5–B6 test trên browser (so UI với design trên Figma), ghi kết quả \`${runs}\`, báo bug, retest.`,
    "- **B7**: QA soạn nháp tổng kết, DEV bổ sung phần kỹ thuật, rồi gửi tôi **1 báo cáo chung**.",
    "",
    "Luật: mỗi vấn đề tranh luận tối đa 2 lượt mỗi bên, sau đó hỏi tôi phân xử. Mọi lý lẽ phải trích AC. Không sửa ticket trên Backlog.",
    ...(meta.notes?.trim() ? ["", `Ghi chú: ${meta.notes.trim()}`] : []),
    "",
    "Trước khi bắt đầu, mỗi người trả lời tôi 1 tin ngắn: bạn hiểu ticket thế nào, AC nào còn mơ hồ.",
  ].join("\n");
}
