# Team Hub: nhiều Claude session làm việc cùng nhau

MCP hub cho phép nhiều Claude Code session (ví dụ **DEV** và **QA**) nhắn tin, phối hợp với nhau trên cùng một repo. Có web để theo dõi toàn bộ hội thoại.

```
Claude (DEV) ─stdio─ bridge ─┐
                             ├─ WebSocket ─► HUB (http + ws + SQLite) ◄─ Web UI (React)
Claude (QA)  ─stdio─ bridge ─┘
```

- `packages/hub`: server trung tâm, route tin nhắn, lưu SQLite (`data/hub.db`), serve web ở `http://127.0.0.1:4747`.
- `packages/bridge`: MCP server stdio. Mỗi Claude session spawn một bridge riêng, bridge cung cấp tools và persona.
- `packages/web`: web UI theo dõi phòng và chat với team (gửi `@all` hoặc riêng từng người).
- `packages/shared`: kiểu dữ liệu và giao thức dùng chung.

## Cài đặt

```powershell
cd C:\laragon\www\two_claude_mcp
npm install
npm run build
npm run smoke        # test end-to-end: hub + 2 bridge + hooks
npm run smoke:tcm    # test CLI tcm
```

## Dùng hàng ngày: `tcm`

Cài alias một lần (WSL): `echo "alias tcm='bash /mnt/c/laragon/www/two_claude_mcp/scripts/tcm'" >> ~/.bashrc`
(PowerShell/cmd: thêm `C:\laragon\www\two_claude_mcp\scripts` vào PATH để gọi `tcm`.)

```bash
cd ~/thankslab-portal
tcm init                              # một lần mỗi repo: tạo .team-hub.json + .team-hub.local.json, thêm file của tcm/agent vào .git/info/exclude
tcm start TLPORTAL-10182              # hub → cửa sổ Windows Terminal mới chia đôi DEV | QA → web; gửi kickoff ngay (hub giữ tin, DEV/QA nhận khi vào phòng)
tcm start TLPORTAL-10182 --figma "https://www.figma.com/design/…" --notes "chỉ làm màn list"
tcm start TLPORTAL-10182 --manual     # không tự gửi, bấm 🎫 Kickoff trên web
tcm status                            # các phòng, agent đang chờ / đang làm / ⚠ / đã đóng
tcm stop TLPORTAL-10182               # tắt chế độ trực
tcm resume TLPORTAL-10182             # vào lại ticket làm dở (hôm sau, sau khi tắt máy…): in tóm tắt phòng, mở lại DEV | QA
tcm close TLPORTAL-10182              # đóng ticket (giữ báo cáo B7), agent dừng việc
```

**Vào lại ticket (`tcm resume`)**: chạy ở đâu cũng được (dùng repo mà `tcm start` đã lưu). Lệnh in tóm tắt phòng (ai đang ở bước nào, bug, câu hỏi chờ bạn, báo cáo B7, tin gần đây), mở lại phòng nếu đã đóng, bật trực, rồi mở DEV | QA với session **mới**: mỗi agent gọi `get_summary`, đọc lại plan / test case, báo bạn đang ở đâu rồi làm tiếp. Tin gửi cho agent lúc nó offline vẫn được giao khi vào lại.

`.team-hub.json` và `.team-hub.local.json` (gộp đè lên file chính, dùng cho tài khoản test):
```json
{
  "figma": "https://www.figma.com/design/…?node-id=…",
  "app": { "run": "npm run dev", "url": "http://localhost:8888" },
  "paths": { "plan": "docs/plan", "testcases": "qa/testcases", "runs": "qa/runs" },
  "notes": "",
  "agents": {
    "dev": { "model": "", "skipPermissions": true },
    "qa":  { "model": "sonnet", "skipPermissions": true, "browser": false }
  }
}
```
- `.team-hub.local.json`: `{ "testAccount": "100000 / Password_1" }`.
- `"browser": false`: QA dùng browser MCP có sẵn của project (vd. `playwright`).
- `"skipPermissions"`: mặc định bật. Session chạy với `--dangerously-skip-permissions`, agent chạy lệnh và sửa file **không hỏi duyệt**. Đặt `false` để tắt riêng cho từng agent. Chạy tay thì dùng `SKIP_PERMISSIONS=1` (bash) hoặc `-SkipPermissions` (PowerShell).
- **Không đụng `.gitignore`:** `tcm init`, `tcm start` và `tcm vscode` ghi vào `.git/info/exclude` (chỉ có trên máy bạn, không bị commit) các mục `.team-hub*.json`, `.vscode/tasks.json`, thư mục plan, test case, kết quả test, `qa/screenshots/`, `.playwright-mcp/`.

