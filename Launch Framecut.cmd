@echo off
where node >nul 2>&1
if errorlevel 1 (
  echo Framecut needs Node.js on PATH.
  pause
  exit /b 1
)
node "%~dp0server.mjs" --open
if errorlevel 1 pause
