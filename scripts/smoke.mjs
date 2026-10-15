// Smoke test end-to-end: hub + 2 bridge (dev, qa) nói chuyện qua MCP tools.
// Chạy: node scripts/smoke.mjs   (cần `npm run build` trước)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket as WsClient } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 4800 + Math.floor(Math.random() * 100);
const tmp = mkdtempSync(join(tmpdir(), "tcm-smoke-"));
const room = "smoke";
// Agent giả chạy trong terminal ngầm của hub: in lại từng dòng được gõ vào
const fakeAgent = join(tmp, "fake-agent.mjs");
writeFileSync(
  fakeAgent,
  `console.log("FAKE READY " + process.argv.slice(2).join(" "));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.search(/[\\r\\n]/)) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) console.log("GOT: " + line);
  }
});`,
);


const hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "packages/hub/dist/index.js")], {
  env: { ...process.env, HUB_PORT: String(port), HUB_DB: join(tmp, "hub.db"), HUB_IDLE_WARN: "4", HUB_AGENT_CMD: JSON.stringify([process.execPath, fakeAgent]) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ok) => hub.stdout.on("data", (d) => String(d).includes("[hub] http") && ok()));

async function agent(name, { channel = false } = {}) {
  const client = new Client({ name: `smoke-${name}`, version: "0" });
  const pushed = []; // notifications/claude/channel nhận được (giả lập Claude Code)
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushed.push(n.params);
  };
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "packages/bridge/dist/index.js")],
      env: {
        ...process.env,
        HUB_URL: `ws://127.0.0.1:${port}/ws`,
        HUB_ROOM: room,
        AGENT_NAME: name,
        AGENT_ROLE: name,
        HUB_CHANNEL: channel ? "1" : "0",
      },
      stderr: "ignore",
    }),
  );
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call, pushed };
}

