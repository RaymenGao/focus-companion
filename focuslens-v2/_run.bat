@echo off
chcp 65001 >nul
title FocusLens Frontend - Port 5173
cd /d %~dp0
echo.
echo ======= FocusLens Frontend Started =======
echo URL: http://127.0.0.1:5173
echo Press Ctrl+C to stop
echo ===========================================
echo.
call npm run dev
pause
