@echo off
setlocal

cd /d "%~dp0"

set "DISABLE_AUTONOMY=1"
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
set "AVA_TTS_CHUNKING=0"
set "AVA_TTS_SEGMENTING=0"

echo ================================================================================
echo AVA LOCAL VOICE - MINIMAL HALF-DUPLEX RUNNER
echo ================================================================================
echo.
echo This runs ava_local_voice.py, not the legacy realtime monolith.
echo Say: Hey Ava, what is today?
echo Press Ctrl+C to stop.
echo.

python ava_local_voice.py

pause
