@echo off
echo Starting AVA with Moltbook integration...
cd /d "C:\Users\USER 1\ava-integration"

REM Disable autonomy in voice mode - scheduler and heartbeat will exit early
set DISABLE_AUTONOMY=1
echo [autonomy] disabled (voice mode) — DISABLE_AUTONOMY=1

REM Run Moltbook heartbeat first (will skip due to DISABLE_AUTONOMY)
echo [Moltbook] Running heartbeat check...
python moltbook_heartbeat.py

REM Start AVA voice (passes DISABLE_AUTONOMY to Node server via env)
echo [AVA] Starting voice assistant...
python ava_standalone_realtime.py

pause
