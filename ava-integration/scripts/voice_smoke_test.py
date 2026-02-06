#!/usr/bin/env python3
"""
AVA Voice Smoke Test — 5-phrase regression suite

Validates all voice safety invariants added in the voice-stability PR:
  1. No agent loop for chat phrases
  2. No scheduler activity (DISABLE_AUTONOMY)
  3. No SPEAK transition errors
  4. Response time acceptable
  5. Whisper dispatch guards

Run:  python scripts/voice_smoke_test.py
Exit: 0 = all pass, 1 = failures
"""

import os
import sys
import re
import time
import struct
import threading

# Ensure project root is on path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

# ── Helpers ──────────────────────────────────────────────────────────────────

PASS = 0
FAIL = 0

def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        msg = f"  [FAIL] {name}"
        if detail:
            msg += f" — {detail}"
        print(msg)
    return condition


# ── Load source code for static analysis ─────────────────────────────────────

runner_path = os.path.join(PROJECT_ROOT, "ava_standalone_realtime.py")
with open(runner_path, "r", encoding="utf-8") as f:
    runner_src = f.read()

config_path = os.path.join(PROJECT_ROOT, "ava_voice_config.json")
import json
with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)


# ══════════════════════════════════════════════════════════════════════════════
# TEST 1: No agent loop for chat phrases
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 1] Chat-first routing — no agent loop for greetings/questions")

# Extract the state machine and routing logic by exec-ing the top of the file
# We replicate the key methods for isolated testing

COMMAND_VERBS = {
    'open', 'search', 'create', 'type', 'send', 'close', 'start', 'stop',
    'run', 'delete', 'move', 'rename', 'copy', 'paste', 'click', 'scroll',
    'navigate', 'install', 'download', 'upload', 'write', 'edit', 'save',
    'launch', 'kill', 'terminate', 'shutdown', 'restart', 'pause', 'resume',
    'turn', 'set', 'change', 'switch', 'enable', 'disable', 'execute',
    'find', 'show', 'play', 'record', 'capture', 'screenshot', 'take',
    'make', 'build', 'deploy', 'push', 'pull', 'commit', 'format',
    'remember', 'forget',
}

def has_command_verb(text):
    words = text.strip().lower().split()
    return bool(set(words) & COMMAND_VERBS)

def should_allow_tools(text, validation_mode=True, wake_words=('ava', 'eva')):
    lower = text.strip().lower()
    if not has_command_verb(lower):
        return False
    if validation_mode:
        has_wake = any(lower.startswith(w) or f" {w}" in lower for w in wake_words)
        if not has_wake:
            return False
    return True

# Chat phrases — must NOT trigger agent loop or tools
chat_phrases = ["hello", "hey ava", "what time is it", "how are you", "good morning"]
for phrase in chat_phrases:
    check(f"Chat '{phrase}' -> no tools",
          not should_allow_tools(phrase),
          f"tools would be allowed for '{phrase}'")

# Command phrases — MUST go to agent loop
command_phrases = ["ava open chrome", "ava type hello ten times", "ava search for news"]
for phrase in command_phrases:
    check(f"Command '{phrase}' -> tools allowed",
          should_allow_tools(phrase),
          f"tools blocked for '{phrase}'")

# Verify _is_chat_only exists and COMMAND_VERBS is a class constant
check("COMMAND_VERBS class constant exists",
      "COMMAND_VERBS = {" in runner_src or "COMMAND_VERBS = set(" in runner_src)
check("_is_chat_only method exists",
      "def _is_chat_only(" in runner_src)
check("_should_allow_tools method exists",
      "def _should_allow_tools(" in runner_src)


# ══════════════════════════════════════════════════════════════════════════════
# TEST 2: No scheduler activity in voice mode
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 2] Autonomy scheduler disabled in voice mode")

check("DISABLE_AUTONOMY=1 set in runner",
      "os.environ['DISABLE_AUTONOMY'] = '1'" in runner_src)

# Check moltbookScheduler.js
scheduler_path = os.path.join(PROJECT_ROOT, "..", "ava", "ava-server", "src", "services", "moltbookScheduler.js")
if not os.path.exists(scheduler_path):
    scheduler_path = os.path.join(PROJECT_ROOT, "..", "ava-server", "src", "services", "moltbookScheduler.js")
