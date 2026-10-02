// Smoke test cho tcm: init → start (tự khởi động hub, lưu meta, dry-run wt, chờ agent, gửi kickoff) → status → stop.
// Chạy: node scripts/smoke-tcm.mjs   (cần `npm run build` trước). Dùng port + DB tạm, không đụng hub thật.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 5100 + Math.floor(Math.random() * 90); // tránh 4747 (hub thật)
const tmp = mkdtempSync(join(tmpdir(), "tcm-"));
const repo = join(tmp, "repo");
const env = { ...process.env, HUB_PORT: String(port), HUB_DB: join(tmp, "hub.db"), HUB_LOG: join(tmp, "hub.log"), TCM_LOG: join(tmp, "tcm.log") };
const HUB = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tcm = (...args) => tcmIn(repo, ...args);
function tcmIn(dir, ...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(root, "scripts/tcm.mjs"), ...args, "--cwd", dir], { env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code, out }));
  });
}

let failed = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${cond ? "" : `\n    ${extra}`}`);
  if (!cond) failed++;
};

async function fakeAgent(name, room = "TL-1") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got = [];
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  ws.onmessage = (e) => {
    const op = JSON.parse(e.data);
    if (op.op === "message") got.push(op.message);
    if (op.op === "welcome") got.push(...op.unread);
  };
  ws.send(JSON.stringify({ op: "hello", kind: "agent", room, name, role: name }));
  await sleep(200);
  ws.send(JSON.stringify({ op: "waiting", waiting: true }));
  return { ws, got };
}

try {
  (await import("node:fs")).mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  (await import("node:fs")).mkdirSync(join(repo, ".git", "info"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "exclude"), "# git ls-files --others --exclude-from=.git/info/exclude\n");

  const i = await tcm("init");
  check("tcm init tạo .team-hub.json + .team-hub.local.json", i.code === 0 && existsSync(join(repo, ".team-hub.json")) && existsSync(join(repo, ".team-hub.local.json")), i.out);
  const excl = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  check("init thêm file cá nhân vào .git/info/exclude",
    [".team-hub.json", ".team-hub.local.json", "docs/plan/", "qa/testcases/", "qa/runs/", ".vscode/tasks.json"].every((e) => excl.includes(e)), excl);
  check("init KHÔNG sửa .gitignore", readFileSync(join(repo, ".gitignore"), "utf8") === "node_modules\n");
  const cfg = JSON.parse(readFileSync(join(repo, ".team-hub.json"), "utf8"));
  cfg.figma = "https://www.figma.com/design/ABC/x?node-id=1-2";
  cfg.agents.dev.model = "sonnet";
  writeFileSync(join(repo, ".team-hub.json"), JSON.stringify(cfg));

  const startP = tcm("start", "TL-1", "--dry-run", "--no-open", "--notes", "chỉ màn login");
  // chờ hub do tcm khởi động
  for (let k = 0; k < 40; k++) {
    await sleep(250);
    try {
      if ((await fetch(`${HUB}/api/health`)).ok) break;
    } catch {}
  }
  let meta = {};
  for (let k = 0; k < 40 && !meta.ticket; k++) {
    await sleep(250);
    meta = await (await fetch(`${HUB}/api/rooms/TL-1/meta`)).json();
  }
  check("start lưu meta (figma từ config, tài khoản từ .local, notes từ CLI)",
    meta.figma === cfg.figma && meta.testAccount === "100000 / Password_1" && meta.notes === "chỉ màn login" && meta.appUrl === "http://localhost:8888",
    JSON.stringify(meta));
  const dev = await fakeAgent("dev");
  const qa = await fakeAgent("qa");
  const s = await startP;
  check("start chạy xong (exit 0)", s.code === 0, s.out);
  check("dry-run in lệnh wt với 2 pane DEV | QA", /wt\.exe -w tcm-TL-1 new-tab .*DEV · TL-1.* ; split-pane -V .*QA · TL-1/.test(s.out), s.out);
  check("pane DEV có --model sonnet, QA có -NoBrowser", s.out.includes("-Model sonnet") && s.out.includes("-NoBrowser"), s.out);
  check("cả 2 pane chạy với -SkipPermissions", (s.out.match(/-SkipPermissions/g) || []).length === 2, s.out);
  check("start không thêm trùng dòng exclude", readFileSync(join(repo, ".git", "info", "exclude"), "utf8") === excl);
  check("start báo đã gửi kickoff", s.out.includes("đã gửi kickoff"), s.out);
  await sleep(300);
  const k = dev.got.find((m) => m.content.includes("Kickoff ticket TL-1"));
  check("agent nhận kickoff @all từ user", k && k.from === "user" && k.to === "@all" && qa.got.some((m) => m.id === k.id), JSON.stringify(dev.got));
  check("kickoff có Figma, tài khoản test, ghi chú, đường dẫn file",
    k && k.content.includes(cfg.figma) && k.content.includes("100000 / Password_1") && k.content.includes("chỉ màn login") && k.content.includes("qa/testcases/TL-1.md"),
    k?.content);

  const st = await tcm("status");
  check("tcm status liệt kê phòng + agent", st.out.includes("#TL-1") && st.out.includes("dev·chờ"), st.out);
  const sp = await tcm("stop", "TL-1");
  const rooms = await (await fetch(`${HUB}/api/rooms`)).json();
  check("tcm stop tắt chế độ trực", sp.code === 0 && rooms.find((r) => r.name === "TL-1")?.onDuty === false, sp.out + JSON.stringify(rooms));

  // ---- Phase 5: close, resume ----
  check("start lưu đường dẫn repo vào meta", meta.repoDir === resolve(repo), JSON.stringify(meta));
  await fetch(`${HUB}/api/rooms/TL-1/report`, { method: "POST", body: JSON.stringify({ content: "## Tổng kết TL-1\nĐạt" }) });
  const cl = await tcm("close", "TL-1");
  check("tcm close: đóng ticket, báo có báo cáo B7", cl.code === 0 && cl.out.includes("đã đóng ticket") && cl.out.includes("phiên bản 1"), cl.out);
  const st2 = await tcm("status");
  check("tcm status hiện phòng đã đóng", /#TL-1 .* đóng/.test(st2.out), st2.out);

  const rs = await tcmIn(tmp, "resume", "TL-1", "--dry-run", "--no-open");
  check("tcm resume ngoài repo → dùng repo đã lưu", rs.code === 0 && rs.out.includes("repo đã lưu"), rs.out);
  check("resume in tóm tắt phòng (trạng thái đóng, báo cáo)", rs.out.includes("Tóm tắt phòng") && rs.out.includes("ĐÃ ĐÓNG") && rs.out.includes("Phiên bản 1"), rs.out);
  check("resume mở lại ticket + 2 pane chạy -Resume", rs.out.includes("mở lại") && (rs.out.match(/-Resume/g) || []).length === 2 && rs.out.includes(`-d ${repo}`), rs.out);
  const r1 = (await (await fetch(`${HUB}/api/rooms`)).json()).find((r) => r.name === "TL-1");
  check("sau resume: hết closedAt, bật trực", r1.closedAt === null && r1.onDuty === true, JSON.stringify(r1));
  const nope = await tcm("resume", "KHONG-CO");
  check("resume phòng không tồn tại → gợi ý tcm start", nope.code === 1 && nope.out.includes("tcm start KHONG-CO"), nope.out);
  const vs = await tcm("vscode");
  const tasks = JSON.parse(readFileSync(join(repo, ".vscode", "tasks.json"), "utf8")).tasks;
  check("tcm vscode có task resume ticket (DEV/QA chạy -Resume)", vs.code === 0 && tasks.some((t) => t.label === "tcm: resume ticket") && tasks.find((t) => t.label === "tcm: DEV (resume)")?.command.includes("-Resume") && !tasks.find((t) => t.label === "tcm: DEV").command.includes("-Resume"), JSON.stringify(tasks.map((t) => t.label)));

  const bad = await tcm("start", "bad room!");
  check("tên phòng không hợp lệ → báo lỗi", bad.code === 1 && bad.out.includes("không hợp lệ"), bad.out);

  const web = await fetch(`${HUB}/api/rooms/TL-1/kickoff`, { method: "POST", body: JSON.stringify({ meta: { ticket: "" } }) });
  check("API kickoff thiếu ticket → 400", web.status === 400);
  // Mặc định (không --wait): trả terminal ngay, kickoff gửi ngầm khi agent online
  const t0 = Date.now();
  const bg = await tcm("start", "TL-2", "--dry-run", "--no-open");
  check("start trả về ngay", bg.code === 0 && Date.now() - t0 < 8000 && bg.out.includes("đã gửi kickoff"), bg.out);
  const dev2 = await fakeAgent("dev", "TL-2");
  const qa2 = await fakeAgent("qa", "TL-2");
  let k2;
  for (let n = 0; n < 40 && !k2; n++) {
    await sleep(250);
    k2 = qa2.got.find((m) => m.content.includes("Kickoff ticket TL-2"));
  }
  check("agent vào phòng SAU vẫn nhận kickoff (tin chưa đọc)", !!k2 && k2.content.includes("100000 / Password_1"), JSON.stringify(qa2.got));
  dev2.ws.close();
  qa2.ws.close();

  dev.ws.close();
  qa.ws.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  // tắt hub tạm do tcm khởi động
  spawn("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -EA 0 | % { Stop-Process -Id $_.OwningProcess -Force }`], { stdio: "ignore" }).on("close", () =>
    setTimeout(() => rmSync(tmp, { recursive: true, force: true }), 500),
  );
}
console.log(failed ? `\n${failed} check FAILED` : "\nTất cả check PASS");
process.exitCode = failed ? 1 : 0;
