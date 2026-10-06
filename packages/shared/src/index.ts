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
  "report", // B7: báo cáo tổng kết chung gửi user (qua submit_report)
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
  /** Ticket đã đóng (user bấm Đóng ticket / tcm close) */
  closedAt: string | null;
}

// ---------- Bảng ticket: tiến độ B1–B7 + bug ----------

export const STEPS = ["B1", "B2", "B3", "B4", "B5", "B6", "B7"] as const;
export type Step = (typeof STEPS)[number];
export const STEP_LABEL: Record<Step, string> = {
  B1: "Plan ∥ Test case",
  B2: "Review chéo",
  B3: "Implement",
  B4: "Handoff",
  B5: "Test ↔ Phản biện",
  B6: "Retest",
  B7: "Tổng kết",
};

/** Lấy bước từ đầu chuỗi: "[B2] …", "B5 · đang test" → "B2", "B5" */
export function parseStep(text: string | null | undefined): Step | null {
  const m = text?.match(/^\s*\[?\s*B([1-7])\b/i);
  return m ? (`B${m[1]}` as Step) : null;
}

export interface StepEvent {
  name: string;
  step: Step;
  at: string;
}

export const BUG_STATUSES = ["open", "fixed", "verified", "reopened", "disputed", "rejected", "need_user"] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];
export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  open: "Mở",
  fixed: "Đã fix (chờ retest)",
  verified: "Retest pass",
  reopened: "Mở lại",
  disputed: "DEV phản biện",
  rejected: "Không phải bug",
  need_user: "Chờ user phân xử",
};
export const BUG_SEVERITIES = ["high", "med", "low"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

/** Chuyển trạng thái hợp lệ cho agent. "need_user" chỉ user (web) mới gỡ được. */
export const BUG_TRANSITIONS: Record<BugStatus, BugStatus[]> = {
  open: ["fixed", "disputed", "rejected", "need_user"],
  reopened: ["fixed", "disputed", "rejected", "need_user"],
  fixed: ["verified", "reopened"],
  disputed: ["open", "rejected", "need_user"],
  verified: ["reopened"],
  rejected: ["reopened"],
  need_user: [],
};
/** Tối đa số lượt tranh luận mỗi bên cho một bug, quá thì hub tự chuyển need_user */
export const MAX_DISPUTE_ROUNDS = 2;

export interface BugEvent {
  actor: string;
  from: BugStatus | null;
  to: BugStatus;
  note: string | null;
  msgId: number | null;
  at: string;
}

export interface Bug {
  code: string;
  title: string;
  severity: BugSeverity;
  status: BugStatus;
  tc: string | null;
  reporter: string;
  assignee: string;
  /** Tin bug_report gốc */
  msgId: number;
  /** Số lượt tranh luận theo tên participant */
  rounds: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  events: BugEvent[];
}

/** Một phiên bản báo cáo B7 (agent gửi bằng submit_report, hoặc user sửa trên web) */
export interface Report {
  id: number;
  author: string;
  content: string;
  /** Tin "report" tương ứng (null nếu user sửa trên web) */
  msgId: number | null;
  createdAt: string;
}

export interface Board {
  steps: StepEvent[];
  bugs: Bug[];
  /** Báo cáo B7 mới nhất */
  report: Report | null;
  reportVersions: number;
  closedAt: string | null;
  /** Số tin agent↔agent liên tiếp không có tiến triển (đổi bước, đổi trạng thái bug, user nhắn) */
  idleChatter: number;
  warning: string | null;
}

export const ATTACHMENT_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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
  | { op: "status"; reqId?: string; text: string | null; step?: Step | null }
  /** Board của phòng (bước + bug) */
  | { op: "board"; reqId?: string }
  | {
      op: "bug_create";
      reqId?: string;
      title: string;
      severity?: BugSeverity;
      tc?: string | null;
      detail: string;
      to?: string;
      attachments?: string[];
    }
  /** Agent theo BUG_TRANSITIONS; user (web) đổi sang trạng thái bất kỳ (phân xử) */
  | { op: "bug_update"; reqId?: string; code: string; status: BugStatus; note?: string | null; attachments?: string[] }
  /** Tải ảnh (base64) lên hub, trả về { url } dùng được trong markdown */
  | { op: "upload"; reqId?: string; filename: string; data: string }
  /** B7: lưu báo cáo tổng kết chung + gửi tin "report" cho user */
  | { op: "report"; reqId?: string; content: string; attachments?: string[] }
  /** Tóm tắt phòng (markdown) cho người gọi: dùng khi vào lại phòng */
  | { op: "summary"; reqId?: string }
  /** Đánh dấu đã đọc tới id này (dùng cho agent để tính unread khi reconnect) */
  | { op: "ack"; upToId: number }
  /** Bridge báo đang / thôi chờ trong wait_for_messages */
  | { op: "waiting"; waiting: boolean }
  /** Web: bật / tắt chế độ trực của phòng (tắt = cho agent kết thúc lượt) */
  | { op: "duty"; reqId?: string; onDuty: boolean };

// ---------- hub -> client ----------

export type ServerOp =
  | { op: "welcome"; reqId?: string; room: string; self: Participant | null; unread: ChatMessage[]; onDuty: boolean; closed?: boolean }
  | { op: "room"; room: string; onDuty: boolean; closed?: boolean }
  | { op: "message"; message: ChatMessage }
  | { op: "participants"; room: string; participants: Participant[] }
  | { op: "board"; room: string; board: Board }
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

/** Bước hiện tại + thời gian ở mỗi bước, theo từng participant */
export function stepSummary(steps: StepEvent[], nowMs = Date.now()) {
  const byName = new Map<string, { current: Step; since: string; spent: Partial<Record<Step, number>> }>();
  const sorted = [...steps].sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const next = sorted.slice(i + 1).find((x) => x.name === e.name);
    const ms = (next ? Date.parse(next.at) : nowMs) - Date.parse(e.at);
    const s = byName.get(e.name) ?? { current: e.step, since: e.at, spent: {} };
    s.spent[e.step] = (s.spent[e.step] ?? 0) + Math.max(0, ms);
    if (!next) Object.assign(s, { current: e.step, since: e.at });
    byName.set(e.name, s);
  }
  return byName;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1p";
  if (m < 60) return `${m}p`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

/** Board dạng markdown, cho agent đọc (get_board) và làm số liệu B7 */
export function boardMarkdown(board: Board): string {
  const out: string[] = ["## Tiến độ"];
  const sum = stepSummary(board.steps);
  if (!sum.size) out.push("_Chưa ai cập nhật bước (dùng set_status với step)._");
  for (const [name, s] of sum) {
    const spent = STEPS.filter((st) => s.spent[st]).map((st) => `${st} ${fmtDuration(s.spent[st]!)}`).join(" · ");
    out.push(`- **${name}**: đang ở ${s.current} (${STEP_LABEL[s.current]}) · ${spent}`);
  }
  out.push("", "## Bug");
  if (!board.bugs.length) out.push("_Chưa có bug._");
  else {
    const count = (f: (b: Bug) => boolean) => board.bugs.filter(f).length;
    out.push(
      `Tổng ${board.bugs.length} · đã fix + retest pass ${count((b) => b.status === "verified")} · ` +
        `không phải bug ${count((b) => b.status === "rejected")} · chờ user ${count((b) => b.status === "need_user")} · ` +
        `còn mở ${count((b) => ["open", "reopened", "fixed", "disputed"].includes(b.status))}`,
      "",
      "| Bug | Mức | TC | Tiêu đề | Trạng thái | Tranh luận |",
      "|---|---|---|---|---|---|",
      ...board.bugs.map(
        (b) =>
          `| ${b.code} | ${b.severity} | ${b.tc ?? ""} | ${b.title.replace(/\|/g, "\\|")} | ${BUG_STATUS_LABEL[b.status]} | ${
            Object.entries(b.rounds).map(([n, c]) => `${n} ${c}`).join(", ") || "-"
          } |`,
      ),
    );
  }
  if (board.warning) out.push("", `⚠️ ${board.warning}`);
  return out.join("\n");
}

const bugCount = (bugs: Bug[], ...st: BugStatus[]) => bugs.filter((b) => st.includes(b.status)).length;

/** Nháp báo cáo B7 từ bảng ticket, cho user tự viết khi agent chưa gửi */
export function reportDraft(ticket: string, board: Board): string {
  const b = board.bugs;
  return [
    `## Tổng kết ${ticket}`,
    "**Kết quả:** ✅ Đạt / ⚠️ Đạt có điều kiện / ❌ Chưa đạt",
    "",
    `**Bug:** tìm thấy ${b.length} · đã fix + retest pass ${bugCount(b, "verified")} · không phải bug ${bugCount(b, "rejected")} · ` +
      `còn mở ${bugCount(b, "open", "reopened", "fixed", "disputed", "need_user")}`,
    ...(b.length
      ? [
          "",
          "| Bug | Mức | Mô tả | Trạng thái |",
          "|---|---|---|---|",
          ...b.map((x) => `| ${x.code} | ${x.severity} | ${x.title.replace(/\|/g, "\\|")} | ${BUG_STATUS_LABEL[x.status]} |`),
        ]
      : []),
    "",
    "**Việc còn mở / cần quyết:** …",
  ].join("\n");
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
  /** Repo đích (đường dẫn Windows), do tcm start ghi: tcm resume mở lại terminal ở đây */
  repoDir?: string;
  /** Repo nằm trong WSL: đường dẫn Linux + distro */
  wslCwd?: string;
  distro?: string;
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
    `- **@dev**: B1 tự xem design + viết plan \`${plan}\` → B2 review test case của QA → B3 implement + unit test → chạy \`/backend-review\`, gửi kết quả cho tôi và chờ tôi duyệt rồi mới fix → B4 chạy app, handoff URL cho QA → B5–B6 fix hoặc phản biện bug.`,
    `- **@qa**: B1 tự xem design + viết test case \`${tc}\` → B2 review plan của DEV → B3 soát code, báo lệch AC sớm → B5–B6 test trên browser (so UI với design trên Figma), ghi kết quả \`${runs}\`, báo bug, retest.`,
    "- **B7**: QA soạn nháp tổng kết, DEV bổ sung phần kỹ thuật, rồi QA gửi tôi **1 báo cáo chung** bằng `submit_report`.",
    "",
    "Luật: mỗi vấn đề tranh luận tối đa 2 lượt mỗi bên, sau đó hỏi tôi phân xử. Mọi lý lẽ phải trích AC. Không sửa ticket trên Backlog.",
    ...(meta.notes?.trim() ? ["", `Ghi chú: ${meta.notes.trim()}`] : []),
    "",
    "Trước khi bắt đầu, mỗi người trả lời tôi 1 tin ngắn: bạn hiểu ticket thế nào, AC nào còn mơ hồ.",
  ].join("\n");
}
