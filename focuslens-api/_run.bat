@echo off
chcp 65001 >nul
title FocusLens API - Port 8012
cd /d %~dp0
echo.
echo ======= FocusLens API Started =======
echo URL: http://127.0.0.1:8012
echo Press Ctrl+C to stop
echo ======================================
echo.
"%~dp0.venv\Scripts\uvicorn.exe" main:app --host 127.0.0.1 --port 8012
pause
