@echo off
echo ================================================================================
echo AVA STANDALONE - REALTIME VOICE MODE
echo ================================================================================
echo.
echo Starting AVA in always-on mode with Realtime Voice API...
echo.
echo Features:
echo   - Always listening (no wake word needed)
echo   - Bidirectional realtime voice conversation
echo   - Sub-second response latency
echo   - Can interrupt AVA mid-sentence
echo   - Full access to all 20 AVA tools
echo   - Smart Voice Activity Detection
echo.
echo Press Ctrl+C to shutdown AVA
echo.
echo ================================================================================
echo.

cd "C:\Users\USER 1\ava-integration"
python ava_standalone_realtime.py

pause
