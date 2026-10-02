#!/usr/bin/env node
// Claude Code hook → team hub. Nạp qua hooks/team-settings.json (claude-as.sh / .ps1 tự thêm --settings).
//   node hook.mjs stop     Stop hook: giữ agent ở chế độ trực (exit 2 = chặn kết thúc lượt)
//   node hook.mjs notify   Notification hook: báo "đang chờ duyệt quyền" lên web
//   node hook.mjs clear    PostToolUse / UserPromptSubmit: xoá cảnh báo
//   node hook.mjs session  SessionStart (compact/resume): nhắc lại bối cảnh phòng
// Không phải session team (thiếu HUB_ROOM / AGENT_NAME) hoặc hub không chạy → không làm gì (exit 0).

const event = process.argv[2];
const room = process.env.HUB_ROOM;
const name = process.env.AGENT_NAME;
if (!room || !name || !event) process.exit(0);

const base = (process.env.HUB_URL || "ws://127.0.0.1:4747/ws").replace(/^ws/, "http").replace(/\/ws\/?$/, "");

function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    const t = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on("error", done);
  });
}

const input = await readStdin();

if (event === "session") {
  // stdout của SessionStart được thêm vào context của Claude
  const duty = process.env.HUB_CHANNEL === "1" ? "" : " Bạn đang ở CHẾ ĐỘ TRỰC: xong việc thì gọi wait_for_messages, đừng kết thúc lượt.";
  console.log(
    `[team-hub] Bạn là "${name}" trong phòng "${room}". Context vừa được nén/khôi phục: ` +
      `gọi get_summary để nắm lại tiến độ (bước B1–B7, bug đang mở, việc của bạn) trước khi làm tiếp, cần chi tiết thì get_history.${duty}`,
  );
  process.exit(0);
}

// Chế độ channel: tin được đẩy vào session, không cần giữ agent lại
if (event === "stop" && process.env.HUB_CHANNEL === "1") process.exit(0);

let res = {};
try {
  const r = await fetch(`${base}/api/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, room, name, input }),
    signal: AbortSignal.timeout(3000),
  });
  if (r.ok) res = await r.json();
} catch {
  process.exit(0); // hub không chạy → không cản trở session
}

if (event === "stop" && res.block) {
  process.stderr.write(res.reason || "Gọi wait_for_messages để tiếp tục trực.");
  process.exit(2);
}
process.exit(0);
