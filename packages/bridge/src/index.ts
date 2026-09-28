#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BROADCAST,
  DEFAULT_HUB_PORT,
  MESSAGE_TYPES,
  isAddressedTo,
  type ChatMessage,
  type Participant,
} from "@tcm/shared";
import { HubClient, log } from "./hubClient.js";
import { buildInstructions } from "./personas.js";

// Không có HUB_ROOM = session thường (không mở qua claude-as): không vào phòng nào, không expose tool,
// để team-hub cài ở scope user không "kéo" mọi session vào hub.
if (!process.env.HUB_ROOM?.trim()) {
  const idle = new McpServer({ name: "team-hub", version: "0.3.0" });
  await idle.connect(new StdioServerTransport());
  log("HUB_ROOM chưa đặt: bridge ở chế độ nghỉ (không kết nối hub). Mở session bằng scripts/claude-as để tham gia phòng.");
  await new Promise(() => {});
}

const role = process.env.AGENT_ROLE?.trim() || "agent";
const name = process.env.AGENT_NAME?.trim() || role;
const room = process.env.HUB_ROOM?.trim() || "default";
const url = process.env.HUB_URL?.trim() || `ws://127.0.0.1:${DEFAULT_HUB_PORT}/ws`;

/**
 * Chế độ channel: đẩy tin thẳng vào session qua `notifications/claude/channel`.
 * Chỉ bật khi session được mở với `--dangerously-load-development-channels server:team-hub`
 * (script claude-as tự làm) — nếu không, Claude Code bỏ qua notification một cách im lặng.
 */
const channelMode = /^(1|true|yes|on)$/i.test(process.env.HUB_CHANNEL ?? "");

const hub = new HubClient({ url, room, name, role, kind: "agent" });

// ---------- Inbox: tin gửi tới mình, chưa giao cho Claude ----------

const inbox: ChatMessage[] = [];
const seen = new Set<number>();
let waiters: (() => void)[] = [];
let mcpReady = false;

function enqueue(msg: ChatMessage) {
  inbox.push(msg);
  wakeWaiters();
}

function onIncoming(msg: ChatMessage, allowPush: boolean) {
  if (seen.has(msg.id) || !isAddressedTo(msg, name)) return;
  seen.add(msg.id);
  // Đang có wait_for_messages chờ → trả qua tool cho nhanh; ngoài ra ở chế độ channel thì push.
  if (allowPush && channelMode && mcpReady && waiters.length === 0) void push(msg);
  else enqueue(msg);
}

async function push(msg: ChatMessage) {
  const meta: Record<string, string> = { from: msg.from, to: msg.to, type: msg.type, msg_id: String(msg.id) };
  if (msg.replyTo) meta.reply_to = String(msg.replyTo);
  try {
    await server.server.notification({ method: "notifications/claude/channel", params: { content: msg.content, meta } });
    hub.ack(msg.id);
  } catch (e) {
    log("push channel lỗi, chuyển vào inbox:", e);
    enqueue(msg);
  }
}

// Tin chưa đọc lúc (re)connect: để trong inbox — session có thể chưa sẵn sàng nhận channel event.
hub.on("welcome", (unread: ChatMessage[]) => {
  unread.forEach((m) => onIncoming(m, false));
  if (waiters.length) hub.setWaiting(true); // reconnect giữa lúc đang chờ
});
hub.on("message", (msg: ChatMessage) => onIncoming(msg, true));
// User tắt chế độ trực → đánh thức mọi wait_for_messages đang chờ để agent kết thúc lượt
hub.on("room", (onDuty: boolean) => {
  if (!onDuty) wakeWaiters();
});

function wakeWaiters() {
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}

/** Lấy hết tin trong inbox ra, ack lên hub */
function drain(): ChatMessage[] {
  const out = inbox.splice(0, inbox.length).sort((a, b) => a.id - b.id);
  if (out.length) hub.ack(out[out.length - 1].id);
  return out;
}

function waitForInbox(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (inbox.length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      waiters = waiters.filter((w) => w !== done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener("abort", done);
    waiters.push(done);
  });
}

// ---------- Format cho Claude đọc ----------

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("vi-VN", { hour12: false });
}

function fmtMessage(m: ChatMessage): string {
  const reply = m.replyTo ? ` (trả lời #${m.replyTo})` : "";
  const to = m.to === BROADCAST ? "@all" : m.to;
  return `#${m.id} [${m.type}] ${m.from} → ${to}${reply} · ${time(m.createdAt)}\n${m.content}`;
}

function fmtParticipants(ps: Participant[]): string {
  return ps
    .map((p) => {
      const st = p.online ? "🟢 online" : "⚪ offline";
      const me = p.name === name ? " (bạn)" : "";
      return `- ${p.name}${me} [${p.role || p.kind}] ${st}${p.status ? ` — ${p.status}` : ""}`;
    })
    .join("\n");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Mọi tool result đều kèm tin mới (nếu có), để agent không bỏ lỡ phản hồi. */
function result(text: string, opts: { isError?: boolean; attachInbox?: boolean } = {}): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text }];
  if (opts.attachInbox !== false) {
    const news = drain();
    if (news.length) {
      content.push({
        type: "text",
        text: `📬 ${news.length} tin mới:\n\n${news.map(fmtMessage).join("\n\n---\n\n")}`,
      });
    }
  }
  return { content, isError: opts.isError };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return result(`Lỗi: ${e instanceof Error ? e.message : String(e)}`, { isError: true });
  }
}

// ---------- MCP server ----------

const server = new McpServer(
  { name: "team-hub", version: "0.2.0" },
  {
    capabilities: channelMode ? { experimental: { "claude/channel": {} } } : {},
    instructions: buildInstructions({ name, role, room, channelMode }),
  },
);
server.server.oninitialized = () => {
  mcpReady = true;
};

