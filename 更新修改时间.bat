@echo off
setlocal
cd /d "%~dp0"
title PDF Reader - Update Modification Time

where python >nul 2>nul
if not errorlevel 1 (
    python "%~dp0tools\update_time.py" %*
    goto finish
)

where py >nul 2>nul
if not errorlevel 1 (
    py "%~dp0tools\update_time.py" %*
    goto finish
)

where powershell >nul 2>nul
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update_time.ps1" %*
    goto finish
)

echo [ERROR] Neither Python nor PowerShell is available on this system.
pause
exit /b 1

:finish
set EXIT_CODE=%errorlevel%
if %EXIT_CODE% equ 0 (
    if not "%1"=="--quiet" if not "%1"=="-q" if not "%1"=="/q" (
        timeout /t 3 >nul 2>nul
    )
) else (
    echo.
    pause
)
exit /b %EXIT_CODE%
