@echo off
REM Start AVA in background mode with system tray
REM This will run AVA silently in the background

echo Starting AVA in background mode...

REM Try to use pythonw (silent mode) if available
where pythonw >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" pythonw "C:\Users\USER 1\ava-integration\ava_tray.pyw"
    echo AVA started in system tray. Look for the green icon.
) else (
    REM Fallback to regular python in minimized window
    start /min python "C:\Users\USER 1\ava-integration\ava_standalone.py"
    echo AVA started in minimized console window.
)

echo.
echo AVA is now running in the background!
echo Say "AVA" or "Hey AVA" to activate.
echo.
pause
