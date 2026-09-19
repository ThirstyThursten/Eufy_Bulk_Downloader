@echo off
REM Thin wrapper — launches the PowerShell script so double-clicking works.
REM If PowerShell blocks the script, -ExecutionPolicy Bypass allows it for
REM this process only (no system-wide change).

echo %cmdcmdline% | findstr /i /c:"/c" >nul 2>&1
if %errorlevel% equ 0 (
    cmd /k "%~f0" %*
    exit /b
)

powershell -ExecutionPolicy Bypass -File "%~dp0run.ps1"
pause
