@echo off
setlocal

echo Stopping GKD Rule Studio services launched from this folder...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path -LiteralPath '%~dp0').Path.TrimEnd('\'); Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $root + '*') -and ($_.CommandLine -like '*scripts\portable-server.mjs*' -or $_.CommandLine -like '*scripts\adb-helper.mjs*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo [OK] Stop command finished.
pause