/** Giả lập web UI: kết nối viewer, gửi tin dưới tên "user" */
async function viewer() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  ws.send(JSON.stringify({ op: "hello", kind: "viewer", room }));
  let seq = 0;
  const request = (op) =>
    new Promise((ok) => {
      const reqId = `v${++seq}`;
      ws.send(JSON.stringify({ ...op, reqId }));
      const t = setInterval(() => {
        const r = inbox.find((o) => o.reqId === reqId);
        if (r) {
          clearInterval(t);
          ok(r);
        }
      }, 20);
    });
  return { ws, inbox, request };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${cond ? "" : `\n    ${extra}`}`);
  if (!cond) failed++;
};

try {
  const dev = await agent("dev");
  const qa = await agent("qa");
  await new Promise((r) => setTimeout(r, 500)); // đợi 2 bridge hello xong

  const tools = (await dev.client.listTools()).tools.map((t) => t.name);
  check("bridge expose đủ tools", ["send_message", "wait_for_messages", "check_inbox", "get_history", "list_participants", "set_status"].every((t) => tools.includes(t)), tools.join(","));
  check("instructions có persona DEV", (dev.client.getInstructions() ?? "").includes("DEV (developer)"));

  const ps = await dev.call("list_participants");
  check("list_participants thấy dev, qa, user", ["dev", "qa", "user"].every((n) => ps.text.includes(n)), ps.text);

  // QA chờ trước, DEV gửi sau → long-poll phải được đánh thức
  const waiting = qa.call("wait_for_messages", { timeout_seconds: 10 });
  await new Promise((r) => setTimeout(r, 300));
  const sent = await dev.call("send_message", { to: "qa", type: "handoff", content: "Sẽ làm `POST /login`, trả 401 khi sai mật khẩu" });
  check("dev gửi tin thành công", !sent.isError && sent.text.includes("Đã gửi"), sent.text);
  const got = await waiting;
  check("qa nhận được tin qua wait_for_messages", got.text.includes("POST /login") && got.text.includes("[handoff]"), got.text);

  // QA trả lời, DEV nhận được qua tin đính kèm của tool khác (check_inbox)
  await qa.call("send_message", { to: "dev", type: "ac_deviation", content: "AC yêu cầu 423 khi khoá tài khoản", reply_to: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const inbox = await dev.call("check_inbox");
  check("dev thấy phản hồi của qa (reply_to)", inbox.text.includes("423") && inbox.text.includes("trả lời #"), inbox.text);

  const bad = await dev.call("send_message", { to: "khong-ton-tai", content: "x" });
  check("gửi tới người không tồn tại → lỗi rõ ràng", bad.isError && bad.text.includes("Không có participant"), bad.text);

  // Broadcast không quay về người gửi
  await dev.call("send_message", { to: "@all", content: "broadcast test" });
  await new Promise((r) => setTimeout(r, 200));
  const qaIn = await qa.call("check_inbox");
  const devIn = await dev.call("check_inbox");
  check("broadcast tới qa", qaIn.text.includes("broadcast test"), qaIn.text);
  check("broadcast không vọng lại dev", !devIn.text.includes("broadcast test"), devIn.text);

  // Session QA restart → tin gửi lúc offline vẫn nhận được
  await qa.client.close();
  await new Promise((r) => setTimeout(r, 300));
  await dev.call("send_message", { to: "qa", content: "tin gửi khi qa offline" });
  const qa2 = await agent("qa");
  await new Promise((r) => setTimeout(r, 500));
  const offline = await qa2.call("check_inbox");
  check("qa restart nhận lại tin gửi lúc offline", offline.text.includes("tin gửi khi qa offline"), offline.text);
  check("tin đã đọc trước đó không bị giao lại", !offline.text.includes("POST /login"), offline.text);

  // REST cho web (4 tin tính tới thời điểm này)
  const hist = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room}/messages`)).json();
  check("REST history có đủ tin", hist.filter((m) => m.type !== "system").length === 4, JSON.stringify(hist.map((m) => m.content)));

  // ---- Phase 2: web chat + channel mode ----
  await dev.client.close();
  await sleep(200);
  const devCh = await agent("dev", { channel: true });
  await sleep(500);
  check("instructions channel mode nhắc <channel>", (devCh.client.getInstructions() ?? "").includes('<channel source="team-hub"'));

  const web = await viewer();
  await sleep(200);
  const ps2 = await devCh.call("list_participants");
  check("user online khi web đang mở", /- user .*online/.test(ps2.text), ps2.text);

  const r = await web.request({ op: "send", to: "@all", content: "Làm tính năng đổi mật khẩu, AC: ...", type: "chat" });
  check("web gửi @all thành công, from=user", r.op === "result" && r.data.from === "user", JSON.stringify(r));
  await sleep(300);
  check(
    "dev (channel) nhận push notifications/claude/channel kèm meta",
    devCh.pushed.some((p) => p.content.includes("đổi mật khẩu") && p.meta.from === "user" && p.meta.to === "@all" && p.meta.msg_id),
    JSON.stringify(devCh.pushed),
  );
  const devInboxAfterPush = await devCh.call("check_inbox");
  check("tin đã push không bị giao trùng qua inbox", !devInboxAfterPush.text.includes("đổi mật khẩu"), devInboxAfterPush.text);
  const qaWeb = await qa2.call("check_inbox");
  check("qa (long-poll) nhận tin @all của user qua inbox", qaWeb.text.includes("đổi mật khẩu") && qaWeb.text.includes("user → @all"), qaWeb.text);

  // Channel mode: đang wait_for_messages thì trả qua tool, không push
  const w2 = devCh.call("wait_for_messages", { timeout_seconds: 10 });
  await sleep(300);
  await qa2.call("send_message", { to: "dev", content: "câu hỏi trong lúc dev đang chờ", type: "question" });
  const w2r = await w2;
  check("channel mode + đang wait → nhận qua tool", w2r.text.includes("câu hỏi trong lúc dev đang chờ"), w2r.text);
  check("… và không bị push trùng", !devCh.pushed.some((p) => p.content.includes("câu hỏi trong lúc")), JSON.stringify(devCh.pushed));

  const bad2 = await web.request({ op: "status", text: "x" });
  check("viewer không được đổi status", bad2.op === "error", JSON.stringify(bad2));

  // ---- Phase 4: bảng ticket (bước, bug, phân xử, ảnh, chống lặp) ----
  const HTTP = `http://127.0.0.1:${port}`;
  const board = async () => (await fetch(`${HTTP}/api/rooms/${room}/board`)).json();
  const tools4 = (await qa2.client.listTools()).tools.map((t) => t.name);
  check("bridge có report_bug, update_bug, get_board", ["report_bug", "update_bug", "get_board"].every((t) => tools4.includes(t)), tools4.join(","));
  await qa2.call("set_status", { text: "đang test TC-04", step: "B5" });
  await devCh.call("set_status", { text: "B3 · implement API" });
  let b = await board();
  const cur = (n) => b.steps.filter((s) => s.name === n).at(-1)?.step;
  check("set_status ghi bước (step param + parse từ text)", cur("qa") === "B5" && cur("dev") === "B3", JSON.stringify(b.steps));
  await devCh.call("send_message", { to: "qa", content: "[B4] App chạy ở http://localhost:8888" });
  b = await board();
  check("tin bắt đầu bằng [B4] cũng chuyển bước", cur("dev") === "B4", JSON.stringify(b.steps));

  const png = join(tmp, "shot.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const rb = await qa2.call("report_bug", {
    title: "Nút Lưu không disable khi form lỗi",
    severity: "high",
    tc: "TC-04",
    detail: "Bước: …\nExpected (AC2): disable\nActual: bấm được",
    screenshots: [png, "khong/ton/tai.png"],
  });
  check("report_bug tạo BUG-01, cảnh báo ảnh không tìm thấy", rb.text.includes("BUG-01") && rb.text.includes("khong/ton/tai.png"), rb.text);
  await sleep(200);
  // dev chạy channel mode → tin tới qua push
  const pushedText = () => devCh.pushed.map((p) => `[${p.meta.type}] ${p.meta.from} → ${p.meta.to}\n${p.content}`).join("\n---\n");
  const devBug = { text: pushedText() };
  const attUrl = devBug.text.match(/\((\/att\/[^)]+)\)/)?.[1];
  check("dev nhận bug_report có ảnh /att/…", devBug.text.includes("[bug_report]") && devBug.text.includes("BUG-01") && !!attUrl, devBug.text);
  const att = attUrl && (await fetch(`${HTTP}${attUrl}`));
  check("hub phục vụ ảnh đính kèm", att?.status === 200 && att.headers.get("content-type") === "image/png", String(att?.status));

  const d0 = await devCh.call("update_bug", { code: "BUG-01", status: "disputed" });
  check("phản biện thiếu note → lỗi", d0.isError && d0.text.includes("note"), d0.text);
  const bt = await devCh.call("update_bug", { code: "BUG-01", status: "verified" });
  check("chuyển trạng thái sai luồng → lỗi kèm luồng hợp lệ", bt.isError && bt.text.includes("Được phép"), bt.text);
  await devCh.call("update_bug", { code: "bug-1", status: "disputed", note: "AC2 không nói tới disable" });
  await qa2.call("update_bug", { code: "BUG-01", status: "open", note: "AC2 dòng 3: 'không cho lưu khi lỗi'" });
  await devCh.call("update_bug", { code: "BUG-01", status: "disputed", note: "Không cho lưu ≠ disable" });
  await qa2.call("update_bug", { code: "BUG-01", status: "open", note: "Vẫn bấm được và lưu" });
  const esc = await devCh.call("update_bug", { code: "BUG-01", status: "disputed", note: "lượt 3" });
  check("lượt tranh luận thứ 3 → hub tự chuyển need_user", esc.text.includes("chờ user phân xử"), esc.text);
  b = await board();
  check("board: BUG-01 need_user, rounds dev 2 qa 2", b.bugs[0]?.status === "need_user" && b.bugs[0].rounds.dev === 2 && b.bugs[0].rounds.qa === 2, JSON.stringify(b.bugs[0]));
  const qaEsc = await qa2.call("check_inbox");
  check("agent nhận tin từ hub: dừng tranh luận", qaEsc.text.includes("hub → @all") && qaEsc.text.includes("hết 2 lượt"), qaEsc.text);
  const locked = await qa2.call("update_bug", { code: "BUG-01", status: "rejected" });
  check("need_user: agent không đổi được", locked.isError && locked.text.includes("chờ user"), locked.text);
  const ps4 = await (await fetch(`${HTTP}/api/rooms/${room}/participants`)).json();
  check("user có cảnh báo 'chờ bạn phân xử'", ps4.find((p) => p.name === "user")?.attention?.includes("BUG-01"), JSON.stringify(ps4));
  const judge = await web.request({ op: "bug_update", code: "BUG-01", status: "open", note: "Là bug: AC2 nghĩa là phải chặn từ UI" });
  check("user (web) phân xử need_user → open", judge.op === "result" && judge.data.bug.status === "open" && judge.data.message.from === "user", JSON.stringify(judge));
  await sleep(200);
  const devJudge = { text: pushedText() };
  check("dev nhận kết luận của user", devJudge.text.includes("user phân xử") && devJudge.text.includes("AC2 nghĩa là"), devJudge.text);
  await devCh.call("update_bug", { code: "BUG-01", status: "fixed", note: "disable nút khi form invalid" });
  await qa2.call("update_bug", { code: "BUG-01", status: "verified" });
  const gb = await qa2.call("get_board");
  check("get_board: bảng markdown có tiến độ + BUG-01 Retest pass", gb.text.includes("**qa**: đang ở B5") && gb.text.includes("| BUG-01 | high | TC-04") && gb.text.includes("Retest pass"), gb.text);
  check("web nhận op board realtime", web.inbox.some((o) => o.op === "board" && o.board.bugs.some((x) => x.status === "verified")));
  const ps5 = await (await fetch(`${HTTP}/api/rooms/${room}/participants`)).json();
  check("hết bug chờ phân xử → xoá cảnh báo user", ps5.find((p) => p.name === "user")?.attention === null, JSON.stringify(ps5));

  // Chống lặp: HUB_IDLE_WARN=4 → 4 tin agent↔agent cảnh báo, 8 tin yêu cầu dừng, user nhắn thì reset
  for (let n = 0; n < 4; n++) await (n % 2 ? qa2 : devCh).call("send_message", { to: n % 2 ? "dev" : "qa", content: `qua lại ${n}` });
  b = await board();
  check("4 tin agent↔agent không tiến triển → board.warning", b.warning?.includes("4 tin") && b.idleChatter === 4, JSON.stringify(b.warning));
  for (let n = 4; n < 8; n++) await (n % 2 ? qa2 : devCh).call("send_message", { to: n % 2 ? "dev" : "qa", content: `qua lại ${n}` });
  await sleep(200);
  const hubMsgs = (await (await fetch(`${HTTP}/api/rooms/${room}/messages?limit=20`)).json()).filter((m) => m.from === "hub" && m.type !== "system");
  check("8 tin → hub yêu cầu dừng, tóm tắt cho user", hubMsgs.some((m) => m.content.includes("Dừng trao đổi qua lại") && m.to === "@all"), JSON.stringify(hubMsgs));
  await web.request({ op: "send", to: "@all", content: "ok để tôi xem" });
  b = await board();
  check("user nhắn → reset cảnh báo vòng lặp", b.warning === null && b.idleChatter === 0, JSON.stringify(b));
  await devCh.call("check_inbox");
  await qa2.call("check_inbox");

  // ---- Hooks (scripts/hook.mjs), chạy như Claude Code gọi ----
  const runHook = (event, name, input = {}, extraEnv = {}) =>
    new Promise((ok) => {
      const p = spawn(process.execPath, [join(root, "scripts/hook.mjs"), event], {
        env: { ...process.env, HUB_URL: `ws://127.0.0.1:${port}/ws`, HUB_ROOM: room, AGENT_NAME: name, HUB_CHANNEL: "0", ...extraEnv },
      });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => ok({ code, out, err }));
      p.stdin.end(JSON.stringify({ hook_event_name: event, ...input }));
    });
  const qaInfo = async () => (await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room}/participants`)).json()).find((p) => p.name === "qa");

  const s1 = await runHook("stop", "qa");
  check("Stop hook chặn kết thúc lượt (exit 2 + nhắc wait_for_messages)", s1.code === 2 && s1.err.includes("wait_for_messages"), JSON.stringify(s1));
  const s2 = await runHook("stop", "qa");
  check("Stop lần 2 liền mà không chờ → thả (chống vòng lặp)", s2.code === 0, JSON.stringify(s2));
  check("… và web thấy cảnh báo rời trực", (await qaInfo()).attention?.includes("rời chế độ trực"), JSON.stringify(await qaInfo()));
  await qa2.call("wait_for_messages", { timeout_seconds: 1 });
  check("sau khi gọi wait_for_messages thì cảnh báo được xoá", (await qaInfo()).attention === null, JSON.stringify(await qaInfo()));
  const s3 = await runHook("stop", "qa");
  check("đã quay lại trực → Stop lại bị chặn", s3.code === 2, JSON.stringify(s3));

  const waitP = qa2.call("wait_for_messages", { timeout_seconds: 20 });
  await sleep(300);
  check("web thấy qa đang chờ việc (waiting)", (await qaInfo()).waiting === true, JSON.stringify(await qaInfo()));
  await runHook("notify", "qa", { notification_type: "permission_prompt" });
  check("Notification permission_prompt → cảnh báo trên web", (await qaInfo()).attention?.includes("duyệt quyền"), JSON.stringify(await qaInfo()));
  await runHook("clear", "qa");
  check("PostToolUse → xoá cảnh báo", (await qaInfo()).attention === null, JSON.stringify(await qaInfo()));

  const t0 = Date.now();
  await web.request({ op: "duty", onDuty: false });
  const woke = await waitP;
  check("tắt trực trên web → wait_for_messages đang chờ trả về ngay", Date.now() - t0 < 3000 && woke.text.includes("TẮT chế độ trực"), woke.text);
  const s4 = await runHook("stop", "qa");
  check("tắt trực → Stop hook cho kết thúc lượt", s4.code === 0, JSON.stringify(s4));
  const rooms = await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();
  check("REST rooms có onDuty=false", rooms.find((r) => r.name === room)?.onDuty === false, JSON.stringify(rooms));
  await web.request({ op: "duty", onDuty: true });

  const s5 = await runHook("stop", "qa", {}, { HUB_ROOM: "" });
  check("session không thuộc team (thiếu HUB_ROOM) → hook không làm gì", s5.code === 0 && !s5.err, JSON.stringify(s5));
  const s6 = await runHook("stop", "qa", {}, { HUB_URL: "ws://127.0.0.1:1/ws" });
  check("hub không chạy → hook không cản session", s6.code === 0, JSON.stringify(s6));
  const s7 = await runHook("session", "qa", { source: "compact" });
  check("SessionStart (compact) nhắc gọi get_summary", s7.code === 0 && s7.out.includes("get_summary"), JSON.stringify(s7));

  // ---- Phase 5: tóm tắt phòng, báo cáo B7, đóng / mở lại ticket ----
  const tools5 = (await qa2.client.listTools()).tools.map((t) => t.name);
  check("bridge có get_summary, submit_report", ["get_summary", "submit_report"].every((t) => tools5.includes(t)), tools5.join(","));
  await qa2.call("report_bug", { title: "Thiếu thông báo lỗi khi sai mật khẩu", tc: "TC-07", detail: "Expected (AC3): hiện lỗi" });
  await sleep(100);
  const sumDev = await devCh.call("get_summary");
  check(
    "get_summary (dev): thông tin, thành viên, bug, việc của mình, tin gần đây",
    ["Tóm tắt phòng", "## Thành viên", "**qa**", "BUG-02", "## Việc của bạn (dev)", "→ fix rồi update_bug fixed", "tin gần nhất"].every((x) => sumDev.text.includes(x)),
    sumDev.text,
  );
  await devCh.call("update_bug", { code: "BUG-02", status: "fixed", note: "thêm message lỗi" });
  const sumQa = await qa2.call("get_summary");
  check("get_summary (qa): BUG-02 chờ retest", sumQa.text.includes("## Việc của bạn (qa)") && /BUG-02.*retest/.test(sumQa.text), sumQa.text);
  await qa2.call("update_bug", { code: "BUG-02", status: "verified" });

  const viaSend = await qa2.call("send_message", { to: "user", type: "report", content: "x" });
  check("send_message không nhận type report (phải dùng submit_report)", viaSend.isError, viaSend.text);
  const REPORT = "## Tổng kết TL-9\n**Kết quả:** ✅ Đạt\n\n| Bug | Trạng thái |\n|---|---|\n| BUG-01 | Retest pass |";
  const sr = await qa2.call("submit_report", { content: REPORT });
  check("submit_report → phiên bản 1", !sr.isError && sr.text.includes("phiên bản 1"), sr.text);
  await sleep(150);
  b = await board();
  check(
    "board.report do qa gửi, qa sang B7",
    b.report?.author === "qa" && b.report.content === REPORT && b.steps.filter((s) => s.name === "qa").at(-1)?.step === "B7",
    JSON.stringify(b.report),
  );
  check("web nhận tin type report gửi user", web.inbox.some((o) => o.op === "message" && o.message.type === "report" && o.message.to === "user"));
  const ps6 = await (await fetch(`${HTTP}/api/rooms/${room}/participants`)).json();
  check("user có cảnh báo 'báo cáo chờ duyệt'", ps6.find((p) => p.name === "user")?.attention?.includes("Báo cáo B7"), JSON.stringify(ps6));

  const postJson = async (sub, body = {}) => {
    const r = await fetch(`${HTTP}/api/rooms/${room}/${sub}`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const edited = await postJson("report", { content: REPORT + "\n\nuser sửa" });
  check("user sửa báo cáo trên web → phiên bản 2", edited.status === 200 && edited.data.author === "user" && (await board()).reportVersions === 2, JSON.stringify(edited));
  const md = await fetch(`${HTTP}/api/rooms/${room}/report.md`);
  check("tải report.md = phiên bản mới nhất", md.status === 200 && (await md.text()).endsWith("user sửa"));

  const waitClose = qa2.call("wait_for_messages", { timeout_seconds: 20 });
  await sleep(300);
  const t1 = Date.now();
  const cl = await postJson("close");
  const wc = await waitClose;
  check("đóng ticket → wait_for_messages trả về ngay, kèm tin 🏁 dừng việc", Date.now() - t1 < 3000 && wc.text.includes("đóng ticket.**"), wc.text);
  check("close trả board có closedAt", cl.status === 200 && !!cl.data.closedAt, JSON.stringify(cl));
  await sleep(150);
  check("dev nhận tin 🏁 từ hub", pushedText().includes("đóng ticket.**"), pushedText().slice(-300));
  const r5 = (await (await fetch(`${HTTP}/api/rooms`)).json()).find((r) => r.name === room);
  check("REST rooms: closedAt + tắt trực", !!r5?.closedAt && r5.onDuty === false, JSON.stringify(r5));
  const wc2 = await qa2.call("wait_for_messages", { timeout_seconds: 5 });
  check("gọi lại wait_for_messages khi ticket đã đóng → bảo kết thúc lượt", wc2.text.includes("ĐÓNG ticket"), wc2.text);
  const s8 = await runHook("stop", "qa");
  check("ticket đóng → Stop hook cho kết thúc lượt", s8.code === 0, JSON.stringify(s8));
  const sumUser = await (await fetch(`${HTTP}/api/rooms/${room}/summary`)).text();
  check(
    "summary REST (user): ĐÃ ĐÓNG + báo cáo phiên bản 2, không có mục 'Việc của bạn'",
    sumUser.includes("ĐÃ ĐÓNG") && sumUser.includes("Phiên bản 2") && !sumUser.includes("Việc của bạn"),
    sumUser,
  );
  check("hub không có API đăng Backlog", (await postJson("backlog")).status === 404);
  const ro = await postJson("reopen");
  const r6 = (await (await fetch(`${HTTP}/api/rooms`)).json()).find((r) => r.name === room);
  check("mở lại ticket → hết closedAt, bật trực", ro.status === 200 && ro.data.closedAt === null && r6?.onDuty === true, JSON.stringify(ro));
  check("summary phòng không tồn tại → 404", (await fetch(`${HTTP}/api/rooms/khong-co/summary`)).status === 404);

  // ---- Tin user gửi giữa lúc agent đang làm việc dài ----
  await qa2.call("check_inbox");
  await web.request({ op: "send", to: "qa", content: "đổi ý: test thêm case mobile" });
  await sleep(200);
  const p1 = await runHook("post", "qa", { tool_name: "Bash" });
  const ctx = p1.out ? JSON.parse(p1.out).hookSpecificOutput?.additionalContext ?? "" : "";
  check("PostToolUse chèn tin user mới vào context", ctx.includes("đổi ý: test thêm case mobile"), JSON.stringify(p1));
  const p2 = await runHook("post", "qa", { tool_name: "Bash" });
  check("… mỗi tin chỉ chèn một lần", !p2.out, JSON.stringify(p2));
  const sm = await qa2.call("send_message", { to: "dev", content: "xong phần desktop" });
  check("tin kèm vào kết quả send_message được đánh dấu 'đọc kỹ, trả lời trước'", sm.text.includes("TRƯỚC khi làm tiếp") && sm.text.includes("đổi ý"), sm.text);
  await sleep(150);
  const s9 = await runHook("stop", "qa");
  check("Stop hook chặn khi còn tin user chưa phản hồi", s9.code === 2 && s9.err.includes("chưa được xử lý") && s9.err.includes("đổi ý"), JSON.stringify(s9));
  const again = await qa2.call("wait_for_messages", { timeout_seconds: 5 });
  check("wait_for_messages nhắc lại tin chưa phản hồi ngay", again.text.includes("CHƯA phản hồi") && again.text.includes("đổi ý"), again.text);
  await qa2.call("send_message", { to: "user", content: "ok, thêm case mobile" });
  const s10 = await runHook("stop", "qa");
  check("đã trả lời → Stop hook về luật trực bình thường", s10.code === 2 && !s10.err.includes("chưa được xử lý"), JSON.stringify(s10));

  // ---- Agent chạy ngầm trên hub: xem terminal trên web, đánh thức khi user nhắn ----
  const evil = await fetch(`${HTTP}/api/rooms/${room}/agents`, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" });
  check("trang web lạ không gọi được API chạy agent (origin)", evil.status === 403);
  const evilWs = await new Promise((ok) => {
    const w = new WsClient(`ws://127.0.0.1:${port}/ws`, { headers: { origin: "http://evil.example" } });
    w.onopen = () => ok("open");
    w.onerror = () => ok("rejected");
  });
  check("trang web lạ không mở được WebSocket", evilWs === "rejected", evilWs);
  const started = await postJson("agents", { launch: { repoDir: tmp }, names: ["qa"] });
  const qaTerm = started.data.find?.((t) => t.name === "qa");
  check("POST agents → qa chạy ngầm", started.status === 200 && qaTerm?.running, JSON.stringify(started));
  check("web nhận danh sách terminal", web.inbox.some((o) => o.op === "terms" && o.terms.some((t) => t.name === "qa" && t.running)));
  await web.request({ op: "term_attach", name: "qa", cols: 100, rows: 30 });
  const termText = () => web.inbox.filter((o) => (o.op === "term_data" || o.op === "term_snapshot") && o.name === "qa").map((o) => o.data).join("");
  for (let i = 0; i < 50 && !termText().includes("FAKE READY"); i++) await sleep(100);
  check("xem terminal: thấy output của agent", termText().includes("FAKE READY"), JSON.stringify(termText().slice(0, 600)));
  web.ws.send(JSON.stringify({ op: "term_input", name: "qa", data: "xin chao\r" }));
  for (let i = 0; i < 30 && !termText().includes("GOT: xin chao"); i++) await sleep(100);
  check("gõ từ web vào terminal", termText().includes("GOT: xin chao"), JSON.stringify(termText().slice(-200)));

  await postJson("close");
  await qa2.call("check_inbox");
  const s11 = await runHook("stop", "qa");
  check("ticket đóng (đã duyệt) → agent nghỉ ở prompt", s11.code === 0 && (await qaInfo()).idle === true, JSON.stringify(await qaInfo()));
  await web.request({ op: "send", to: "qa", content: "hỏi thêm: case mobile ra sao?" });
  for (let i = 0; i < 40 && !termText().includes("GOT: [team-hub] Có tin mới từ user"); i++) await sleep(100);
  check("user nhắn agent đang nghỉ → hub gõ vào terminal đánh thức", termText().includes("GOT: [team-hub] Có tin mới từ user") && termText().includes("kết thúc lượt"), JSON.stringify(termText().slice(-300)));
  check("… agent hết trạng thái nghỉ", (await qaInfo()).idle === false, JSON.stringify(await qaInfo()));
  web.ws.send(JSON.stringify({ op: "term_detach", name: "qa" }));
  await sleep(100);
  const listed = await (await fetch(`${HTTP}/api/rooms/${room}/agents`)).json();
  check("ẩn terminal trên web → agent vẫn chạy ngầm", listed.find((t) => t.name === "qa")?.running === true, JSON.stringify(listed));
  const stopped = await web.request({ op: "agent_stop", name: "qa" });
  await sleep(500);
  const listed2 = await (await fetch(`${HTTP}/api/rooms/${room}/agents`)).json();
  check("tắt agent từ web", stopped.op === "result" && listed2.find((t) => t.name === "qa")?.running === false, JSON.stringify(listed2));

  web.ws.close();
  await devCh.client.close();
  await qa2.client.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  hub.kill();
  setTimeout(() => rmSync(tmp, { recursive: true, force: true }), 300);
}

console.log(failed ? `\n${failed} check FAILED` : "\nTất cả check PASS");
process.exitCode = failed ? 1 : 0;
