# AVA Crash Supervisor & Safe Mode

Quick reference for process supervision, crash recovery, and safe mode operation.

## Preflight Checks

Run before starting AVA to validate system readiness:

```bash
python scripts/preflight_check.py
```

**Checks performed:**
| Check | What it validates |
|-------|-------------------|
| PyAudio | Library installed, PortAudio available |
| Audio Devices | Input/output devices enumerated |
| Sample Rate | 22050 Hz compatibility |
| Config File | ava_voice_config.json valid JSON |
| Piper TTS | Executable and model files exist |
| Vosk Model | ASR model available |

Exit code 0 = all critical checks pass, safe to start.

## Crash Supervisor

Run AVA under supervision with automatic crash recovery:

```bash
python scripts/crash_supervisor.py
```

**What it does:**
- Runs preflight checks before starting
- Spawns `ava_standalone_realtime.py` as subprocess
- Monitors for crashes (exit code != 0)
- Auto-restarts with exponential backoff
- Enters safe mode after repeated crashes
- Writes crash reports on unexpected exits

**Options:**
```bash
python scripts/crash_supervisor.py --preflight-only   # Run preflight only
python scripts/crash_supervisor.py --simulate-crash 1 # Test crash handling
python scripts/crash_supervisor.py --help             # Show help
```

## Safe Mode

Safe mode disables fragile features to keep core functionality alive after repeated crashes.

**What safe mode disables:**
| Feature | Normal | Safe Mode |
|---------|--------|-----------|
| Barge-in | Enabled | **Disabled** |
| Realtime ASR | Enabled | Configurable |

**When safe mode activates:**
- After 3 crashes within 5 minutes (configurable)
- Logged: `[SAFE_MODE] Entering safe mode after repeated crashes`

**Manual safe mode:**
```bash
AVA_SAFE_MODE=1 python ava_standalone_realtime.py
```

**Configuration (ava_voice_config.json):**
```json
"safe_mode": {
  "enabled": false,
  "disable_barge_in": true,
  "disable_realtime_asr": false
}
```

## Crash Reports & State Files

**Crash reports location:**
```
logs/crash_reports/crash_YYYYMMDD_HHMMSS.json
```

**Crash report contents:**
- `exit_code` - Process exit code
- `is_segfault` - True if exit code indicates native crash
- `runtime_seconds` - How long runner was alive
- `turn_state` - Last known turn state (IDLE/LISTEN/SPEAK/etc)
- `audio_backend` - Sample rate, device indices
- `config_flags` - barge_in, half_duplex, echo_cancellation
- `last_200_log_lines` - Recent log output

**Runner state file:**
```
logs/runner_state.json
```

Updated every 2 seconds while runner is alive. Contains:
- `timestamp` - Last update time
- `turn_state` - Current state machine state
- `safe_mode` - Whether safe mode is active
- `running` - Whether runner is active

## Configuration Reference

```json
"crash_supervision": {
  "enabled": true,
  "max_restarts": 5,
  "restart_window_sec": 300,
  "initial_backoff_sec": 3,
  "max_backoff_sec": 60,
  "safe_mode_after_crashes": 3,
  "crash_report_dir": "logs/crash_reports",
  "state_file": "logs/runner_state.json"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| max_restarts | 5 | Max restarts before giving up |
| restart_window_sec | 300 | Window for counting restarts |
| initial_backoff_sec | 3 | First restart delay |
| max_backoff_sec | 60 | Maximum restart delay |
| safe_mode_after_crashes | 3 | Crashes before safe mode |

## Segfault Detection

Exit codes recognized as native crashes:
- `-11` / `139` - SIGSEGV (segmentation fault)
- `-6` / `134` - SIGABRT (abort)
- `3221225477` - Windows access violation

These trigger crash reports with `is_segfault: true`.