server.registerTool(
  "send_message",
  {
    title: "Gửi tin nhắn",
    description:
      'Gửi tin nhắn tới một participant trong phòng (vd. "dev", "qa", "user") hoặc "@all". ' +
      "Chọn type phù hợp: chat, question, ac_deviation (implement lệch AC), test_case, bug_report, handoff (bàn giao).",
    inputSchema: {
      to: z.string().describe('Tên người nhận, hoặc "@all"'),
      content: z.string().min(1).describe("Nội dung (markdown). Kèm file path, tên hàm, bước tái hiện khi cần."),
      type: z
        .enum(MESSAGE_TYPES.filter((t) => t !== "system") as [string, ...string[]])
        .optional()
        .describe("Loại tin, mặc định chat"),
      reply_to: z.number().int().optional().describe("id tin nhắn đang trả lời"),
    },
  },
  ({ to, content, type, reply_to }) =>
    guard(async () => {
      const msg = await hub.sendMessage({
        to,
        content,
        type: type as ChatMessage["type"] | undefined,
        replyTo: reply_to ?? null,
      });
      return result(`Đã gửi #${msg.id} tới ${msg.to}.`);
    }),
);

server.registerTool(
  "wait_for_messages",
  {
    title: "Chờ tin nhắn",
    description:
      "Chờ (block) tới khi có tin nhắn mới gửi cho bạn hoặc hết timeout. Gọi khi bạn đã xong việc hiện tại " +
      "hoặc đang chờ phản hồi từ người khác. Trả về ngay nếu đã có tin chưa đọc.",
    inputSchema: {
      timeout_seconds: z.number().int().min(1).max(600).optional().describe("Mặc định 300, tối đa 600"),
    },
  },
  ({ timeout_seconds }, extra) =>
    guard(async () => {
      if (!hub.connected && !inbox.length) {
        return result(`Chưa kết nối được hub (${url}). ${hub.lastError ?? ""}`.trim(), { isError: true });
      }
      const secs = timeout_seconds ?? 300;
      const offDuty = () =>
        result(
          "User đã TẮT chế độ trực trên web. Hãy hoàn tất việc đang làm dở (nếu có), gửi user tóm tắt ngắn nếu cần, rồi KẾT THÚC LƯỢT (không gọi wait_for_messages nữa).",
        );
      if (!hub.onDuty && !inbox.length) return offDuty();
      hub.setWaiting(true);
      try {
        await waitForInbox(secs * 1000, extra.signal);
      } finally {
        hub.setWaiting(false);
      }
      if (!inbox.length && !hub.onDuty) return offDuty();
      if (!inbox.length) {
        return result(
          channelMode
            ? `Không có tin mới sau ${secs}s. Nếu vẫn đang chờ người khác, gọi lại wait_for_messages; ` +
                "nếu không còn việc, cứ kết thúc lượt: tin mới sẽ được đẩy tới."
            : `Không có tin mới sau ${secs}s. Gọi lại wait_for_messages ngay để tiếp tục chờ ` +
                "(đừng kết thúc lượt, nếu không bạn sẽ không nhận được tin từ đồng đội / user).",
        );
      }
      return result("Có tin mới:");
    }),
);

server.registerTool(
  "check_inbox",
  {
    title: "Kiểm tra hộp thư",
    description: "Xem tin nhắn mới (không chờ). Dùng định kỳ trong lúc làm việc dài để không bỏ lỡ phản hồi.",
    inputSchema: {},
  },
  () =>
    guard(async () => {
      if (!inbox.length) return result(hub.connected ? "Không có tin mới." : `Chưa kết nối được hub (${url}).`);
      return result("Hộp thư:");
    }),
);

server.registerTool(
  "get_history",
  {
    title: "Xem lịch sử phòng",
    description: "Đọc lịch sử hội thoại của phòng (mọi tin, không chỉ tin gửi cho bạn). Dùng khi mới vào hoặc cần nhớ lại bối cảnh.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("Mặc định 30"),
      before_id: z.number().int().optional().describe("Lấy các tin cũ hơn id này (phân trang)"),
    },
  },
  ({ limit, before_id }) =>
    guard(async () => {
      const msgs = await hub.history({ limit: limit ?? 30, beforeId: before_id });
      if (!msgs.length) return result("Phòng chưa có tin nhắn.");
      return result(msgs.map(fmtMessage).join("\n\n---\n\n"));
    }),
);

server.registerTool(
  "list_participants",
  {
    title: "Danh sách thành viên",
    description: "Xem ai đang ở trong phòng, online hay không, đang làm gì.",
    inputSchema: {},
  },
  () =>
    guard(async () => {
      const ps = await hub.listParticipants();
      return result(`Phòng "${room}":\n${fmtParticipants(ps)}`);
    }),
);

server.registerTool(
  "set_status",
  {
    title: "Cập nhật trạng thái",
    description: 'Đặt trạng thái ngắn hiển thị cho mọi người (vd. "đang viết test cho /login"). Truyền chuỗi rỗng để xoá.',
    inputSchema: {
      text: z.string().max(200),
    },
  },
  ({ text }) =>
    guard(async () => {
      await hub.setStatus(text || null);
      return result(text ? `Trạng thái: ${text}` : "Đã xoá trạng thái.");
    }),
);

// ---------- start ----------

hub.start();
const transport = new StdioServerTransport();
await server.connect(transport);
log(`MCP bridge sẵn sàng: name=${name} role=${role} room=${room} hub=${url} mode=${channelMode ? "channel" : "long-poll"}`);

const shutdown = () => {
  hub.stop();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
