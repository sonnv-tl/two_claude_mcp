#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import {
  BROADCAST,
  DEFAULT_HUB_PORT,
  MESSAGE_TYPES,
  BUG_SEVERITIES,
  BUG_STATUSES,
  BUG_STATUS_LABEL,
  MAX_DISPUTE_ROUNDS,
  STEPS,
  boardMarkdown,
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
  prefetchImages(msg.content);
  // Đang có wait_for_messages chờ → trả qua tool cho nhanh; ngoài ra ở chế độ channel thì push.
  if (allowPush && channelMode && mcpReady && waiters.length === 0) void push(msg);
  else enqueue(msg);
}

async function push(msg: ChatMessage) {
  const meta: Record<string, string> = { from: msg.from, to: msg.to, type: msg.type, msg_id: String(msg.id) };
  if (msg.replyTo) meta.reply_to = String(msg.replyTo);
  try {
    await server.server.notification({ method: "notifications/claude/channel", params: { content: localizeImages(msg.content), meta } });
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
  return `#${m.id} [${m.type}] ${m.from} → ${to}${reply} · ${time(m.createdAt)}\n${localizeImages(m.content)}`;
}

// ---------- Ảnh đính kèm (/att/...): tải về máy để agent xem bằng Read ----------

const HTTP_BASE = url.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
const ATT_DIR = join(tmpdir(), "team-hub-att", room);
const ATT_RE = /\]\((\/att\/[^)\s]+)\)/g;
/** "/att/room/file" → đường dẫn file trên máy (đã tải xong) */
const localAtt = new Map<string, string>();
const fetching = new Set<string>();

function prefetchImages(content: string) {
  for (const [, path] of content.matchAll(ATT_RE)) {
    if (localAtt.has(path) || fetching.has(path)) continue;
    fetching.add(path);
    fetch(HTTP_BASE + path)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        mkdirSync(ATT_DIR, { recursive: true });
        const file = join(ATT_DIR, decodeURIComponent(path.split("/").pop()!));
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        localAtt.set(path, file);
      })
      .catch((e) => log("không tải được ảnh", path, e))
      .finally(() => fetching.delete(path));
  }
}