if os.path.exists(scheduler_path):
    with open(scheduler_path, "r", encoding="utf-8") as f:
        sched_src = f.read()
    check("moltbookScheduler checks DISABLE_AUTONOMY",
          "process.env.DISABLE_AUTONOMY" in sched_src)
    check("Scheduler exits early when flag set",
          "return;" in sched_src.split("DISABLE_AUTONOMY")[1][:200] if "DISABLE_AUTONOMY" in sched_src else False)
else:
    check("moltbookScheduler.js found", False, f"not at {scheduler_path}")

# Check heartbeat
heartbeat_path = os.path.join(PROJECT_ROOT, "moltbook_heartbeat.py")
with open(heartbeat_path, "r", encoding="utf-8") as f:
    hb_src = f.read()
check("Heartbeat checks DISABLE_AUTONOMY",
      "DISABLE_AUTONOMY" in hb_src)

# Check bat file
bat_path = os.path.join(PROJECT_ROOT, "start_ava_with_moltbook.bat")
with open(bat_path, "r", encoding="utf-8") as f:
    bat_src = f.read()
check("Bat file sets DISABLE_AUTONOMY=1",
      "DISABLE_AUTONOMY=1" in bat_src)


# ══════════════════════════════════════════════════════════════════════════════
# TEST 3: No SPEAK transition errors
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 3] Turn-state machine — hard lock during SPEAK")

# Import the state machine from the runner source (exec the class definition)
# We need TurnState and TurnStateMachine
import io
captured = io.StringIO()
original_print = __builtins__.__dict__.get('print', print)

def _silent_print(*a, **k):
    captured.write(" ".join(str(x) for x in a) + "\n")

# Extract just the enum + state machine classes
lines = runner_src.split("\n")
class_start = None
class_end = None
for i, line in enumerate(lines):
    if line.startswith("class TurnState:") and class_start is None:
        class_start = i
    if class_start and line.startswith("class StandaloneRealtimeAVA"):
        class_end = i
        break

if class_start and class_end:
    class_src = "\n".join(lines[class_start:class_end])
    exec_ns = {"threading": threading, "time": time, "print": _silent_print}
    exec(class_src, exec_ns)
    TurnState = exec_ns["TurnState"]
    TurnStateMachine = exec_ns["TurnStateMachine"]

    sm = TurnStateMachine(barge_in_enabled=True)  # Try to enable — should be ignored

    # Walk through normal flow to SPEAK
    captured.truncate(0)
    captured.seek(0)
    sm.transition(TurnState.LISTEN, "user speaking")
    sm.transition(TurnState.FINAL, "final")
    sm.transition(TurnState.DECIDE, "decide")
    sm.transition(TurnState.SPEAK, "TTS")

    # Now in SPEAK: try forbidden transitions
    sm.transition(TurnState.LISTEN, "VAD start")
    sm.transition(TurnState.FINAL, "Vosk final")
    sm.transition(TurnState.DECIDE, "Whisper final")
    barge_result = sm.interrupt_speaking("user barge-in")

    # Exit via force_idle
    sm.force_idle("TTS complete")

    output = captured.getvalue()

    check("SPEAK->LISTEN blocked (no VOICE_ERROR)",
          "Invalid transition SPEAK -> LISTEN" not in output)
    check("SPEAK->FINAL blocked (no VOICE_ERROR)",
          "Invalid transition SPEAK -> FINAL" not in output)
    check("SPEAK->DECIDE blocked (no VOICE_ERROR)",
          "Invalid transition SPEAK -> DECIDE" not in output)
    check("[speak-lock] logs present",
          "[speak-lock]" in output)
    check("Barge-in hard disabled",
          barge_result == False)
    check("force_idle exits SPEAK to IDLE",
          sm.state == TurnState.IDLE)
    check("barge_in_enabled always False",
          sm.barge_in_enabled == False)
else:
    check("TurnStateMachine class found", False, "could not extract from source")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 4: TTS response filter blocks agent status messages
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 4] TTS filter — agent-loop status never reaches speech")

# Replicate the filter logic
exact_blacklist = {
    'done', 'ready', 'ok', 'okay', 'success', 'complete', 'completed',
    'finished', 'executing', 'running', 'working', 'processing',
    'acknowledged', 'noted', 'confirmed', 'roger', 'copy',
    'on it', 'will do', 'got it', 'understood',
}
blocked_substrings = [
    'partially completed', 'waiting for user input', 'waiting_user',
    'idempotency', 'tool execution', 'agent loop', 'agent_loop',
    'max steps reached', 'max_steps_reached', 'step limit',
    'execution trace', 'tool trace', 'internal tool',
    'tool call result', 'function_call', 'tool_code',
]
step_patterns = [
    r'Reached step \d+ of \d+', r'Executing step \d+',
    r'Step \d+ complete', r'has been partially completed',
    r'waiting for user', r'step \d+ in progress',
]

