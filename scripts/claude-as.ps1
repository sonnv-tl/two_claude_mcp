# Mở một Claude session với vai trò chỉ định, trong repo đích.
# Ví dụ (mở 2 terminal, cùng repo):
#   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role dev -Room login-feature
#   powershell -ExecutionPolicy Bypass -File C:\laragon\www\two_claude_mcp\scripts\claude-as.ps1 -Role qa  -Room login-feature
# Yêu cầu: repo đích có .mcp.json (copy từ examples/.mcp.json) và hub đang chạy (npm run hub).
param(
  [Parameter(Mandatory = $true)][string]$Role,
  [string]$Name = $Role,
  [string]$Room = "default",
  [string]$HubUrl = "ws://127.0.0.1:4747/ws",
  [string]$Prompt = ""
)

$env:AGENT_ROLE = $Role
$env:AGENT_NAME = $Name
$env:HUB_ROOM = $Room
$env:HUB_URL = $HubUrl

if (-not $Prompt) {
  $Prompt = "Bạn là $Name trong phòng '$Room' của team hub. Gọi list_participants và get_history để nắm bối cảnh, " +
    "sau đó làm việc theo vai trò của bạn. Khi rảnh thì gọi wait_for_messages."
}

claude $Prompt