/** Link ảnh trong tin → đường dẫn file trên máy (xem bằng Read); chưa tải xong thì URL đầy đủ của hub */
function localizeImages(content: string) {
  let n = 0;
  const out = content.replace(ATT_RE, (_, path: string) => {
    n++;
    return `](${localAtt.get(path) ?? HTTP_BASE + path})`;
  });
  return n ? `${out}\n(${n} ảnh đính kèm: xem bằng tool Read với đường dẫn file ở trên)` : out;
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

/**
 * Tin chỉ được kèm vào kết quả của tool khác (send_message, set_status…), agent dễ đọc lướt rồi bỏ qua.
 * Giữ lại tới khi agent nhắn cho người gửi; wait_for_messages / check_inbox nhắc lại một lần, Stop hook cũng chặn.
 */
let followUp: ChatMessage[] = [];

function syncFollowUp() {
  hub.setFollowUp(followUp.map((m) => m.id));
}

/** Agent vừa nhắn cho `to` → coi như đã phản hồi các tin của người đó */
function answered(to: string, replyTo?: number | null) {
  const before = followUp.length;
  followUp = followUp.filter((m) => !(to === BROADCAST || m.from === to || m.id === replyTo));
  if (followUp.length !== before) syncFollowUp();
}

/** Lấy các tin cần nhắc lại (và xoá khỏi danh sách) */
function takeFollowUp(): string | null {
  if (!followUp.length) return null;
  const list = followUp;
  followUp = [];
  syncFollowUp();
  return (
    `⚠️ Nhắc lại ${list.length} tin bạn CHƯA phản hồi (đã kèm ở kết quả một tool trước đó, có thể bạn đã bỏ sót). ` +
    `Xử lý và trả lời người gửi bằng send_message:\n\n${list.map(fmtMessage).join("\n\n---\n\n")}`
  );
}

/** Mọi tool result đều kèm tin mới (nếu có), để agent không bỏ lỡ phản hồi. */
function result(text: string, opts: { isError?: boolean; attachInbox?: boolean; inboxTool?: boolean } = {}): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text }];
  if (opts.attachInbox !== false) {
    const news = drain();
    if (news.length) {
      content.push({
        type: "text",
        text: opts.inboxTool
          ? `📬 ${news.length} tin mới:\n\n${news.map(fmtMessage).join("\n\n---\n\n")}`
          : `📬 ${news.length} tin MỚI gửi bạn (đến trong lúc bạn đang làm việc). Đọc kỹ, xử lý và trả lời người gửi TRƯỚC khi làm tiếp:\n\n` +
            news.map(fmtMessage).join("\n\n---\n\n"),
      });
      if (!opts.inboxTool) {
        followUp.push(...news.filter((m) => m.from !== "hub"));
        syncFollowUp();
      }
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

const screenshotsSchema = z
  .array(z.string())
  .max(6)
  .optional()
  .describe("Đường dẫn file ảnh (png/jpg/webp) trong repo, vd. qa/screenshots/bug-01.png. Ảnh được tải lên hub và hiện trên web.");

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
        .enum(MESSAGE_TYPES.filter((t) => t !== "system" && t !== "report") as [string, ...string[]])
        .optional()
        .describe("Loại tin, mặc định chat"),
      reply_to: z.number().int().optional().describe("id tin nhắn đang trả lời"),
      screenshots: screenshotsSchema,
    },
  },
  ({ to, content, type, reply_to, screenshots }) =>
    guard(async () => {
      const { urls, warnings } = await uploadAll(screenshots);
      const msg = await hub.sendMessage({
        to,
        content: content + urls.map((u, i) => `

![ảnh ${i + 1}](${u})`).join(""),
        type: type as ChatMessage["type"] | undefined,
        replyTo: reply_to ?? null,
      });
      answered(msg.to, reply_to);
      return result(`Đã gửi #${msg.id} tới ${msg.to}.${warnings}`);
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
      const again = takeFollowUp();
      if (again) return result(again, { inboxTool: true });
      if (!hub.connected && !inbox.length) {
        return result(`Chưa kết nối được hub (${url}). ${hub.lastError ?? ""}`.trim(), { isError: true });
      }
      const secs = timeout_seconds ?? 300;
      const offDuty = () =>
        result(
          hub.ticketClosed
            ? "User đã ĐÓNG ticket. Dừng mọi việc, không gửi thêm tin, KẾT THÚC LƯỢT (không gọi wait_for_messages nữa)."
            : "User đã TẮT chế độ trực trên web. Hãy hoàn tất việc đang làm dở (nếu có), gửi user tóm tắt ngắn nếu cần, rồi KẾT THÚC LƯỢT (không gọi wait_for_messages nữa).",
          { inboxTool: true },
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
          { inboxTool: true },
        );
      }
      return result("Có tin mới:", { inboxTool: true });
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
      const again = takeFollowUp();
      if (!inbox.length) return result(again ?? (hub.connected ? "Không có tin mới." : `Chưa kết nối được hub (${url}).`), { inboxTool: true });
      return result(again ? `${again}

Hộp thư:` : "Hộp thư:", { inboxTool: true });
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
      msgs.forEach((m) => prefetchImages(m.content));
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
    description:
      'Đặt trạng thái ngắn hiển thị cho mọi người (vd. "B5 · đang test TC-04"). Truyền chuỗi rỗng để xoá. ' +
      "Truyền `step` (B1–B7) mỗi khi chuyển bước để web hiện tiến độ; text bắt đầu bằng B1…B7 cũng được tính.",
    inputSchema: {
      text: z.string().max(200),
      step: z.enum(STEPS).optional().describe("Bước hiện tại của bạn trong quy trình B1–B7"),
    },
  },
  ({ text, step }) =>
    guard(async () => {
      await hub.setStatus(text || null, step ?? null);
      return result(`${step ? `[${step}] ` : ""}${text ? `Trạng thái: ${text}` : "Đã xoá trạng thái."}`);
    }),
);

server.registerTool(
  "report_bug",
  {
    title: "Báo bug",
    description:
      "Tạo bug mới trên bảng bug của phòng (tự đánh mã BUG-xx) và gửi tin bug_report cho DEV. " +
      "Dùng tool này thay cho send_message type bug_report để bug được theo dõi trạng thái.",
    inputSchema: {
      title: z.string().min(3).max(160).describe("Tóm tắt ngắn, vd. 'Nút Lưu không disable khi form lỗi'"),
      severity: z.enum(BUG_SEVERITIES).optional().describe("high | med | low, mặc định med"),
      tc: z.string().max(40).optional().describe("Test case liên quan, vd. TC-04"),
      detail: z.string().min(1).describe("Markdown: URL, bước tái hiện, expected (trích AC), actual, console error"),
      to: z.string().optional().describe('Người nhận, mặc định DEV của phòng'),
      screenshots: screenshotsSchema,
    },
  },
  ({ title, severity, tc, detail, to, screenshots }) =>
    guard(async () => {
      const { urls, warnings } = await uploadAll(screenshots);
      const { bug, message } = await hub.createBug({ title, severity, tc, detail, to, attachments: urls });
      answered(message.to);
      return result(`Đã tạo ${bug.code} (#${message.id}) gửi ${message.to}.${warnings}`);
    }),
);

