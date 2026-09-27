@echo off
rem Grooveshelf — запуск с автоматическим открытием браузера.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js не найден. Установите Node.js 18+ с https://nodejs.org
  echo.
  pause
  exit /b 1
)
node server\index.js --open
if errorlevel 1 pause
endlocal