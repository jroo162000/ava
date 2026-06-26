@echo off
setlocal

REM Canonical local realtime voice launcher
REM Opens AVA Realtime Lab so the voice runtime can be started/stopped from a UI.

cd /d "%~dp0"
set DISABLE_AUTONOMY=1

echo ================================================================================
echo AVA REALTIME VOICE (LOCAL)
echo ================================================================================
echo.
echo Starting AVA Realtime Lab...
echo.
echo Current default profile:
echo   - Wake word required in validation mode
echo   - Silent follow-up window after wake
echo   - Local AVA server brain over /respond
echo   - Local Piper TTS playback
echo   - Dashboard remains active while realtime AVA starts/stops
echo   - Brain-server controls and local development checks
echo.
echo Use the browser UI to start, stop, restart, and diagnose realtime AVA.
echo Close this console window to end the dashboard.
echo.
echo ================================================================================
echo.

python ava_realtime_ui.py

pause
