# AVA Startup

This document identifies the legacy startup/tray AVA instance so it is not confused with the realtime AVA voice runtime.

## Identity

- Name: AVA Startup
- Entry point: `C:\Users\USER 1\ava\ava-integration\ava_tray.pyw`
- Startup shortcut: `C:\Users\USER 1\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\AVA Assistant.lnk`
- Launch command: `pythonw.exe "C:\Users\USER 1\ava\ava-integration\ava_tray.pyw"`
- Parent at login: `explorer.exe`
- Runtime package: `C:\Users\USER 1\cmp-use`

## Behavior

- Auto-starts at Windows login through the user Startup folder.
- Creates a system tray icon.
- Starts listening automatically about one second after launch.
- Uses `cmpuse.voice.VoiceLoop` with wake word `ava`.
- Uses `speech_recognition`; it prefers Sphinx if installed and otherwise falls back to Google recognition.
- Uses `cmpuse.tts.speak` for responses.
- OpenAI TTS output is saved as MP3 files under `C:\Users\USER 1\.cmpuse\temp`.
- On Windows, playback uses `os.startfile(...)`, which opens the MP3 through the default media player.

## Status On 2026-06-12

- Running process found: `pythonw.exe` PID `9516`.
- Command line: `pythonw.exe "C:\Users\USER 1\ava\ava-integration\ava_tray.pyw"`.
- Process was stopped manually for this debugging phase.
- Startup shortcut was left in place, so AVA Startup may launch again after the next login unless disabled separately.

## Separation From Realtime AVA

AVA Startup is not the realtime AVA runtime.

- Realtime AVA entry point: `ava_standalone_realtime.py`
- Realtime AVA voice path: local hybrid ASR, local TTS routing, explicit device selection, wake/validation gating.
- AVA Startup voice path: `cmp-use` tray loop, simple wake-word containment, MP3 file playback through Windows.

## Operational Note

Do not use AVA Startup for realtime voice debugging unless intentionally testing this legacy tray path. It can compete for the microphone and can produce responses through the default media player.
