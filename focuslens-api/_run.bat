@echo off
chcp 65001 >nul
title FocusLens API - Port 8012
cd /d "%~dp0"
echo.
echo ======= FocusLens API Started =======
echo URL: http://127.0.0.1:8012
echo LAN: http://YOUR-PC-LAN-IP:8012
echo Press Ctrl+C to stop
echo ======================================
echo.
"%~dp0.venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8012
if errorlevel 1 echo FocusLens API stopped with an error.
pause
