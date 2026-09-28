#!/usr/bin/env bash
# Mở Claude session với vai trò chỉ định — dùng trong WSL / Git Bash.
# Chạy trong thư mục repo đích:
#   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh dev test-feature
#   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh qa  test-feature
# Tham số: <role> [room=default] [name=role] [prompt]
# Biến tuỳ chọn:
#   CHANNEL=1     đẩy tin realtime qua Claude Code channels (org phải bật channelsEnabled)
#                 mặc định: long-poll — agent "trực" trong wait_for_messages
#   NO_BROWSER=1  QA không nạp Playwright MCP
#   NO_HOOKS=1    không nạp hooks/team-settings.json (Stop hook giữ trực, báo "chờ duyệt quyền" lên web)
#   MODEL=sonnet  model cho session này
#   PERMISSION_MODE=acceptEdits   vd. cho DEV tự sửa file không cần duyệt
#   SKIP_PERMISSIONS=1            chạy với --dangerously-skip-permissions (không hỏi duyệt quyền)
#   CLAUDE_EXTRA="--foo bar"      tham số thêm cho claude
#
# Trong WSL, `claude` thường là claude.exe của Windows → biến môi trường phải khai báo
# trong WSLENV thì mới truyền sang process Windows (và tới MCP bridge).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROLE="${1:?Cách dùng: claude-as.sh <role> [room] [name] [prompt]}"
ROOM="${2:-default}"
NAME="${3:-$ROLE}"

export AGENT_ROLE="$ROLE" AGENT_NAME="$NAME" HUB_ROOM="$ROOM"
export HUB_URL="${HUB_URL:-ws://127.0.0.1:4747/ws}"
# Cho phép wait_for_messages chờ lâu mà không bị Claude Code cắt (ms)
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-900000}"

# claude.exe (Windows) cần đường dẫn Windows
winpath() {
  if command -v wslpath >/dev/null 2>&1 && [[ "$(command -v claude)" == /mnt/* ]]; then wslpath -w "$1"; else echo "$1"; fi
}

ARGS=()
if [[ "${NO_HOOKS:-}" != "1" ]]; then
  ARGS+=(--settings "$(winpath "$HERE/../hooks/team-settings.json")")
fi
[[ -n "${MODEL:-}" ]] && ARGS+=(--model "$MODEL")
[[ -n "${PERMISSION_MODE:-}" ]] && ARGS+=(--permission-mode "$PERMISSION_MODE")
[[ "${SKIP_PERMISSIONS:-}" == "1" ]] && ARGS+=(--dangerously-skip-permissions)
if [[ "${CHANNEL:-}" == "1" ]]; then
  export HUB_CHANNEL=1
  ARGS+=(--dangerously-load-development-channels server:team-hub)
  DEFAULT_PROMPT="Bạn là $NAME trong phòng '$ROOM' của team hub. Gọi list_participants và get_history để nắm bối cảnh, sau đó làm việc theo vai trò của bạn. Nếu chưa có việc thì kết thúc lượt, tin nhắn mới sẽ được đẩy tới."
else
  export HUB_CHANNEL=0
  DEFAULT_PROMPT="Bạn là $NAME trong phòng '$ROOM' của team hub. Gọi list_participants và get_history để nắm bối cảnh, sau đó vào CHẾ ĐỘ TRỰC: gọi wait_for_messages để chờ việc, xử lý xong mỗi việc thì lại gọi wait_for_messages, hết timeout thì gọi lại. Không kết thúc lượt trừ khi user bảo dừng."
fi
PROMPT="${4:-$DEFAULT_PROMPT}"
export WSLENV="${WSLENV:+$WSLENV:}AGENT_ROLE:AGENT_NAME:HUB_ROOM:HUB_URL:HUB_CHANNEL:MCP_TOOL_TIMEOUT"

if [[ "$ROLE" == "qa" && "${NO_BROWSER:-}" != "1" ]]; then
  ARGS+=(--mcp-config "$(winpath "$HERE/../examples/qa-browser.mcp.json")")
fi
# shellcheck disable=SC2206
[[ -n "${CLAUDE_EXTRA:-}" ]] && ARGS+=(${CLAUDE_EXTRA})

# Prompt phải đứng TRƯỚC: các cờ channel / --mcp-config nhận nhiều giá trị, sẽ nuốt mất prompt nếu đặt sau
exec claude "$PROMPT" "${ARGS[@]}"
