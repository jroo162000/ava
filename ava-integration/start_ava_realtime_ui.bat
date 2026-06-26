@echo off
setlocal

REM AVA Realtime Lab - developer UI for the canonical realtime voice runtime.
REM The UI stays active while ava_standalone_realtime.py is started/stopped from the browser.

cd /d "%~dp0"
set DISABLE_AUTONOMY=1

powershell -NoProfile -NonInteractive -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/api/status' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL%==0 (
  echo AVA Realtime Lab is already running. Opening http://127.0.0.1:8765/
  start "" "http://127.0.0.1:8765/"
  exit /b 0
)

echo ================================================================================
echo AVA REALTIME LAB
echo ================================================================================
echo.
echo Starting the local dashboard at http://127.0.0.1:8765/
echo.
echo Use the dashboard to:
echo   - Start, stop, and restart realtime AVA
echo   - Start the AVA brain server when it is down
echo   - Watch runtime logs
echo   - Run local development checks
echo   - See microphone, ASR, TTS, brain-server, and AVA Startup diagnostics
echo.
echo Close this window to stop the dashboard. Realtime AVA can be stopped from the UI.
echo.
echo ================================================================================
echo.

python ava_realtime_ui.py

pause
