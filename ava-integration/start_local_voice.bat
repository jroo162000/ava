@echo off
setlocal

cd /d "%~dp0"

set "DISABLE_AUTONOMY=1"
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
set "AVA_TTS_CHUNKING=0"
set "AVA_TTS_SEGMENTING=0"
REM Tier 3 #20: mirror runner logs to logs\local_voice.log for VAD/barge tuning
set "AVA_LOCAL_VOICE_LOG=1"
REM Kokoro voice (Jelani picked Bella). AVA_TTS_KOKORO=0 would revert to Piper.
set "AVA_KOKORO_VOICE=af_bella"

echo ================================================================================
echo AVA LOCAL VOICE - MINIMAL HALF-DUPLEX RUNNER
echo ================================================================================
echo.
echo This runs ava_local_voice.py, not the legacy realtime monolith.
echo Say: Hey Ava, what is today?
echo Press Ctrl+C to stop.
echo.

REM Autonomous gaze tracker sidecar (camera -> gaze.target so her eyes follow you).
REM Single-instance guarded by a localhost socket lock; AVA_GAZE_OFF=1 disables.
if exist "%~dp0.venv\Scripts\python.exe" (
    start "AVA Gaze Tracker" /min "%~dp0.venv\Scripts\python.exe" "%~dp0gaze_tracker.py"
)

REM Use the project venv python (it has faster-whisper/pyaudio/etc.); bare "python" resolves to
REM the Microsoft Store stub on a fresh console and fails.
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" ava_local_voice.py
) else (
    python ava_local_voice.py
)

pause