**Trong VS Code (2 terminal chia đôi, không cần cửa sổ ngoài):** chạy `tcm vscode` trong repo một lần (chạy lại sau mỗi lần cập nhật tcm). Lệnh này thêm task vào `.vscode/tasks.json`. Sau đó dùng `Ctrl+Shift+P` → *Tasks: Run Task* → **tcm: start ticket** (vào lại ticket làm dở: **tcm: resume ticket**) → nhập mã ticket và link Figma (để trống = dùng link trong `.team-hub.json`, hoặc link trong ticket nếu config không có). Panel Terminal có DEV | QA chia đôi, web mở ở trình duyệt, kickoff được gửi ngay, task kickoff tự đóng terminal của nó. Repo trong WSL thì mở VS Code bằng Remote-WSL (`code .` từ WSL). Gán phím tắt: *Keyboard Shortcuts* → `workbench.action.tasks.runTask` với args `"tcm: start ticket"`.

**Form 🎫 Kickoff trên web:** điền sẵn thông tin `tcm start` đã lưu. Bạn sửa Figma, tài khoản test, ghi chú, xem trước tin rồi gửi cho `@all`.

## Chi tiết / chạy tay

1. **Chạy hub**. Nên cài chạy nền một lần, hub sẽ tự khởi động mỗi khi đăng nhập Windows:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\hub-service.ps1 install   # status | restart | uninstall
   ```
   Hoặc chạy tay (để terminal mở): `npm run hub`. Sau mỗi lần `npm run build`, chạy `hub-service.ps1 restart`. Web: http://127.0.0.1:4747

2. **Cấu hình MCP `team-hub`**: dùng `examples/.mcp.json`, đặt ở repo đích hoặc ở scope user. Tên, vai trò và phòng lấy từ biến môi trường do script đặt. Session **không** mở qua script (không có `HUB_ROOM`) thì bridge ở **chế độ nghỉ**: không vào phòng, không có tool. Cài ở scope user cũng không ảnh hưởng các session thường.

   **Hooks** (`hooks/team-settings.json`, script tự nạp qua `--settings`, tắt bằng `NO_HOOKS=1` / `-NoHooks`):
   - *Stop hook*: giữ agent ở chế độ trực. Agent định kết thúc lượt thì bị nhắc gọi `wait_for_messages`. Nếu agent kết thúc lượt 2 lần liền mà không chịu chờ, hook thả nó ra và web báo "đã rời chế độ trực". Nút **● Đang trực / ○ Nghỉ trực** trên web cho agent kết thúc lượt khi xong việc.
   - *Notification hook*: agent kẹt ở bước xin quyền trong terminal thì web hiện ⚠️, phát âm thanh, và gửi thông báo desktop khi tab web không mở.
   - *SessionStart (compact/resume)*: nhắc agent đọc lại lịch sử phòng sau khi context bị nén.
   - Allowlist: tool hub, browser, các tool **đọc** của figma-console, lệnh git chỉ đọc. **Chặn** Figma MCP chính thức (`mcp__claude_ai_Figma`) để tránh tốn hạn mức. Muốn dùng lại thì xoá mục `deny`.

   **Figma**: agent xem design bằng **figma-console (Desktop Bridge)**. Thêm dòng `Figma: <link>` vào tin kickoff để dùng link đó thay cho link trong ticket (xem `examples/kickoff.md`). Trước khi kickoff: mở file trong Figma Desktop và chạy plugin Desktop Bridge. Cả DEV và QA đều tự xem design trên link. Kickoff cũng gửi tài khoản test (dòng `Tài khoản test:`), agent không ghi mật khẩu vào file.

3. **Mở 2 terminal trong repo đích**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role dev -Room login-feature
   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role qa  -Room login-feature
   ```
   Lần đầu Claude Code sẽ hỏi có tin tưởng MCP server trong `.mcp.json` không: chọn đồng ý. 

   Mặc định script dùng **long-poll ở chế độ trực**: agent luôn đứng chờ trong `wait_for_messages`, nên tin từ web hoặc từ đồng đội đánh thức nó ngay. Nếu org của bạn đã bật channels (`channelsEnabled`), thêm `-Channel` (PowerShell) hoặc `CHANNEL=1` (bash) để đẩy tin thẳng vào session qua Claude Code channels. Với QA, script nạp thêm Playwright MCP (`examples/qa-browser.mcp.json`) để test trên browser thật. Tắt bằng `-NoBrowser` hoặc `NO_BROWSER=1`.

   **Trong WSL / Git Bash**:
   ```bash
   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh dev test-feature
   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh qa  test-feature
   ```
   Nếu `claude` trong WSL là bản Windows (`claude.exe`, cài qua npm phía Windows), biến môi trường phải được khai báo trong `WSLENV` thì mới sang được phía Windows. Script đã làm việc này. Tự gõ tay thì như sau:
   ```bash
   export AGENT_ROLE=qa AGENT_NAME=qa HUB_ROOM=test-feature MCP_TOOL_TIMEOUT=900000
   export WSLENV=AGENT_ROLE:AGENT_NAME:HUB_ROOM:HUB_URL:MCP_TOOL_TIMEOUT
   claude "Vào chế độ trực: gọi wait_for_messages, xử lý việc, rồi lặp lại" \
          --mcp-config 'C:\laragon\www\two_claude_mcp\examples\qa-browser.mcp.json'
   ```
   Hub vẫn chạy phía Windows (`npm run hub` trong PowerShell).

