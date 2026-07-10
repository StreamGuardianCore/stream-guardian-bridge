@echo off
title Stream Guardian - OBS Bridge
set "BRIDGE_EXE=%~dp0StreamGuardian-OBS-Bridge.exe"
if not exist "%BRIDGE_EXE%" set "BRIDGE_EXE=%~dp0app\StreamGuardian-OBS-Bridge.exe"

if not exist "%BRIDGE_EXE%" (
  echo StreamGuardian-OBS-Bridge.exe could not be found.
  echo.
  echo Please extract the full zip first, then run this file from inside the extracted folder.
  pause
  exit /b 1
)

start "" "%BRIDGE_EXE%"
