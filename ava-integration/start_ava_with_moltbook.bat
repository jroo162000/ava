@echo off
setlocal
set "SUPERVISOR=%~dp0..\docs\start_ava.ps1"
echo Moltbook learning is part of the canonical AVa server and is not a separate runner.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SUPERVISOR%" -Action Start
endlocal
