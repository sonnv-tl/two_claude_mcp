# Mở một Claude session với vai trò chỉ định, trong repo đích.
# Ví dụ (mở 2 terminal, cùng repo):
#   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role dev -Room login-feature
#   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role qa  -Room login-feature
# Yêu cầu: repo đích có .mcp.json (copy từ examples/.mcp.json) và hub đang chạy (npm run hub).
#   -Channel   : đẩy tin realtime qua Claude Code channels (org phải bật channelsEnabled).
#                Mặc định: long-poll — agent "trực" trong wait_for_messages.
#   -NoBrowser : QA không nạp Playwright MCP (khi đã có tool browser khác)
param(
  [Parameter(Mandatory = $true)][string]$Role,
  [string]$Name = $Role,
  [string]$Room = "default",
  [string]$HubUrl = "ws://127.0.0.1:4747/ws",
  [string]$Prompt = "",
  [switch]$Channel,
  [switch]$NoBrowser
)

$env:AGENT_ROLE = $Role
$env:AGENT_NAME = $Name
$env:HUB_ROOM = $Room
$env:HUB_URL = $HubUrl
# Cho phép wait_for_messages chờ lâu mà không bị Claude Code cắt (ms)
if (-not $env:MCP_TOOL_TIMEOUT) { $env:MCP_TOOL_TIMEOUT = "900000" }

$claudeArgs = @()
if ($Channel) {
  $env:HUB_CHANNEL = "1"
  $claudeArgs += @("--dangerously-load-development-channels", "server:team-hub")
  $defaultPrompt = "Bạn là $Name trong phòng '$Room' của team hub. Gọi list_participants và get_history để nắm bối cảnh, " +
    "sau đó làm việc theo vai trò của bạn. Nếu chưa có việc thì kết thúc lượt, tin nhắn mới sẽ được đẩy tới."
} else {
  $env:HUB_CHANNEL = "0"
  $defaultPrompt = "Bạn là $Name trong phòng '$Room' của team hub. Gọi list_participants và get_history để nắm bối cảnh, " +
    "sau đó vào CHẾ ĐỘ TRỰC: gọi wait_for_messages để chờ việc, xử lý xong mỗi việc thì lại gọi wait_for_messages, " +
    "hết timeout thì gọi lại. Không kết thúc lượt trừ khi user bảo dừng."
}
if ($Role -eq "qa" -and -not $NoBrowser) {
  $claudeArgs += @("--mcp-config", (Join-Path $PSScriptRoot "..\examples\qa-browser.mcp.json"))
}
if (-not $Prompt) { $Prompt = $defaultPrompt }

# Prompt phải đứng TRƯỚC: các cờ channel / --mcp-config nhận nhiều giá trị, sẽ nuốt mất prompt nếu đặt sau
claude $Prompt @claudeArgs
