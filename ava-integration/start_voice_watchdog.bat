@echo off
echo AVA Voice Watchdog - Auto-restart on crash
echo ============================================

:loop
echo.
echo [%date% %time%] Starting AVA voice client...
python ava_standalone_realtime.py
echo.
echo [%date% %time%] Voice client exited with code %errorlevel%
echo Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
