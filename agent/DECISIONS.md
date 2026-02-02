# AVA Architecture Decisions

<!--
PURPOSE: Record irreversible architectural choices.
RULES FOR CLAUDE:
- Decisions here are FINAL. Do not reverse or contradict them.
- Only add new decisions when explicitly approved by user.
- Format: Decision ID, date, what was decided, why, enforcement mechanism.
- Reference these decisions when making implementation choices.
-->

---

# SESSION RESTART PROTOCOL

**MANDATORY: Every new Integration Lead session must start with these steps.**

## Step 1: Read State Files
```
agent/ava_state.json
agent/ava_feature_list.json
agent/ava_progress.txt
agent/DECISIONS.md
```

## Step 2: Run Smoke Test
```bash
cd "C:/Users/USER 1/ava-integration"
python scripts/smoke_test.py
```
If smoke test fails → STOP. Fix the failure before any other work.

## Step 3: Verbally Restate
Before any work, confirm:
- **Canonical runner:** `ava_standalone_realtime.py`
- **Tool boundary:** Node `/tools/:name/execute` (Python never executes directly)
- **Current phase:** Check `ava_feature_list.json` for `passes: false` items

This prevents "context amnesia" — the exact failure mode Anthropic warns about.

---

## D001: Canonical Voice Runner
**Date:** 2026-02-02
**Decision:** `ava_standalone_realtime.py` is the only voice runner.
**Rationale:** Multiple runner implementations caused confusion and bugs.
**Enforcement:** repo-curator agent archives any duplicate runners.

---

## D002: Node as Tool Execution Boundary
**Date:** 2026-02-02
**Decision:** All tool execution happens through the Node gateway only. Python returns text+metadata, never executes tools directly.
**Rationale:** Single execution boundary prevents duplicate runs, enables idempotency caching, and centralizes audit logging.
**Enforcement:** tool-gate-engineer agent audits and refactors violations.

---

## D003: Sample Rate is 22050 Hz
**Date:** 2026-02-02
**Decision:** All audio (mic, playback, TTS) uses 22050 Hz.
**Rationale:** Piper TTS outputs 22050 Hz natively. Resampling caused segfaults.
**Config:** `ava_voice_config.json` → `audio.playback_rate: 22050`

---

## D004: Hybrid ASR (Vosk + Whisper)
**Date:** 2026-02-02
**Decision:** Vosk for streaming partials, Whisper for accurate finals.
**Rationale:** Vosk provides low-latency feedback; Whisper provides accuracy for action triggers.

---

## D005: Barge-in Safety Gate
**Date:** 2026-02-02
**Status:** ACTIVE (blocks `barge_in` feature)

### Problem
Barge-in (allowing the mic to interrupt TTS) is a high-risk feature that can reintroduce:
- Self-echo loops (AVA responds to herself)
- Duplicate tool execution (partial/final churn under interruption)
- Turn-state corruption (two "turns" at once)
- Runaway repeats during reconnect/latency spikes

### Decision
Barge-in is disabled by default and stays disabled until all prerequisites below are satisfied and validated by automated tests and smoke checks.

### Prerequisites to Unblock D005
**All must be true:**

1. **Turn-state machine is authoritative**
   - State transitions are explicit and logged: `LISTEN → FINAL → DECIDE → SPEAK → IDLE`
   - No concurrent turns (one active turn max)

2. **Tool safety under interruption**
   - Tools execute only at the single boundary (Node)
   - Final-only gating remains enforced under barge-in conditions
   - Idempotency TTL blocks repeated tool calls under transcript churn

3. **Echo/feedback containment**
   At least one of the following is enforced during SPEAKING:
   - Mic muted (half-duplex), OR
   - Echo suppression/ducking proven reliable enough that AVA does not self-trigger

   (If barge-in is enabled, half-duplex is partially relaxed, so the alternative containment method must be validated.)

4. **Regression coverage**
   Add regression tests that prove:
   - PARTIAL never triggers tools (even when barge-in interrupts)
   - Duplicate finals within TTL do not execute tools twice
   - Interruption does not cause SPEAKING and LISTENING to overlap without a state transition
   - No-loop indicators remain clean after simulated interruption sequences

5. **Smoke test extension**
   The smoke test must include a "barge-in simulation" scenario that:
   - Starts TTS
   - Injects an interrupting transcript event
   - Verifies: correct state transition, no self-echo loop, tool gate remains stable

