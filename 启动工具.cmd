@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
set "URL=http://127.0.0.1:5174/"
set "ADB_HELPER_URL=http://127.0.0.1:18741/api/adb/status"

echo [GKD Rule Studio] Checking existing local server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%URL%' -TimeoutSec 1; if ($r.StatusCode -ge 200) { exit 0 } } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo [GKD Rule Studio] Server is already running.
  start "" "%URL%"
  exit /b 0
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found. Install Node.js, then run: npm install -g pnpm
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [GKD Rule Studio] Installing dependencies...
  call pnpm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [GKD Rule Studio] Building dist...
  call pnpm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)

echo [GKD Rule Studio] Checking ADB helper...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%ADB_HELPER_URL%' -TimeoutSec 1; if ($r.StatusCode -ge 200) { exit 0 } } catch { exit 1 }"
if not "%ERRORLEVEL%"=="0" (
  echo [GKD Rule Studio] Starting ADB helper on http://127.0.0.1:18741
  start "GKD ADB Helper" cmd /c "cd /d ""%~dp0"" && pnpm run adb-helper"
)

echo [GKD Rule Studio] Starting local server on %URL%
start "GKD Rule Studio Server" cmd /c "cd /d ""%~dp0"" && pnpm run start"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%URL%'; for ($i=0; $i -lt 40; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 1; if ($r.StatusCode -ge 200) { Start-Process $url; exit 0 } } catch { Start-Sleep -Milliseconds 500 } }; Start-Process $url"
exit /b 0
