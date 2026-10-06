@echo off
setlocal enabledelayedexpansion
title Installing chat2work (cowork-mcp) for Claude Desktop...

echo ============================================================
echo   chat2work: Cowork MCP Server - Automatic Installer
echo ============================================================
echo.

:: 1. Locate Node.js
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "X86_PATH=%ProgramFiles(x86)%"
if not defined NODE_EXE if defined X86_PATH if exist "%X86_PATH%\nodejs\node.exe" set "NODE_EXE=%X86_PATH%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if defined NODE_EXE goto :node_found

echo [ERROR] Node.js was not found on your system!
echo.
echo cowork-mcp runs on Node.js - version 20 or newer recommended.
echo Please download and install Node.js from:
echo   https://nodejs.org/
echo.
echo After installing Node.js, run this install.bat again.
echo ============================================================
pause
exit /b 1

:node_found
echo [OK] Using Node.js: %NODE_EXE%
"%NODE_EXE%" -v
echo.

:: 2. Check and install npm dependencies
if exist "%~dp0node_modules\@modelcontextprotocol\sdk" goto :deps_found

echo [INFO] Installing npm dependencies...
pushd "%~dp0"
call npm install --no-audit --no-fund
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed. Please run 'npm install' manually.
    popd
    pause
    exit /b 1
)
popd
echo.

:deps_found

:: 3. Run the installer script
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