server.registerTool(
  "update_bug",
  {
    title: "Cập nhật trạng thái bug",
    description:
      "Đổi trạng thái bug và gửi kèm ghi chú cho bên kia. Luồng: open|reopened → fixed (DEV đã fix) | disputed (DEV phản biện, kèm note trích AC) | rejected; " +
      "fixed → verified (QA retest pass) | reopened (retest fail); disputed → open (QA giữ quan điểm, kèm note) | rejected (QA chấp nhận). " +
      `Mỗi bên tối đa ${MAX_DISPUTE_ROUNDS} lượt tranh luận cho một bug, quá thì hub tự chuyển "chờ user phân xử" (need_user); khi đó chỉ user đổi được.`,
    inputSchema: {
      code: z.string().describe("Mã bug, vd. BUG-01"),
      status: z.enum(BUG_STATUSES).describe("Trạng thái mới. need_user = tự xin user phân xử"),
      note: z.string().optional().describe("Lý do / cách fix / kết quả retest. Bắt buộc khi disputed hoặc giữ quan điểm (open)."),
      screenshots: screenshotsSchema,
    },
  },
  ({ code, status, note, screenshots }) =>
    guard(async () => {
      const { urls, warnings } = await uploadAll(screenshots);
      const { bug, message, escalated } = await hub.updateBug({ code, status, note, attachments: urls });
      answered(message.to);
      return result(
        escalated
          ? `${bug.code} đã hết lượt tranh luận → chuyển "chờ user phân xử". Dừng tranh luận bug này, làm việc khác và chờ user.${warnings}`
          : `${bug.code}: ${BUG_STATUS_LABEL[bug.status]} (#${message.id} gửi ${message.to}).${warnings}`,
      );
    }),
);

server.registerTool(
  "get_board",
  {
    title: "Xem bảng ticket",
    description: "Tiến độ B1–B7 của từng người và bảng bug (trạng thái, số lượt tranh luận). Dùng khi retest, và lấy số liệu cho báo cáo B7.",
    inputSchema: {},
  },
  () => guard(async () => result(boardMarkdown(await hub.board()))),
);

server.registerTool(
  "get_summary",
  {
    title: "Tóm tắt phòng",
    description:
      "Tóm tắt phòng cho người mới vào hoặc vào lại: thông tin ticket (Figma, tài khoản test, đường dẫn file), mỗi người đang ở bước nào, " +
      "bảng bug, việc tồn đọng của BẠN, câu hỏi đang chờ user, trạng thái báo cáo B7, 15 tin gần nhất. Gọi đầu tiên khi vào phòng hoặc sau khi context bị nén.",
    inputSchema: {},
  },
  () => guard(async () => result(await hub.summary())),
);

server.registerTool(
  "submit_report",
  {
    title: "Gửi báo cáo tổng kết (B7)",
    description:
      "B7: gửi user báo cáo tổng kết CHUNG của ticket (đã thống nhất giữa DEV và QA, theo mẫu báo cáo trong hướng dẫn). " +
      "Hub lưu làm báo cáo của ticket: user duyệt, sửa và đóng ticket trên web. Gửi lại = phiên bản mới thay bản cũ. " +
      "Chỉ một người gửi (mặc định QA). KHÔNG đăng báo cáo lên Backlog.",
    inputSchema: {
      content: z.string().min(20).describe("Báo cáo đầy đủ (markdown)"),
      screenshots: screenshotsSchema,
    },
  },
  ({ content, screenshots }) =>
    guard(async () => {
      const { urls, warnings } = await uploadAll(screenshots);
      const { message, version } = await hub.submitReport(content, urls);
      answered(message.to);
      return result(`Đã gửi báo cáo B7 cho user (#${message.id}, phiên bản ${version}). Chờ user duyệt.${warnings}`);
    }),
);

/** Tìm file ảnh agent đưa: tương đối theo repo, tuyệt đối, hoặc path Linux khi repo nằm trong WSL */
function resolveFile(p: string): string | null {
  const cwd = process.cwd();
  const cands = [p, resolvePath(cwd, p)];
  const unc = cwd.match(/^(\\\\wsl(?:\.localhost|\$)\\[^\\]+)/i);
  if (unc && p.startsWith("/")) cands.push(unc[1] + p.replace(/\//g, "\\"));
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

async function uploadAll(paths: string[] | undefined): Promise<{ urls: string[]; warnings: string }> {
  const urls: string[] = [];
  const bad: string[] = [];
  for (const p of paths ?? []) {
    const file = resolveFile(p);
    if (!file) {
      bad.push(`${p}: không tìm thấy`);
      continue;
    }
    try {
      urls.push((await hub.upload(basename(file), readFileSync(file))).url);
    } catch (e) {
      bad.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { urls, warnings: bad.length ? `\n⚠️ Ảnh không tải được (${process.cwd()}):\n- ${bad.join("\n- ")}` : "" };
}

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
