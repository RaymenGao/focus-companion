@echo off
chcp 65001 >nul
title FocusLens Launcher

echo ==========================================
echo   FocusLens Launcher
echo ==========================================
echo.

set "ROOT=%~dp0"
set "BACKEND=%ROOT%focuslens-api"
set "FRONTEND=%ROOT%focuslens-v2"

:: Create the Python environment when needed.
if not exist "%BACKEND%\.venv\Scripts\python.exe" (
    echo Creating Python virtual environment...
    pushd "%BACKEND%"
    python -m venv .venv
    if errorlevel 1 goto :error
    popd
)

:: Always reconcile backend dependencies so newly added packages are installed.
echo Checking backend dependencies...
"%BACKEND%\.venv\Scripts\python.exe" -m pip install -r "%BACKEND%\requirements.txt" --disable-pip-version-check -q
if errorlevel 1 goto :error

:: Check frontend dependencies.
if not exist "%FRONTEND%\node_modules" (
    echo Installing frontend deps...
    pushd "%FRONTEND%"
    call npm.cmd install
    if errorlevel 1 goto :error
    popd
    echo Done.
    echo.
)

call :kill_port 8012
echo Starting backend API on port 8012...
start "FocusLens API" "%BACKEND%\_run.bat"

call :kill_port 5173
echo Starting frontend dev server on port 5173...
start "FocusLens Frontend" "%FRONTEND%\_run.bat"

echo.
echo Waiting for services to start...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(20); while((Get-Date)-lt $deadline){ try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8012/api/health -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
    echo WARNING: Backend health check did not pass within 20 seconds.
    echo Check the FocusLens API window for details.
)

echo Opening browser...
start http://127.0.0.1:5173

echo.
echo ==========================================
echo   Services launched in separate windows!
echo   Frontend: http://127.0.0.1:5173
echo   Backend:  http://127.0.0.1:8012
echo ==========================================
echo.
echo Press any key to close this launcher...
pause >nul
exit /b 0

:kill_port
powershell -NoProfile -Command "$conn = Get-NetTCPConnection -State Listen -LocalPort %1 -ErrorAction SilentlyContinue; if ($conn) { Write-Host '检测到端口 %1 被占用，正在自动终止旧服务...' -ForegroundColor Yellow; foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }"
exit /b 0

:error
echo.
echo ERROR: FocusLens setup failed. Review the message above.
pause
exit /b 1

