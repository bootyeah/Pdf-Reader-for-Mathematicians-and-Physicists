@echo off
setlocal
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
title PDF Reader Pro - Core Engine
cd /d "%~dp0"
echo [Launcher Directory] %~dp0
echo.

:: Keep this launcher ASCII-only; cmd.exe may start with a non-UTF-8 code page.
where python >nul 2>nul
if errorlevel 1 goto nopython

:: The server verifies an existing reader before reusing the port.
:: A fresh entry URL bypasses old HTML caches without clearing saved annotations.
for /f %%I in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "READER_LAUNCH_ID=%%I"
set "READER_ENTRY_URL=http://127.0.0.1:8080/index.html?_readerLoad=%READER_LAUNCH_ID%"
python "%~dp0app\server.py" %*
set "READER_EXIT_CODE=%errorlevel%"
if "%READER_EXIT_CODE%"=="1" pause
exit /b %READER_EXIT_CODE%

:nopython
echo [FATAL] Python not found. Please install Python and add it to PATH.
pause
exit /b 1
