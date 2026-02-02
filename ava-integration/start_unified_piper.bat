@echo off
setlocal
set VOICE_UNIFIED=1
cd /d "%~dp0"
echo Starting AVA unified voice (Piper/Edge) in background...
start "AVA Unified" /min cmd /c "python ava_standalone_realtime.py 1^>standalone.out.log 2^>standalone.err.log"
echo Launched. Logs: standalone.out.log / standalone.err.log
endlocal

