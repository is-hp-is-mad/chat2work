@echo off
setlocal enabledelayedexpansion
title Installing chat2work (cowork-mcp) for Claude Desktop...

echo ============================================================
echo   chat2work: Cowork MCP Server - Automatic Installer
echo ============================================================
echo.

:: 1. Locate Node.js
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
    echo [ERROR] Node.js was not found on your system!
    echo.
    echo cowork-mcp runs on Node.js (version 20 or newer recommended).
    echo Please download and install Node.js from:
    echo   https://nodejs.org/
    echo.
    echo After installing Node.js, run this install.bat again.
    echo ============================================================
    pause
    exit /b 1
)

echo [OK] Using Node.js: %NODE_EXE%
"%NODE_EXE%" -v
echo.

:: 2. Run the installer script
"%NODE_EXE%" "%~dp0scripts\install.mjs" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Installation failed. See above for details.
    echo ============================================================
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ============================================================
echo  Installation successful!
echo  Next step: Quit Claude Desktop completely and launch it again.
echo ============================================================
echo.
pause
