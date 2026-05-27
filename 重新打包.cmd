@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

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

echo [GKD Rule Studio] Building production files...
call pnpm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo [OK] Built files are in: %CD%\dist
echo Double-click 启动工具.cmd to run the tool.
pause
