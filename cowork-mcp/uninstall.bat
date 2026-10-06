@echo off
setlocal enabledelayedexpansion
title Uninstalling chat2work (cowork-mcp) from Claude Desktop...

echo ============================================================
echo   chat2work: cowork-mcp - Uninstaller for Claude Desktop
echo ============================================================
echo.

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "X86_PATH=%ProgramFiles(x86)%"
if not defined NODE_EXE if defined X86_PATH if exist "%X86_PATH%\nodejs\node.exe" set "NODE_EXE=%X86_PATH%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Cannot run uninstaller.
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\install.mjs" --remove
echo.
pause
