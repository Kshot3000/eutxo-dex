@echo off
setlocal
cd /d "%~dp0"
set PORT=8080
start "" http://localhost:%PORT%/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
endlocal
