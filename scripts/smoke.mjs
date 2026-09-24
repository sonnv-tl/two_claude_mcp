// Smoke test end-to-end: hub + 2 bridge (dev, qa) nói chuyện qua MCP tools.
// Chạy: node scripts/smoke.mjs   (cần `npm run build` trước)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 4800 + Math.floor(Math.random() * 100);
const tmp = mkdtempSync(join(tmpdir(), "tcm-smoke-"));
const room = "smoke";

const hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "packages/hub/dist/index.js")], {
  env: { ...process.env, HUB_PORT: String(port), HUB_DB: join(tmp, "hub.db") },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ok) => hub.stdout.on("data", (d) => String(d).includes("[hub] http") && ok()));

async function agent(name) {
  const client = new Client({ name: `smoke-${name}`, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "packages/bridge/dist/index.js")],
      env: { ...process.env, HUB_URL: `ws://127.0.0.1:${port}/ws`, HUB_ROOM: room, AGENT_NAME: name, AGENT_ROLE: name },
      stderr: "ignore",
    }),
  );
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

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

  // REST cho web
  const hist = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room}/messages`)).json();
  check("REST history có đủ tin", hist.filter((m) => m.type !== "system").length === 4, JSON.stringify(hist.map((m) => m.content)));

  await dev.client.close();
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
