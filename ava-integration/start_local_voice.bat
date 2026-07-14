@echo off
setlocal
set "SUPERVISOR=%~dp0..\docs\start_ava.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SUPERVISOR%" -Action Start
endlocal
