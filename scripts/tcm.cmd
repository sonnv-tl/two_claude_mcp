@echo off
rem tcm cho PowerShell / cmd. Thêm C:\laragon\www\two_claude_mcp\scripts vào PATH để gọi "tcm" ở mọi nơi.
node "%~dp0tcm.mjs" --cwd "%CD%" %*
