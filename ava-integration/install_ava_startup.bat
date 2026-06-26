@echo off
setlocal

REM Add AVA to Windows startup so it runs when you login

echo Installing AVA to Windows Startup...
echo.

REM Create shortcut in Startup folder
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "AVA_PATH=%SCRIPT_DIR%\ava_tray.pyw"

REM Create VBS script to create shortcut
echo Set oWS = WScript.CreateObject("WScript.Shell") > CreateShortcut.vbs
echo sLinkFile = "%STARTUP_FOLDER%\AVA Assistant.lnk" >> CreateShortcut.vbs
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> CreateShortcut.vbs
echo oLink.TargetPath = "pythonw.exe" >> CreateShortcut.vbs
echo oLink.Arguments = """%AVA_PATH%""" >> CreateShortcut.vbs
echo oLink.WorkingDirectory = "%SCRIPT_DIR%" >> CreateShortcut.vbs
echo oLink.Description = "AVA - Your Personal AI Assistant" >> CreateShortcut.vbs
echo oLink.Save >> CreateShortcut.vbs

REM Run the VBS script
cscript CreateShortcut.vbs

REM Clean up
del CreateShortcut.vbs

echo.
echo SUCCESS! AVA has been added to Windows Startup.
echo.
echo AVA will now automatically start when you login to Windows.
echo You can find it in: %STARTUP_FOLDER%
echo.
echo To test it now, run: start_ava_background.bat
echo.
pause
