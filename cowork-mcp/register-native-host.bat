@echo off
setlocal enabledelayedexpansion
title Claude in Chrome - Native Messaging Host Auto-Registration

echo ============================================================
echo   Claude in Chrome (Gateway Edition) Native Host Register
echo ============================================================
echo.

node "%~dp0scripts\register-host.mjs"

echo.
pause
