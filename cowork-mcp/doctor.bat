@echo off
setlocal enabledelayedexpansion
title chat2work (cowork-mcp) Environment Doctor

echo ============================================================
echo   chat2work: cowork-mcp - Environment and Dependency Doctor
echo ============================================================
echo.

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "X86_PATH=%ProgramFiles(x86)%"
if not defined NODE_EXE if defined X86_PATH if exist "%X86_PATH%\nodejs\node.exe" set "NODE_EXE=%X86_PATH%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Please install Node.js first.
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\doctor.mjs"
echo.
pause
