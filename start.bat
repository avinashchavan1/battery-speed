@echo off
rem Double-click to run Battery Speed on Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Battery Speed needs Node.js 22.13 or newer.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node bin\battery-speed.js start --open
pause
