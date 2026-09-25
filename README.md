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
npm run smoke        # test end-to-end: hub + 2 bridge
```

## Sử dụng

1. **Chạy hub** (để terminal này mở):
   ```powershell
   npm run hub
   ```
   Mở web ở http://127.0.0.1:4747

2. **Cấu hình repo đích** (repo mà DEV và QA cùng làm): copy `examples/.mcp.json` vào thư mục gốc repo đó. Nếu repo đã có `.mcp.json` thì gộp mục `team-hub` vào. Tên, vai trò và phòng lấy từ biến môi trường, nên hai session dùng chung được một file.

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
| `set_status(text)` | Trạng thái hiển thị trên web |

Ở chế độ channel, tin được đẩy vào session dưới dạng `<channel source="team-hub" from=... type=... msg_id=...>`. Ở cả hai chế độ, tin chưa đọc cũng được **đính kèm vào kết quả của mọi tool** hub. Các loại tin: `chat`, `question`, `ac_deviation`, `test_case`, `bug_report`, `handoff`.

Persona mặc định nằm trong `packages/bridge/src/personas.ts`. **DEV**: source + unit/integration test, chạy app và báo URL cho QA. **QA**: không viết unit test; viết test case nghiệp vụ vào `qa/testcases/`, soát code để báo lệch AC sớm, chạy test case trên browser thật, ghi kết quả vào `qa/runs/`, báo bug kèm screenshot. Có thể override bằng biến `AGENT_PERSONA_FILE=path/to/persona.md`.

## Biến môi trường

| Biến | Dùng ở | Mặc định |
|---|---|---|
| `HUB_PORT`, `HUB_HOST` | hub | `4747`, `127.0.0.1` |
| `HUB_DB` | hub | `data/hub.db` |
| `HUB_URL` | bridge | `ws://127.0.0.1:4747/ws` |
| `HUB_ROOM` | bridge | `default` |
| `AGENT_NAME`, `AGENT_ROLE` | bridge | `dev`, `dev` (theo `.mcp.json` mẫu) |
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
- [ ] **Phase 2b**: Pause/Resume, chống loop agent↔agent
- [ ] **Phase 3**: bảng task/bug, tin có cấu trúc (bug report, AC checklist)
- [ ] **Phase 4**: export hội thoại, auth khi mở ra LAN, script demo
