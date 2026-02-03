@echo off
echo ================================================================================
echo AVA STANDALONE - VALIDATION MODE
echo ================================================================================
echo.
echo Starting AVA in VALIDATION MODE for human testing...
echo.
echo VALIDATION MODE restrictions:
echo   - Wake word required ("AVA", "Hey AVA", etc.)
echo   - Proactive assistance DISABLED
echo   - Passive learning DISABLED
echo   - Barge-in DISABLED (half-duplex only)
echo   - Camera tool BLOCKED
echo   - Short utterances (less than 3 words) without wake word IGNORED
echo.
echo Say "AVA [command]" to interact.
echo Press Ctrl+C to shutdown AVA
echo.
echo ================================================================================
echo.

cd "C:\Users\USER 1\ava-integration"
set VALIDATION_MODE=1
python ava_standalone_realtime.py

pause
