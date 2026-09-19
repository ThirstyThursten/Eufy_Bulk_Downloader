@echo off

:: ── Keep window open on errors: re-launch with cmd /k if double-clicked ──
:: When double-clicked from Explorer, %cmdcmdline% contains the full path
:: wrapped in quotes with /c. We re-launch with /k so the window stays open.
echo %cmdcmdline% | findstr /i /c:"/c" >nul 2>&1
if %errorlevel% equ 0 (
    cmd /k "%~f0" %*
    exit /b
)

setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Eufy Bulk Downloader

:: ── Navigate to project root ──────────────────────────────────────
cd /d "%~dp0"

echo.
echo ======================================
echo    Eufy Bulk Downloader Launcher
echo ======================================
echo.

:: ── Check what needs installing ──────────────────────────────────
set NEED_NODE=0
set NEED_FFMPEG=0
set NODE_TOO_OLD=0

where node >nul 2>&1
if errorlevel 1 (
    set NEED_NODE=1
) else (
    for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_TAG=%%a
    set NODE_MAJOR=!NODE_TAG:~1!
    if !NODE_MAJOR! lss 20 (
        set NEED_NODE=1
        set NODE_TOO_OLD=1
    )
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    set NEED_FFMPEG=1
)

:: ── If nothing is missing, skip to verification ─────────────────
if !NEED_NODE! equ 0 if !NEED_FFMPEG! equ 0 goto :skip_install

:: ── Show what's missing and offer to install ─────────────────────
echo [!!]   Some dependencies are missing.
echo        This script can automatically install them for you:
echo.

if !NEED_NODE! equ 1 (
    if !NODE_TOO_OLD! equ 1 (
        for /f "tokens=*" %%v in ('node -v') do echo   [X]  Node.js 20+  ^(current version is too old: %%v^)
    ) else (
        echo   [X]  Node.js 20+  ^(JavaScript runtime - required^)
    )
    echo        includes npm ^(package manager^)
)

if !NEED_FFMPEG! equ 1 (
    echo   [X]  FFmpeg       ^(video muxer - required for downloads^)
)

echo.

:: Check if winget is available
where winget >nul 2>&1
if errorlevel 1 (
    echo [ERROR] winget is not available on this system.
    echo         winget comes pre-installed on Windows 10 ^(1709+^) and Windows 11.
    echo.
    echo         Please install the missing dependencies manually:
    if !NEED_NODE! equ 1 echo           Node.js: https://nodejs.org/
    if !NEED_FFMPEG! equ 1 echo           FFmpeg:  https://www.gyan.dev/ffmpeg/builds/
    echo.
    echo         After installing, close this window and double-click run.bat again.
    echo.
    pause
    exit /b 1
)

echo   Installer: winget ^(Windows Package Manager^)
echo.
set /p INSTALL_ANSWER="Install missing dependencies automatically? [Y/n] "
if /i "!INSTALL_ANSWER!"=="n" (
    echo.
    echo [ERROR] Cannot continue without required dependencies.
    echo         Install them manually and re-run this script.
    echo.
    pause
    exit /b 1
)

echo.

:: ── Install Node.js via winget ───────────────────────────────────
if !NEED_NODE! equ 1 (
    echo [INFO]  Installing Node.js 22 LTS via winget...
    echo         This may take a minute...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo [ERROR] Node.js installation failed.
        echo         Please install manually: https://nodejs.org/
        echo.
        pause
        exit /b 1
    )
    echo [OK]    Node.js installed

    :: Refresh PATH so node/npm are available in this session
    echo [INFO]  Refreshing PATH...
    for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%B"
    set "PATH=!SYS_PATH!;!USR_PATH!"
    echo.
)

:: ── Install FFmpeg via winget ────────────────────────────────────
if !NEED_FFMPEG! equ 1 (
    echo [INFO]  Installing FFmpeg via winget...
    echo         This may take a minute...
    winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [WARN]  FFmpeg installation via winget failed.
        echo [INFO]  Trying alternative package...
        winget install FFmpeg.FFmpeg --accept-source-agreements --accept-package-agreements
        if errorlevel 1 (
            echo.
            echo [WARN]  FFmpeg auto-install failed.
            echo [WARN]  Downloads will not work without FFmpeg.
            echo         Install manually: https://www.gyan.dev/ffmpeg/builds/
            echo.
            set /p CONTINUE_NO_FF="Continue without FFmpeg? [y/N] "
            if /i not "!CONTINUE_NO_FF!"=="y" (
                pause
                exit /b 1
            )
        ) else (
            echo [OK]    FFmpeg installed
        )
    ) else (
        echo [OK]    FFmpeg installed
    )

    :: Refresh PATH for FFmpeg
    echo [INFO]  Refreshing PATH...
    for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%B"
    set "PATH=!SYS_PATH!;!USR_PATH!"
    echo.
)

