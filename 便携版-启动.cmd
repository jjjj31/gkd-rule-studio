@echo off
setlocal

cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
set "URL=http://127.0.0.1:5174/"

echo ========================================
echo GKD Rule Studio Portable
echo ========================================
echo.

if not exist "%NODE%" (
  echo [ERROR] Missing runtime\node.exe.
  echo Please extract the full portable zip package.
  echo.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo [ERROR] Missing dist\index.html.
  echo Please extract the full portable zip package.
  echo.
  pause
  exit /b 1
)

echo [1/3] Starting web server: %URL%
start "GKD Rule Studio Server" /min "%NODE%" "%~dp0scripts\portable-server.mjs"

echo [2/3] Starting ADB helper: http://127.0.0.1:18741
start "GKD ADB Helper" /min "%NODE%" "%~dp0scripts\adb-helper.mjs"

echo [3/3] Waiting for startup...
timeout /t 2 /nobreak >nul

echo.
echo [OK] Opening browser.
start "" "%URL%"

echo.
echo If the browser did not open, copy this URL manually:
echo   %URL%
echo.
echo To stop background services, double-click:
echo   portable-stop.cmd
echo.
echo You can close this launcher window. The tool keeps running in background.
echo Press any key to close this window.
pause >nul
exit /b 0
