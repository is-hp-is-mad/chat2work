@echo off
setlocal enabledelayedexpansion
title Uninstalling chat2work (cowork-mcp) from Claude Desktop...

echo ============================================================
echo   chat2work: cowork-mcp - Uninstaller for Claude Desktop
echo ============================================================
echo.

set "NODE_EXE="
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "NODE_EXE=node"
) else (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    ) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    ) else if exist "%LocalAppData%\Programs\nodejs\node.exe" (
        set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
    )
)

if "%NODE_EXE%"=="" (
    echo [ERROR] Node.js was not found. Cannot run uninstaller.
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\install.mjs" --remove
echo.
pause
