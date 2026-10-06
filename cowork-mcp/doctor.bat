@echo off
setlocal enabledelayedexpansion
title chat2work (cowork-mcp) Environment Doctor

echo ============================================================
echo   chat2work: cowork-mcp - Environment & Dependency Doctor
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
    echo [ERROR] Node.js was not found. Please install Node.js first.
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\doctor.mjs"
echo.
pause