### Unblock Procedure
D005 is considered satisfied only when:
1. All prerequisite tests pass in CI/local
2. Smoke test passes
3. A PR explicitly flips `barge_in` from `passes:false` to `passes:true`
4. Integration Lead updates `ava_progress.txt` with what changed and what tests prove safety

### Rollback Rule
If enabling barge-in causes any regression (tests or smoke), immediately:
1. Disable barge-in
2. Restore the previous gating behavior
3. Record the failure mode in `ava_progress.txt`

**Config:** `allow_barge: false`

---

## D006: Half-Duplex Audio
**Date:** 2026-02-02
**Decision:** Mic suppressed during TTS playback.
**Rationale:** Prevents AVA from hearing herself speak.
**Config:** `echo_cancellation.suppress_tts_during_mic: true`

---

## D007: Final-Only Transcript Gating
**Date:** 2026-02-02
**Decision:** Only final transcripts trigger actions. Partials are display-only.
**Rationale:** Partial transcripts caused premature/incorrect tool execution.
**Enforcement:** voice-stabilizer agent implements gating.

---

## D008: TTS Serialization
**Date:** 2026-02-02
**Decision:** Only one TTS session active at a time. New speech cancels previous.
**Rationale:** Overlapping TTS caused queue overflow and crashes.

---

## D009: Watchdog for Crash Recovery
**Date:** 2026-02-02
**Decision:** `voice_watchdog.py` auto-restarts voice client on crash.
**Rationale:** Native library segfaults bypass Python error handling.

---

## D010: Module vs Runner Distinction
**Date:** 2026-02-02
**Decision:** Only standalone runner scripts are archived. Support modules required by the canonical runner must remain in place.
**Rationale:** `ava_hybrid_asr.py` was incorrectly archived as a "runner" when it's actually a module providing `HybridASREngine` to the canonical runner. This caused `HYBRID_ASR_AVAILABLE = False` at runtime.

**Modules that MUST NOT be archived:**
- `ava_hybrid_asr.py` (provides HybridASREngine)
- `ava_personality.py` (provides personality functions)
- `ava_server_client.py` (provides Node client)
- `corrected_tool_definitions.py` (provides CORRECTED_TOOLS)
- `voice/` package (provides unified voice scaffolding)

**Files that ARE runners (can be archived if non-canonical):**
- Files with `if __name__ == "__main__": asyncio.run(main())` as entry point
- Files that start audio capture/playback loops
- Files named `*_standalone*.py` or `*_voice.py` (check before archiving)

**Enforcement:** Before archiving any Python file, check if the canonical runner imports it.

---

# Subagent Scopes

## Repo Curator

**Allowed:**
- `ava-integration/**` (file organization)
- `ava-integration/archive/` (archival)
- Startup scripts (`*.ps1`, `*.bat`)
- README/docs related to starting AVa

**Do NOT Touch:**
- Node tool boundary logic (`ava-server/src/services/tools.js`)
- Python tool execution logic
- ASR logic inside canonical runner
- Voice capture/playback code

---

## Tool Gate Engineer

**Allowed:**
- `ava-server/src/services/tools.js` (tool execution boundary)
- `ava-server/src/routes/tools.js` (tool endpoints)
- `ava-integration/ava_server_client.py` (Node client)
- `ava-integration/ava_bridge.py` (only tool proxy logic)
- Smoke test adjustments for boundary detection

**Do NOT Touch:**
- Voice capture/ASR
- Turn-state logic
- Autonomy, curiosity, memory modules
- UI components
- TTS playback logic

---

## Voice Stabilizer

**Allowed:**
- `ava_standalone_realtime.py` (turn-state, gating, half-duplex)
- `ava_voice_config.json` (stability settings)
- `voice/session.py` (TTS coordination)
- `voice/tts/*.py` (TTS serialization)

**Do NOT Touch:**
- Node tool boundary (`ava-server/`)
- Tool execution logic
- New ASR pipelines (use existing Vosk+Whisper)
- UI components
- Memory/autonomy modules

---

## QA / Regression Agent

**Allowed:**
- `scripts/smoke_test.py`
- `ava-server/tests/` (unit tests)
- `ava-integration/tests/` (integration tests)
- New test files

**Do NOT Touch:**
- Runtime behavior (tests only, no implementation changes)
- Production code (except minimal hooks for testability)
- Config files (unless test-specific)
- Architecture decisions
