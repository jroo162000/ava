# AVA Realtime Lab UI

AVA Realtime Lab is a local browser dashboard for developing the canonical realtime voice runtime.

## Start The Dashboard

Run:

```bat
start_ava_realtime_ui.bat
```

Or:

```powershell
python ava_realtime_ui.py
```

The dashboard opens at:

```text
http://127.0.0.1:8765/
```

## What It Controls

The dashboard defaults to the canonical local voice runner:

```text
ava_local_voice.py
```

It also keeps legacy realtime controls available for comparison/debugging, but the local runner is the path used for current voice validation.

The dashboard itself is a separate process, so it stays alive while realtime AVA starts, stops, crashes, or restarts.

## What It Shows

- Realtime process status and PID.
- Start/stop/restart controls for realtime AVA.
- Start/stop controls for a dashboard-managed AVA brain server.
- Brain server health from `/health`.
- Microphone-loop readiness.
- Hybrid ASR readiness markers for Vosk and Whisper.
- TTS engine marker.
- Selected input and output device lines from the runtime log.
- Recent final transcripts and TTS previews.
- Runtime issue board built from known failure markers.
- Voice config snapshot.
- Optional PyAudio input/output device probe.
- One-click local checks for Python syntax, config, Piper, Vosk, brain health, and PyAudio.
- Direct local voice self-test using generated WAV input.
- Speaker-to-mic self-test using audible speaker playback into the selected mic.
- Failed-turn WAV analysis for recent captured utterance artifacts.
- Non-webcam input failover probe and apply flow.
- Live selected mic health in `Run Local Checks`, so checks warn when the runtime stack is healthy but the selected input is not hearing usable speech.
- Whether legacy `AVA Startup` / `ava_tray.pyw` is running and competing for the microphone.

## Runtime Logs

Each UI-launched realtime session writes logs to:

```text
logs\realtime_ui\session_YYYYMMDD_HHMMSS\
```

The dashboard tails:

```text
stdout.log
stderr.log
```

ASR trace is enabled by default when launched from the UI and points at the session log directory.

## Default Launch Safety

The UI starts realtime AVA with:

```text
DISABLE_AUTONOMY=1
PYTHONUNBUFFERED=1
PYTHONIOENCODING=utf-8
AVA_ASR_TRACE=1
AVA_LOOPBACK_PROBE=0
```

On Windows the UI launches the runner with:

```text
python -u ava_standalone_realtime.py
```

Set `AVA_REALTIME_PYTHON` before starting the dashboard if a specific Python executable is required.

By default it also clears device override environment variables before launch, so stale test variables do not silently hijack mic/speaker selection.

## Important Separation

This dashboard is for realtime AVA only.

Legacy startup/tray AVA is documented separately in:

```text
AVA_STARTUP.md
```

If `AVA Startup` is running, the dashboard reports it as a warning because it can compete for the microphone.

## Brain Server Control

The dashboard can start:

```text
C:\Users\USER 1\ava\ava-server\src\server.js
```

using:

```text
node src/server.js
```

It only stops a brain server that it started itself. If another server is already running, the dashboard reports it as available but does not kill that external process.

## Local Checks

The `Run Local Checks` button verifies the development basics without starting a live mic session:

- Required files exist.
- `ava_voice_config.json` parses.
- Core Python files compile.
- Piper executable/model paths exist.
- Vosk model directory exists.
- Webcam/C920e mic avoidance is configured.
- Brain server health responds.
- PyAudio can enumerate input/output devices.
- The deterministic local voice path can accept a generated wake-command WAV.
- If realtime AVA is running, the selected live mic is checked for real speech evidence instead of letting local checks look green while the mic is effectively deaf.

## Automated Voice Tests

Use `Direct Local Voice Self-Test` when no human can speak. It generates a clean local wake-command WAV and runs it through AVA's synthetic live-loop input mode. A pass proves calibration, VAD/capture, local Whisper finalization, wake cleanup, response generation, and Piper synthesis without depending on the physical mic or weak speaker bleed.

Use `Speaker-to-Mic Self-Test` only as an acoustic pickup diagnostic. It plays a synthetic wake-command through the speakers and records the selected mic. If this fails while the direct local test passes, do not lower VAD or rewrite ASR/TTS just to satisfy room bleed; fix the selected physical input, use a better non-webcam mic, or use a virtual audio route for automated loopback.

If the dashboard was already running before a code change, restart the dashboard process before trusting button behavior. The child voice runner can remain running, but the dashboard process only loads updated Python code at start.
## Live Voice Test Presets

The dashboard includes focused voice test presets so live sessions are repeatable:

- `Listen Only Test`: speak without the wake word and confirm AVA hears audio but does not answer.
- `Wake Word Test`: say `Hey Ava, are you listening?`, pause, and confirm a final transcript plus audible reply.
- `TTS Playback Test`: say `Hey Ava, what time is it?` and confirm audible speech plus `tts-in` / playback log markers.
- `Full Roundtrip Test`: say `Hey Ava, tell me one sentence about your audio status.` and confirm ASR, brain response, TTS playback, mic mute, and return to idle.

Each preset starts the normal realtime runner but tags the child process with `AVA_UI_TEST_PRESET` and `AVA_UI_TEST_LABEL`, then shows the exact phrase and expected log markers in the Live Voice Test Guide panel.