:skip_install

:: ── Verify all dependencies ──────────────────────────────────────
echo [INFO]  Verifying dependencies...

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js is still not available.
    echo         If you just installed it, you may need to close this window
    echo         and double-click run.bat again so the new PATH takes effect.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_TAG=%%a
set NODE_MAJOR=!NODE_TAG:~1!
for /f "tokens=*" %%v in ('node -v') do set NODE_FULL=%%v

if !NODE_MAJOR! lss 20 (
    echo.
    echo [ERROR] Node.js 20+ is required ^(found !NODE_FULL!^)
    echo         If you just installed a newer version, close this window
    echo         and double-click run.bat again so the new PATH takes effect.
    echo.
    pause
    exit /b 1
)
echo [OK]    Node.js !NODE_FULL!

where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] npm is not available.
    echo         If you just installed Node.js, close this window
    echo         and double-click run.bat again so the new PATH takes effect.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm -v') do echo [OK]    npm %%v

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [WARN]  FFmpeg not found - downloads will fail without it.
) else (
    echo [OK]    FFmpeg found
)

:: ── Environment file ──────────────────────────────────────────────
set "ENV_FILE=%~dp0backend\.env"
set "ENV_EXAMPLE=%~dp0backend\.env.example"

if not exist "!ENV_FILE!" (
    echo.
    echo [INFO]  No backend\.env file found.
    if exist "!ENV_EXAMPLE!" (
        copy "!ENV_EXAMPLE!" "!ENV_FILE!" >nul
        echo [OK]    Created backend\.env from .env.example
    ) else (
        echo [WARN]  No .env.example found - creating a minimal .env
        (
            echo EUFY_EMAIL=your-email@example.com
            echo EUFY_PASSWORD=your-password
            echo EUFY_COUNTRY=US
            echo DOWNLOAD_DIR=./downloads
            echo PORT=3001
            echo MAX_CONCURRENT_DOWNLOADS=2
            echo P2P_CONNECTION_SETUP=0
        ) > "!ENV_FILE!"
        echo [OK]    Created backend\.env with defaults
    )

    echo.
    echo [WARN]  Please edit backend\.env with your Eufy credentials.
    echo         At minimum, set EUFY_EMAIL and EUFY_PASSWORD.
    echo.
    set /p OPENNOW="Open backend\.env in Notepad now? [Y/n] "
    if /i not "!OPENNOW!"=="n" (
        notepad "!ENV_FILE!"
    )
    echo.
    echo         Press any key when you have saved your credentials...
    pause >nul
) else (
    echo [OK]    backend\.env exists
)

:: ── Install npm dependencies ──────────────────────────────────────
echo.
echo [INFO]  Installing root dependencies...
call npm install --silent >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Root npm install failed. See errors above.
    pause
    exit /b 1
)
echo [OK]    Root dependencies installed

echo [INFO]  Installing backend dependencies...
pushd backend
call npm install --silent >nul 2>&1
if errorlevel 1 (
    popd
    echo [ERROR] Backend npm install failed. See errors above.
    pause
    exit /b 1
)
popd
echo [OK]    Backend dependencies installed

echo [INFO]  Installing frontend dependencies...
pushd frontend
call npm install --silent >nul 2>&1
if errorlevel 1 (
    popd
    echo [ERROR] Frontend npm install failed. See errors above.
    pause
    exit /b 1
)
popd
echo [OK]    Frontend dependencies installed

:: ── Start servers ─────────────────────────────────────────────────
echo.
echo ======================================
echo    All ready! Starting servers...
echo ======================================
echo.
echo    Backend  -^> http://localhost:3001
echo    Frontend -^> http://localhost:5173
echo.
echo    Press Ctrl+C to stop.
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

call npm run dev

:: If npm run dev exits (shouldn't normally), keep window open
echo.
echo [INFO]  Servers have stopped.
pause
