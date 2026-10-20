@echo off
title Who did that?
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get it from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Installing the game, one moment...
  call npm install --omit=dev --no-fund --no-audit
)

rem The online link needs Cloudflare's free tunnel tool (cloudflared).
set "CF="
where cloudflared >nul 2>nul && set "CF=1"
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=1"
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=1"
if not defined CF (
  echo.
  echo   To let friends join from anywhere, the game needs Cloudflare's free tunnel tool.
  choice /c YN /m "  Install it now with winget"
  if not errorlevel 2 winget install --id Cloudflare.cloudflared -e
)

node server.js --online --open
pause