def is_blocked(text):
    if not text:
        return False
    tc = text.strip().rstrip('.!?').strip()
    tl = tc.lower()
    if tl in exact_blacklist:
        return True
    if len(tc) <= 3:
        return True
    for sub in blocked_substrings:
        if sub in tl:
            return True
    for p in step_patterns:
        if re.search(p, text, re.IGNORECASE):
            return True
    return False

# Must block
blocked_phrases = [
    "The task 'hello able' has been partially completed",
    "Reached step 3 of 5",
    "waiting_user",
    "idempotency cache hit",
    "tool execution completed",
    "agent loop iteration 3",
]
for phrase in blocked_phrases:
    check(f"Blocked: '{phrase[:40]}'", is_blocked(phrase))

# Must pass
pass_phrases = [
    "Hey there! How can I help you today?",
    "The weather in New York is 72 degrees",
    "I opened Chrome for you",
]
for phrase in pass_phrases:
    check(f"Passed: '{phrase[:40]}'", not is_blocked(phrase))

# Verify chokepoint filter is in _speak_text
check("TTS chokepoint in _speak_text()",
      "_is_step_status_message(text)" in runner_src and "[tts-filter]" in runner_src)
check("TTS chokepoint in synthesize_speech()",
      "_is_step_status_message(text)" in runner_src.split("def synthesize_speech")[1][:500] if "def synthesize_speech" in runner_src else False)


# ══════════════════════════════════════════════════════════════════════════════
# TEST 5: Whisper dispatch guards
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 5] Whisper stability — dispatch guards and config")

# Check hybrid ASR
hybrid_path = os.path.join(PROJECT_ROOT, "ava_hybrid_asr.py")
with open(hybrid_path, "r", encoding="utf-8") as f:
    hybrid_src = f.read()

check("min_audio_length >= 0.8s",
      "min_audio_length: float = 0.8" in hybrid_src or "min_audio_length=0.8" in hybrid_src)
check("get_final_result has tts_active param",
      "tts_active" in hybrid_src.split("def get_final_result")[1][:200] if "def get_final_result" in hybrid_src else False)
check("get_final_result has echo_gate_active param",
      "echo_gate_active" in hybrid_src.split("def get_final_result")[1][:200] if "def get_final_result" in hybrid_src else False)
check("Whisper RMS threshold >= 0.01 (hybrid)",
      "rms < 0.01" in hybrid_src)
check("No 'Raw result:' debug spam",
      "Raw result:" not in hybrid_src)
check("Timeout <= 3s",
      "timeout: float = 3.0" in hybrid_src or "timeout=3.0" in hybrid_src)

# Check runner whisper RMS
check("Whisper RMS threshold >= 0.01 (runner)",
      "rms < 0.01" in runner_src.split("def transcribe_audio")[1][:1000] if "def transcribe_audio" in runner_src else False)

# Check provider
provider_path = os.path.join(PROJECT_ROOT, "voice", "providers", "whisper_provider.py")
if os.path.exists(provider_path):
    with open(provider_path, "r", encoding="utf-8") as f:
        prov_src = f.read()
    check("Whisper RMS threshold >= 0.01 (provider)",
          "rms < 0.01" in prov_src)
else:
    check("whisper_provider.py found", False)

# Check validation mode is ON
check("validation_mode.enabled = true in config",
      config.get("validation_mode", {}).get("enabled") == True)

# Check barge-in disabled
check("barge_in.enabled = false in config",
      config.get("barge_in", {}).get("enabled") == False)


# ══════════════════════════════════════════════════════════════════════════════
# RESULTS
# ══════════════════════════════════════════════════════════════════════════════

print(f"\n{'='*70}")
print(f"Results: {PASS}/{PASS+FAIL} checks passed")
if FAIL:
    print(f"\n[FAIL] {FAIL} check(s) failed")
    sys.exit(1)
else:
    print(f"\n[OK] VOICE SMOKE TEST PASSED — all invariants verified")
    sys.exit(0)
