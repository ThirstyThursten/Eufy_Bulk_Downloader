@echo off
setlocal enabledelayedexpansion

:: ── Navigate to project root ──────────────────────────────────────
cd /d "%~dp0"

echo.
echo ======================================
echo    Eufy Bulk Downloader Launcher
echo ======================================
echo.

:: ── Check Node.js ─────────────────────────────────────────────────
echo [INFO]  Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed. Please install Node.js 20 or later.
    echo [ERROR] Download from: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
for /f "tokens=*" %%v in ('node -v') do set NODE_FULL=%%v

:: Parse major version from vXX.Y.Z
for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_TAG=%%a
set NODE_MAJOR=%NODE_TAG:~1%

if %NODE_MAJOR% lss 20 (
    echo [ERROR] Node.js 20+ is required ^(found %NODE_FULL%^)
    pause
    exit /b 1
)
echo [OK]    Node.js %NODE_FULL%

:: ── Check npm ─────────────────────────────────────────────────────
echo [INFO]  Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm is not installed.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
echo [OK]    npm %NPM_VER%

:: ── Check FFmpeg ──────────────────────────────────────────────────
echo [INFO]  Checking FFmpeg...
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [WARN]  FFmpeg not found in PATH.
    echo [WARN]  Downloads will fail without FFmpeg.
    echo         Download from: https://ffmpeg.org/download.html
    echo.
    set /p CONTINUE="Continue without FFmpeg? [y/N] "
    if /i not "!CONTINUE!"=="y" (
        exit /b 1
    )
) else (
    echo [OK]    FFmpeg found
)

:: ── Environment file ──────────────────────────────────────────────
set "ENV_FILE=%~dp0backend\.env"
set "ENV_EXAMPLE=%~dp0backend\.env.example"

if not exist "%ENV_FILE%" (
    echo [INFO]  No backend\.env file found.
    if exist "%ENV_EXAMPLE%" (
        copy "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
        echo [OK]    Created backend\.env from .env.example
    ) else (
        echo [WARN]  No .env.example found — creating a minimal .env
        (
            echo EUFY_EMAIL=your-email@example.com
            echo EUFY_PASSWORD=your-password
            echo EUFY_COUNTRY=US
            echo DOWNLOAD_DIR=./downloads
            echo PORT=3001
            echo MAX_CONCURRENT_DOWNLOADS=2
            echo P2P_CONNECTION_SETUP=0
        ) > "%ENV_FILE%"
        echo [OK]    Created backend\.env with defaults
    )

    echo [WARN]  Please edit backend\.env with your Eufy credentials.
    echo.
    set /p OPENNOW="Open backend\.env in Notepad now? [Y/n] "
    if /i not "!OPENNOW!"=="n" (
        notepad "%ENV_FILE%"
    )
) else (
    echo [OK]    backend\.env exists
)

:: ── Install dependencies ──────────────────────────────────────────
echo.
echo [INFO]  Installing root dependencies...
call npm install --silent >nul 2>&1
echo [OK]    Root dependencies installed

echo [INFO]  Installing backend dependencies...
pushd backend
call npm install --silent >nul 2>&1
popd
echo [OK]    Backend dependencies installed

echo [INFO]  Installing frontend dependencies...
pushd frontend
call npm install --silent >nul 2>&1
popd
echo [OK]    Frontend dependencies installed

:: ── Start servers ─────────────────────────────────────────────────
echo.
echo [INFO]  Starting backend and frontend...
echo         Backend  -^> http://localhost:3001
echo         Frontend -^> http://localhost:5173
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

call npm run dev
