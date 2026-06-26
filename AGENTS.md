# AGENTS.md — AVA project

## On resume / handoff (READ FIRST)
Before continuing AVA work, read **`C:\Users\USER 1\.codex\AVA_CODEX_RESUME_NOTES.md`**.
It has the current status, exactly what was last changed (files + lines), verified results, and a
prioritized "resume here" list. It is kept up to date as the running handoff between sessions.

## File-placement convention
- **AVA source / component files** live in this repo only: `C:\Users\USER 1\ava\...`
  (`ava-integration`, `ava-server`, `ava-client`). Never save AVA components to `.codex`.
- **`C:\Users\USER 1\.codex`** holds only status/handoff notes and backups — context for resuming.
- **Reusable helper scripts** from the last live session are in
  `C:\Users\USER 1\.codex\ava_session_helpers\` (e.g. `ava_proccheck.bat` = list AVA processes,
  `run_list_devices.bat`/`list_devices.py` = enumerate audio devices, `ava_restart_headset.bat` =
  kill + relaunch the runner, `ava_kill_dup.bat` = kill duplicate instances,
  `ava_live_mic_log.bat` = start the runner with logging to `.codex\ava_live_run.log`,
  `disable_ava_tray_autostart.bat`). They are utilities, not part of the AVA codebase — reuse as needed.

## Current state (set 2026-06-22 by the Cowork session)
- Voice runs on the **Logitech H5 headset mic** (`ava_voice_config.json` `input_device: 1`),
  **Whisper-based wake detection** (Vosk pre-gate disabled by default via
  `ava_local_voice.py` `wake_gate_after_no_wake` default `-1`), and **uncapped spoken replies**
  (`spoken_reply_budget` raised). All edits are UNCOMMITTED on branch `voice-stability-hardening`.
- **Always run exactly ONE `ava_local_voice.py` instance.** Duplicate instances caused the old
  split-audio / "responds once then stops" behavior. Kill strays before starting.
- Open items: commit the work (was blocked by a stale `.git/index.lock` while Codex ran), set a
  real `AVA_BRIDGE_TOKEN`, remove the unrelated "Browser Assistant" adware, and make the dashboard
  kill strays before launching a runner.
