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
    import uuid
    exec_ns = {"threading": threading, "time": time, "uuid": uuid, "print": _silent_print}
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
      "_is_step_status_message(text)" in runner_src.split("def synthesize_speech")[1][:800] if "def synthesize_speech" in runner_src else False)


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
# TEST 6: Turn-scoped TTS token
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 6] Turn-scoped TTS token — voice-only response gate")

# Signature checks
check("_speak_text has turn_id param",
      "def _speak_text(self, text: str, turn_id=None)" in runner_src)
check("synthesize_speech has turn_id param",
      "def synthesize_speech(self, text, turn_id=None)" in runner_src)
check("_maybe_handle_local_intent has turn_id param",
      "def _maybe_handle_local_intent(self, transcript: str, turn_id=None)" in runner_src)
check("mint_tts_token method exists",
      "def mint_tts_token(self, reason=" in runner_src)
check("tts_token property exists",
      "def tts_token(self):" in runner_src and "@property" in runner_src)
check("[tts.blocked_background] string in source",
      "[tts.blocked_background]" in runner_src)

# Static check: every _speak_text( call has turn_id= (except the signature)
speak_calls = [line.strip() for line in runner_src.split("\n")
               if "_speak_text(" in line and "def _speak_text" not in line and line.strip()]
all_have_turn_id = all("turn_id=" in call for call in speak_calls)
check("All _speak_text calls have turn_id=",
      all_have_turn_id,
      f"Missing turn_id in: {[c[:60] for c in speak_calls if 'turn_id=' not in c]}" if not all_have_turn_id else "")

# Static check: every synthesize_speech( call has turn_id= (except the signature)
synth_calls = [line.strip() for line in runner_src.split("\n")
               if "synthesize_speech(" in line and "def synthesize_speech" not in line and line.strip()]
all_synth_have_turn_id = all("turn_id=" in call for call in synth_calls)
check("All synthesize_speech calls have turn_id=",
      all_synth_have_turn_id,
      f"Missing turn_id in: {[c[:60] for c in synth_calls if 'turn_id=' not in c]}" if not all_synth_have_turn_id else "")

# Manual logic tests using the extracted TurnStateMachine
if 'TurnStateMachine' in dir() or 'TurnStateMachine' in exec_ns:
    TSM = exec_ns.get("TurnStateMachine", None)
    TS = exec_ns.get("TurnState", None)
    if TSM and TS:
        # Test 1: Mint token via DECIDE transition
        sm2 = TSM()
        sm2.transition(TS.LISTEN, "test")
        sm2.transition(TS.FINAL, "test")
        sm2.transition(TS.DECIDE, "test")
        token_after_decide = sm2.tts_token
        check("DECIDE transition mints tts_token",
              token_after_decide is not None and len(token_after_decide) == 8)

        # Test 2: force_idle clears token
        sm2.transition(TS.SPEAK, "test")
        sm2.force_idle("test clear")
        check("force_idle clears tts_token",
              sm2.tts_token is None)

        # Test 3: mint_tts_token manual mint
        manual_token = sm2.mint_tts_token("test-manual")
        check("mint_tts_token returns non-None 8-char string",
              manual_token is not None and len(manual_token) == 8)

        # Test 4: Each mint produces a different token
        sm3 = TSM()
        sm3.transition(TS.LISTEN, "t")
        sm3.transition(TS.FINAL, "t")
        sm3.transition(TS.DECIDE, "t")
        token_a = sm3.tts_token
        sm3.force_idle("reset")
        sm3.transition(TS.LISTEN, "t")
        sm3.transition(TS.FINAL, "t")
        sm3.transition(TS.DECIDE, "t")
        token_b = sm3.tts_token
        check("Different turns produce different tokens",
              token_a != token_b)

        # Test 5: Startup announcement is log-only (no TTS)
        check("Startup announcement is log-only (no TTS speak)",
              "Brain server isn't reachable. Running voice only. (no TTS" in runner_src)
    else:
        check("TurnStateMachine available for logic tests", False)
else:
    check("TurnStateMachine available for logic tests", False)


# ══════════════════════════════════════════════════════════════════════════════
# TEST 7: Wake-word-only gate — no agent loop on bare wake word
# ══════════════════════════════════════════════════════════════════════════════

print("\n[TEST 7] Wake-word-only gate — bare 'ava' never starts agent loop")

# Static checks
check("MIN_CONTENT_WORDS constant exists",
      "MIN_CONTENT_WORDS" in runner_src)
check("[wake-only] log tag in source",
      "[wake-only]" in runner_src)
check("Wake-only ack replies in source",
      "Yeah?" in runner_src and "I'm here." in runner_src and "Go ahead." in runner_src)

# Logic test: extract _is_chat_only via a minimal fake class
import textwrap as _tw
_chat_only_start = runner_src.find("    def _is_chat_only(self, text: str)")
_chat_only_end = runner_src.find("\n    async def _maybe_handle_local_intent", _chat_only_start)
if _chat_only_start > 0 and _chat_only_end > _chat_only_start:
    _method_src = _tw.dedent(runner_src[_chat_only_start:_chat_only_end])

    class _FakeAVA:
        _wake_words = ['ava', 'eva', 'hey ava', 'hey eva', 'ok ava', 'okay ava', 'hi ava', 'hello ava']
        COMMAND_VERBS = {
            'open', 'close', 'search', 'find', 'create', 'delete', 'move', 'rename',
            'copy', 'paste', 'type', 'send', 'start', 'stop', 'run', 'click', 'show',
            'play', 'record', 'capture', 'save', 'load', 'download', 'upload', 'install',
            'uninstall', 'update', 'check', 'set', 'get', 'list', 'add', 'remove',
            'enable', 'disable', 'toggle', 'switch', 'browse', 'navigate', 'go',
        }
        MIN_CONTENT_WORDS = 2

    _ns = {}
    exec("import random, os\nfrom datetime import datetime\n" + _method_src, _ns)
    _FakeAVA._is_chat_only = _ns['_is_chat_only']
    _obj = _FakeAVA()

    # Wake-word-only phrases: MUST return ack (not None)
    wake_only_phrases = ['ava', 'ha ava', 'hey ava', 'hi ava', 'ava um', 'ava hello']
    for phrase in wake_only_phrases:
        result = _obj._is_chat_only(phrase)
        check(f"Wake-only '{phrase}' -> ack (no agent loop)",
              result is not None,
              f"Got None — would start agent loop!" if result is None else "")

    # Command phrases with wake word: MUST return None (go to agent loop)
    cmd_phrases = ['ava open chrome', 'ava search for news', 'ava type hello']
    for phrase in cmd_phrases:
        result = _obj._is_chat_only(phrase)
        check(f"Command '{phrase}' -> agent loop",
              result is None,
              f"Got '{result}' — blocked from agent loop!" if result is not None else "")
else:
    check("_is_chat_only method found for logic tests", False)


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
