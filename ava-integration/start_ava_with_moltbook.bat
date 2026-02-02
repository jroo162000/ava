@echo off
echo Starting AVA with Moltbook integration...
cd /d "C:\Users\USER 1\ava-integration"

REM Run Moltbook heartbeat first
echo [Moltbook] Running heartbeat check...
python moltbook_heartbeat.py

REM Start AVA voice
echo [AVA] Starting voice assistant...
python ava_standalone_realtime.py

pause
