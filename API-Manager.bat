@echo off
setlocal
cd /d "%~dp0"
where pythonw >nul 2>nul
if not errorlevel 1 (
    start "" pythonw "%~dp0tools\api_manager\manager.py" %*
    exit /b
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe" (
    start "" "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe" "%~dp0tools\api_manager\manager.py" %*
    exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
    python "%~dp0tools\api_manager\manager.py" %*
    exit /b
)
echo Python 3.10 or newer is required. Please install Python and add it to PATH.
pause
