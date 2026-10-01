# Cho hub tự chạy nền khi đăng nhập Windows (Task Scheduler, không cần quyền admin).
#   powershell -ExecutionPolicy Bypass -File scripts\hub-service.ps1 install    # đăng ký + chạy ngay
#   powershell -ExecutionPolicy Bypass -File scripts\hub-service.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\hub-service.ps1 restart    # sau khi npm run build
#   powershell -ExecutionPolicy Bypass -File scripts\hub-service.ps1 uninstall
# Log: data\hub.log
param([ValidateSet("install", "uninstall", "status", "restart")][string]$Action = "status")
$ErrorActionPreference = "Stop"

$TaskName = "TeamHub"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$HubJs = Join-Path $Root "packages\hub\dist\index.js"
$DataDir = Join-Path $Root "data"
$Log = Join-Path $DataDir "hub.log"
$Port = if ($env:HUB_PORT) { $env:HUB_PORT } else { 4747 }

function Test-Hub {
  try { (Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok } catch { $false }
}

function Start-HubTask {
  # Dừng task cũ + hub đang giữ port (chạy tay hoặc task cũ), rồi chạy task và chờ hub phản hồi
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-HubProcess
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Hub) { return $true }
  }
  return $false
}

function Stop-HubProcess {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $HubJs)) { Write-Error "Chưa build: chạy 'npm run build' trong $Root trước."; exit 1 }
    $node = (Get-Command node -ErrorAction Stop).Source
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    # conhost --headless: node có console nhưng KHÔNG có cửa sổ. (powershell -WindowStyle Hidden không đủ:
    # khi Windows Terminal là terminal mặc định, console bị hiện thành tab WT, đóng tab là hub chết.)
    $taskAction = New-ScheduledTaskAction -Execute "conhost.exe" `
      -Argument "--headless `"$node`" --disable-warning=ExperimentalWarning `"$HubJs`" --log `"$Log`"" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $taskSettings `
      -Description "Team Hub (two_claude_mcp) - http://127.0.0.1:$Port" -Force -ErrorAction Stop | Out-Null
    if (Start-HubTask) { Write-Host "OK: hub chạy nền tại http://127.0.0.1:$Port (log: $Log)" }
    else { Write-Warning "Đã đăng ký task nhưng hub chưa phản hồi. Xem log: $Log" }
  }
  "uninstall" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-HubProcess
    Write-Host "Đã gỡ task $TaskName và tắt hub."
  }
  "restart" {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Write-Error "Chưa cài: chạy hub-service.ps1 install" }
    if (Start-HubTask) { Write-Host "OK: hub đã khởi động lại" } else { Write-Warning "Hub chưa phản hồi. Xem log: $Log" }
  }
  "status" {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ("Task:  " + $(if ($t) { $t.State } else { "chưa cài (chạy: hub-service.ps1 install)" }))
    Write-Host ("Hub:   " + $(if (Test-Hub) { "đang chạy - http://127.0.0.1:$Port" } else { "không phản hồi" }))
    Write-Host "Log:   $Log"
  }
}
