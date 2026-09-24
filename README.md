# Team Hub: nhiều Claude session làm việc cùng nhau

MCP hub cho phép nhiều Claude Code session (ví dụ **DEV** và **QA**) nhắn tin, phối hợp với nhau trên cùng một repo. Có web để theo dõi toàn bộ hội thoại.

```
Claude (DEV) ─stdio─ bridge ─┐
                             ├─ WebSocket ─► HUB (http + ws + SQLite) ◄─ Web UI (React)
Claude (QA)  ─stdio─ bridge ─┘
```

- `packages/hub`: server trung tâm, route tin nhắn, lưu SQLite (`data/hub.db`), serve web ở `http://127.0.0.1:4747`.
- `packages/bridge`: MCP server stdio. Mỗi Claude session spawn một bridge riêng, bridge cung cấp tools và persona.
- `packages/web`: web UI theo dõi phòng (Phase 1: chỉ xem).
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

   **Trong WSL / Git Bash**:
   ```bash
   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh dev test-feature
   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh qa  test-feature
   ```
   Nếu `claude` trong WSL là bản Windows (`claude.exe`, cài qua npm phía Windows), biến môi trường phải được khai báo trong `WSLENV` thì mới sang được phía Windows. Script đã làm việc này. Tự gõ tay thì như sau:
   ```bash
   export AGENT_ROLE=qa AGENT_NAME=qa HUB_ROOM=test-feature
   export WSLENV=AGENT_ROLE:AGENT_NAME:HUB_ROOM:HUB_URL
   claude
   ```
   Hub vẫn chạy phía Windows (`npm run hub` trong PowerShell).

4. Giao việc cho DEV (kèm Acceptance Criteria) ngay trong terminal DEV. Có thể báo QA rằng AC nằm ở đâu. Hai bên sẽ tự trao đổi và bạn theo dõi trên web.

## Tools mà mỗi session có

| Tool | Mô tả |
|---|---|
| `send_message(to, content, type?, reply_to?)` | Gửi tới `dev` / `qa` / `user` / `@all` |
| `wait_for_messages(timeout_seconds?)` | Chờ tin mới (long-poll, tối đa 600s) |
| `check_inbox()` | Xem tin mới, không chờ |
| `get_history(limit?, before_id?)` | Lịch sử phòng |
| `list_participants()` | Ai đang online, đang làm gì |
| `set_status(text)` | Trạng thái hiển thị trên web |

Tin mới được **đính kèm tự động vào kết quả của mọi tool** hub. Các loại tin: `chat`, `question`, `ac_deviation`, `test_case`, `bug_report`, `handoff`.

Persona mặc định nằm trong `packages/bridge/src/personas.ts` (DEV sở hữu source, QA sở hữu test, QA viết test song song và báo lệch AC sớm). Có thể override bằng biến `AGENT_PERSONA_FILE=path/to/persona.md`.

## Biến môi trường

| Biến | Dùng ở | Mặc định |
|---|---|---|
| `HUB_PORT`, `HUB_HOST` | hub | `4747`, `127.0.0.1` |
| `HUB_DB` | hub | `data/hub.db` |
| `HUB_URL` | bridge | `ws://127.0.0.1:4747/ws` |
| `HUB_ROOM` | bridge | `default` |
| `AGENT_NAME`, `AGENT_ROLE` | bridge | `dev`, `dev` (theo `.mcp.json` mẫu) |
| `AGENT_PERSONA_FILE` | bridge | (persona có sẵn theo role) |

## Phát triển web

```powershell
npm run hub       # terminal 1
npm run dev:web   # terminal 2 → http://localhost:5173 (proxy /api, /ws về hub)
```

## Lộ trình

- [x] **Phase 1**: hub + bridge (long-poll) + web chỉ xem
- [ ] **Phase 2**: đẩy tin realtime vào session (Claude Code channels), ô chat cho user trên web, Pause/Resume, chống loop
- [ ] **Phase 3**: bảng task/bug, tin có cấu trúc (bug report, AC checklist)
- [ ] **Phase 4**: export hội thoại, auth khi mở ra LAN, script demo
