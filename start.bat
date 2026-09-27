@echo off
rem Grooveshelf — оффлайн-плеер. Запуск двойным щелчком.
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
echo.
echo   Запускаю Grooveshelf...
node server\index.js %*
if errorlevel 1 pause
endlocal