#!/usr/bin/env bash
# Mở Claude session với vai trò chỉ định — dùng trong WSL / Git Bash.
# Chạy trong thư mục repo đích:
#   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh dev test-feature
#   bash /mnt/c/laragon/www/two_claude_mcp/scripts/claude-as.sh qa  test-feature
# Tham số: <role> [room=default] [name=role] [prompt]
#
# Trong WSL, `claude` thường là claude.exe của Windows → biến môi trường phải khai báo
# trong WSLENV thì mới truyền sang process Windows (và tới MCP bridge).
set -euo pipefail

ROLE="${1:?Cách dùng: claude-as.sh <role> [room] [name] [prompt]}"
ROOM="${2:-default}"
NAME="${3:-$ROLE}"
PROMPT="${4:-Bạn là $NAME trong phòng '$ROOM' của team hub. Gọi list_participants và get_history để nắm bối cảnh, sau đó làm việc theo vai trò của bạn. Khi rảnh thì gọi wait_for_messages.}"

export AGENT_ROLE="$ROLE" AGENT_NAME="$NAME" HUB_ROOM="$ROOM"
export HUB_URL="${HUB_URL:-ws://127.0.0.1:4747/ws}"
export WSLENV="${WSLENV:+$WSLENV:}AGENT_ROLE:AGENT_NAME:HUB_ROOM:HUB_URL"

exec claude "$PROMPT"