4. **Giao việc từ web**: ở ô chat chọn `@all` (hoặc gõ `@qa ...` / `@dev ...` ở đầu tin để gửi riêng), dán yêu cầu kèm Acceptance Criteria rồi Enter. DEV nhận phần implement + unit test, QA nhận phần test case + test trên browser, hai bên tự phối hợp. Di chuột vào một tin và bấm "trả lời" để trả lời tin đó.

## Tools mà mỗi session có

| Tool | Mô tả |
|---|---|
| `send_message(to, content, type?, reply_to?)` | Gửi tới `dev` / `qa` / `user` / `@all` |
| `wait_for_messages(timeout_seconds?)` | Chờ tin mới (long-poll, tối đa 600s) |
| `check_inbox()` | Xem tin mới, không chờ |
| `get_history(limit?, before_id?)` | Lịch sử phòng |
| `list_participants()` | Ai đang online, đang làm gì |
| `set_status(text, step?)` | Trạng thái + bước B1–B7 hiển thị trên web |
| `report_bug(title, detail, severity?, tc?, to?, screenshots?)` | Tạo BUG-xx trên bảng bug + gửi bug_report cho DEV |
| `update_bug(code, status, note?, screenshots?)` | Đổi trạng thái bug (fixed, disputed, verified, reopened, rejected…) |
| `get_board()` | Tiến độ + bảng bug dạng markdown (số liệu cho B7) |
| `get_summary()` | Tóm tắt phòng khi vào / vào lại: thông tin ticket, bước của từng người, bug, việc tồn đọng của mình, câu hỏi chờ user, 15 tin gần nhất |
| `submit_report(content, screenshots?)` | B7: gửi user báo cáo tổng kết chung, hub lưu thành báo cáo của ticket (gửi lại = phiên bản mới) |

Ở chế độ channel, tin được đẩy vào session dưới dạng `<channel source="team-hub" from=... type=... msg_id=...>`. Ở cả hai chế độ, tin chưa đọc cũng được **đính kèm vào kết quả của mọi tool** hub. Các loại tin: `chat`, `question`, `ac_deviation`, `test_case`, `bug_report`, `handoff`, `report` (chỉ qua `submit_report`).

Persona mặc định nằm trong `packages/bridge/src/personas.ts`. **DEV**: source + unit/integration test, chạy app và báo URL cho QA. **QA**: không viết unit test; viết test case nghiệp vụ vào `qa/testcases/`, soát code để báo lệch AC sớm, chạy test case trên browser thật, ghi kết quả vào `qa/runs/`, báo bug kèm screenshot. Có thể override bằng biến `AGENT_PERSONA_FILE=path/to/persona.md`.

## Bảng ticket (web)

- **Thanh B1–B7** dưới tiêu đề phòng: mỗi agent đang ở bước nào và đã ở mỗi bước bao lâu. Lấy từ `set_status` (tham số `step`, hoặc text bắt đầu bằng `B5 …`) và tin nhắn bắt đầu bằng `[B4] …`.
- **Tab Bug** (cột phải): mỗi bug có mã, mức độ, TC, trạng thái và lịch sử chuyển trạng thái. Bấm mã bug để nhảy tới tin báo bug.
  - Luồng: `open → fixed → verified` (hoặc `reopened`); DEV phản biện `→ disputed`; QA giữ quan điểm `disputed → open` hoặc chấp nhận `→ rejected`.
  - **Giới hạn tranh luận do hub đếm**: mỗi bên tối đa 2 lượt cho một bug. Lượt thứ 3, hub tự chuyển bug sang **Chờ user phân xử**, nhắn cả hai dừng tranh luận, web kêu và tự mở tab Bug. Bạn chọn "Là bug → DEV fix" hoặc "Không phải bug", kèm kết luận. Agent không đổi được bug đang chờ bạn.
  - Bạn có thể đổi trạng thái bất kỳ bug nào (mở ▾ trên thẻ bug).
