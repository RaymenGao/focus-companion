@echo off
chcp 65001 >nul
title FocusLens Frontend - Port 5173
cd /d "%~dp0"
echo.
echo ======= FocusLens Frontend Started =======
echo URL: http://127.0.0.1:5173
echo LAN: http://YOUR-PC-LAN-IP:5173/?parent=1
echo Press Ctrl+C to stop
echo ===========================================
echo.
call npm.cmd run dev
if errorlevel 1 echo FocusLens frontend stopped with an error.
pause
