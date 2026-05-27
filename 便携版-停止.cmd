@echo off
setlocal

echo Stopping GKD Rule Studio services on ports 5174 and 18741...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 5174,18741 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo.
echo [OK] Stop command finished.
pause