- **Ảnh bằng chứng**: agent truyền đường dẫn ảnh (vd. `qa/screenshots/bug-01.png`) vào `screenshots`, bridge tải ảnh lên hub (`data/attachments/`), web hiện ảnh thu nhỏ trong tin, bấm để xem lớn.
- **Chống lặp**: 20 tin agent↔agent liên tiếp mà không đổi bước, không đổi trạng thái bug, bạn cũng không nhắn, thì web cảnh báo. 40 tin thì hub yêu cầu mỗi bên gửi bạn 1 tin tóm tắt rồi chờ. Bạn nhắn bất kỳ tin nào là bộ đếm reset. Đổi ngưỡng bằng `HUB_IDLE_WARN`.

## Báo cáo B7 và đóng ticket (web)

- QA gửi báo cáo chung bằng `submit_report` → tin **báo cáo** gửi bạn, web báo "📄 Báo cáo B7 chờ bạn duyệt", nút trên tiêu đề phòng đổi thành **📄 Báo cáo B7**.
- Bấm nút đó: xem / **sửa** báo cáo (mỗi lần lưu là một phiên bản), **tải .md**, **Copy markdown**, **Đóng ticket**. Team Hub **không ghi gì lên Backlog**: muốn đưa báo cáo lên ticket thì bạn tự dán. Chưa có báo cáo thì có thể "nhắc DEV/QA gửi báo cáo" hoặc "tạo nháp từ bảng bug" để tự viết.
- **Đóng ticket**: lưu báo cáo, tắt trực, hub nhắn agent "🏁 dừng việc, kết thúc lượt". Phòng hiện ✓ ở cột trái. Mở lại bằng nút **Mở lại ticket**, `tcm resume` hoặc gửi kickoff mới.

## Biến môi trường

| Biến | Dùng ở | Mặc định |
|---|---|---|
| `HUB_PORT`, `HUB_HOST` | hub | `4747`, `127.0.0.1` |
| `HUB_DB` | hub | `data/hub.db` |
| `HUB_ATTACHMENTS` | hub | `data/attachments` (cạnh DB) |
| `HUB_IDLE_WARN` | hub | `20` (cảnh báo lặp; x2 = yêu cầu dừng) |
| `HUB_URL` | bridge | `ws://127.0.0.1:4747/ws` |
| `HUB_ROOM` | bridge | (trống = bridge nghỉ) |
| `AGENT_NAME`, `AGENT_ROLE` | bridge | do script đặt |
| `AGENT_PERSONA_FILE` | bridge | (persona có sẵn theo role) |
| `HUB_CHANNEL` | bridge | `0` (`1` khi chạy script với `-Channel` / `CHANNEL=1`) |

## Phát triển web

```powershell
npm run hub       # terminal 1
npm run dev:web   # terminal 2 → http://localhost:5173 (proxy /api, /ws về hub)
```

## Lộ trình

- [x] **Phase 1**: hub + bridge (long-poll) + web chỉ xem
- [x] **Phase 2a**: đẩy tin realtime vào session (Claude Code channels), ô chat cho user trên web, QA test bằng browser
- [x] **Daily 1**: Stop hook giữ trực + chống lặp, cảnh báo chờ duyệt quyền, bật/tắt trực trên web, hub chạy nền, bridge nghỉ khi không có phòng, Figma qua Desktop Bridge
- [x] **Daily 2**: `tcm start <TICKET>` (Windows Terminal hoặc VS Code tasks, 2 pane + tự kickoff), `.team-hub.json` theo project, form kickoff trên web
- [x] **Phase 4**: thanh tiến độ B1–B7, bảng bug + phân xử trên web, giới hạn tranh luận do hub đếm, ảnh bằng chứng, chống lặp agent↔agent
- [x] **Phase 5**: `tcm resume <TICKET>` + `get_summary` (tóm tắt phòng khi vào lại), báo cáo B7 qua `submit_report` (có phiên bản, sửa trên web), đóng / mở lại ticket (không ghi gì lên Backlog: báo cáo tải .md / copy markdown)
- [ ] **Phase 6**: file kinh nghiệm theo dự án, số liệu qua nhiều ticket
