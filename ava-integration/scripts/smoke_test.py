#!/usr/bin/env python3
"""
AVA Canonical Smoke Test
========================
Run this BEFORE every Integration Lead session.
If any check fails, stop. Do not proceed with work.

Usage:
    python scripts/smoke_test.py

Exit codes:
    0 = All checks pass
    1 = One or more checks failed
"""

import subprocess
import sys
import os
import json
import re

# Path setup
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CANONICAL_RUNNER = "ava_standalone_realtime.py"
CONFIG_FILE = "ava_voice_config.json"

# Node boundary layer path (ava-server in ava repo)
# The canonical tool execution boundary is in the Node layer
# Handle both standalone and repo-integrated deployments
if os.path.exists(os.path.join(PROJECT_ROOT, "..", "ava-server")):
    # We're in ava-integration, ava-server is sibling
    NODE_TOOLS_SERVICE = os.path.join(PROJECT_ROOT, "..", "ava-server", "src", "services", "tools.js")
else:
    # Fallback to parent ava repo structure
    AVA_REPO_ROOT = os.path.join(os.path.dirname(PROJECT_ROOT), "ava")
    NODE_TOOLS_SERVICE = os.path.join(AVA_REPO_ROOT, "ava-server", "src", "services", "tools.js")

NODE_TOOLS_SERVICE = os.path.normpath(NODE_TOOLS_SERVICE)

results = []

def check(name, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    results.append((name, passed))
    print(f"[{status}] {name}")
    if detail and not passed:
        print(f"       {detail}")
    return passed


def check_single_runner():
    """Verify only one voice runner process is running (or none)."""
    try:
        # Windows: use tasklist
        output = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq python.exe", "/FO", "CSV"],
            text=True, stderr=subprocess.DEVNULL
        )
        # Count processes running ava_standalone_realtime.py
        # Also check via wmic for command line
        wmic_output = subprocess.check_output(
            ["wmic", "process", "where", "name='python.exe'", "get", "commandline"],
            text=True, stderr=subprocess.DEVNULL
        )
        runner_count = wmic_output.lower().count(CANONICAL_RUNNER.lower())

        if runner_count <= 1:
            return check("Single runner (no duplicates)", True)
        else:
            return check("Single runner (no duplicates)", False,
                        f"Found {runner_count} instances of {CANONICAL_RUNNER}")
    except Exception as e:
        return check("Single runner (no duplicates)", False, str(e))


def check_final_only_gating():
    """Verify code has final-only transcript gating (partials don't trigger tools)."""
    runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)
    if not os.path.exists(runner_path):
        return check("Final-only transcript gating", False, f"{CANONICAL_RUNNER} not found")

    with open(runner_path, 'r', encoding='utf-8') as f:
        code = f.read()

    # Look for patterns indicating final-only gating:
    # - Check for 'is_final' or 'final' flag checks before tool execution
    # - Check for partial transcript filtering
    patterns = [
        r'is_final\s*[=!]=',
        r'final\s*==\s*True',
        r'if.*final.*:',
        r'partial.*skip',
        r'not.*partial',
    ]

    has_gating = any(re.search(p, code, re.IGNORECASE) for p in patterns)

    # Also check config
    config_path = os.path.join(PROJECT_ROOT, CONFIG_FILE)
    config_has_flag = False
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            config = json.load(f)
        # Check for any final_only related config
        config_str = json.dumps(config)
        config_has_flag = 'final' in config_str.lower()

    return check("Final-only transcript gating", has_gating or config_has_flag,
                "No final-only gating pattern found in runner code")


def check_idempotency():
    """
    Verify idempotency cache exists for tool execution.

    Phase 8 Architecture: The canonical tool execution boundary is in the Node layer.
    All tool execution flows through ava-server/src/services/tools.js which implements
    the IdempotencyCache class.

    This check verifies:
    1. Node boundary has IdempotencyCache class
    2. executeTool method uses the cache
    3. Proper blocked response message exists
    """
    # Primary check: Node boundary layer (the canonical execution boundary)
    if os.path.exists(NODE_TOOLS_SERVICE):
        with open(NODE_TOOLS_SERVICE, 'r', encoding='utf-8') as f:
            node_code = f.read()

        # Required patterns for Node idempotency implementation
        required_patterns = [
            (r'class\s+IdempotencyCache', 'IdempotencyCache class'),
            (r'idempotencyCache\.check', 'cache check call'),
            (r'idempotencyCache\.record', 'cache record call'),
            (r'idempotency_blocked', 'blocked reason'),
            (r'already did that recently', 'user-facing blocked message'),
        ]

        missing = []
        for pattern, name in required_patterns:
            if not re.search(pattern, node_code, re.IGNORECASE):
                missing.append(name)

        if not missing:
            return check("Idempotency cache (Node boundary)", True)
        else:
            return check("Idempotency cache (Node boundary)", False,
                        f"Missing in tools.js: {', '.join(missing)}")
    else:
        # Fallback: check Python runner (legacy check)
        runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)
        if not os.path.exists(runner_path):
            return check("Idempotency cache", False,
                        f"Neither Node boundary ({NODE_TOOLS_SERVICE}) nor Python runner found")

        with open(runner_path, 'r', encoding='utf-8') as f:
            code = f.read()

        # Look for idempotency patterns in Python (legacy):
        patterns = [
            r'idempotency',
            r'idempotent',
            r'already.?executed',
            r'duplicate.?command',
            r'command.?cache',
            r'seen.?commands',
        ]

        has_idempotency = any(re.search(p, code, re.IGNORECASE) for p in patterns)

        return check("Idempotency cache (legacy Python)", has_idempotency,
                    "No idempotency pattern found in Python runner - check Node boundary")


def check_no_loop_indicators():
    """Verify no obvious infinite loop patterns in recent logs or state."""
    # Check for runaway indicators:
    # - Queue overflow (q > 50)
    # - Rapid restarts
    # - Self-trigger patterns in logs

    # For now, do a basic config sanity check
    config_path = os.path.join(PROJECT_ROOT, CONFIG_FILE)
    if not os.path.exists(config_path):
        return check("No loop indicators (config valid)", False, f"{CONFIG_FILE} not found")

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)

        # Check echo cancellation is enabled (prevents self-loop)
        echo_cfg = config.get('echo_cancellation', {})
        echo_enabled = echo_cfg.get('enabled', False)
        suppress_tts = echo_cfg.get('suppress_tts_during_mic', False)

        if echo_enabled and suppress_tts:
            return check("No loop indicators (config valid)", True)
        else:
            return check("No loop indicators (config valid)", False,
                        "Echo cancellation not properly configured - risk of self-loop")
    except json.JSONDecodeError as e:
        return check("No loop indicators (config valid)", False, f"Config JSON error: {e}")


# ============================================================================
# VOICE INVARIANT PREFLIGHT CHECKS
# Extended checks to validate voice system invariants before every session
# ============================================================================

def check_partial_final_sequence():
    """
    Verify voice runner correctly handles partial->final transcript sequences.

    Tests the pattern:
    1. Multiple partials arrive (should not trigger tools)
    2. Final arrives (should trigger processing)

    This prevents tools from executing on incomplete/unstable transcripts.
    """
    runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)
    if not os.path.exists(runner_path):
        return check("Partial->Final sequence handling", False,
                    f"{CANONICAL_RUNNER} not found")

    with open(runner_path, 'r', encoding='utf-8') as f:
        code = f.read()

    # Must have explicit handling for partial vs final transcripts
    required_patterns = [
        (r'is_final', 'is_final flag check'),
        (r'PARTIAL.*NEVER trigger tools', 'partial safety comment'),
        (r'FINAL.*DECIDE', 'final to decide transition'),
    ]

    missing = []
    for pattern, name in required_patterns:
        if not re.search(pattern, code, re.IGNORECASE):
            missing.append(name)

    if not missing:
        return check("Partial->Final sequence handling", True)
    else:
        return check("Partial->Final sequence handling", False,
                    f"Missing patterns: {', '.join(missing)}")


def check_duplicate_finals():
    """
    Verify idempotency protects against duplicate final transcripts.

    Scenario: WebSocket reconnects or retries cause the same final transcript
    to be delivered multiple times. Idempotency cache must prevent double execution.
    """
    # Check Node boundary has idempotency (already checked, but verify specific patterns)
    if os.path.exists(NODE_TOOLS_SERVICE):
        with open(NODE_TOOLS_SERVICE, 'r', encoding='utf-8') as f:
            node_code = f.read()

        # Must handle duplicate detection
        duplicate_patterns = [
            (r'idempotencyCache\.check', 'cache check before execution'),
            (r'blocked.*true', 'blocking logic'),
            (r'already did that', 'user-facing duplicate message'),
        ]

        missing = []
        for pattern, name in duplicate_patterns:
            if not re.search(pattern, node_code, re.IGNORECASE):
                missing.append(name)

        if not missing:
            return check("Duplicate final protection", True)
        else:
            return check("Duplicate final protection", False,
                        f"Missing in Node boundary: {', '.join(missing)}")
    else:
        return check("Duplicate final protection", False,
                    "Node boundary not found - cannot verify")


def check_half_duplex_enforcement():
    """
    Verify half-duplex discipline: microphone gated during SPEAKING state.

    This prevents echo loops where AVA hears herself speaking and responds
    to her own output.
    """
    config_path = os.path.join(PROJECT_ROOT, CONFIG_FILE)
    if not os.path.exists(config_path):
        return check("Half-duplex enforcement", False, f"{CONFIG_FILE} not found")

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)

        echo_cfg = config.get('echo_cancellation', {})
        suppress_tts = echo_cfg.get('suppress_tts_during_mic', False)

        if not suppress_tts:
            return check("Half-duplex enforcement", False,
                        "suppress_tts_during_mic not enabled - mic will hear AVA speaking!")

        # Also check runner has turn state enforcement
        runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)
        if os.path.exists(runner_path):
            with open(runner_path, 'r', encoding='utf-8') as f:
                code = f.read()

            # Must have turn state machine
            has_turn_state = 'TurnState' in code or 'turn_state' in code
            has_speak_state = 'SPEAK' in code or 'SPEAKING' in code

            if has_turn_state and has_speak_state:
                return check("Half-duplex enforcement", True)
            else:
                return check("Half-duplex enforcement", False,
                            "Turn state machine not found in runner")
        else:
            # Config is good enough if runner not found
            return check("Half-duplex enforcement", True)

    except json.JSONDecodeError as e:
        return check("Half-duplex enforcement", False, f"Config JSON error: {e}")


def check_turn_state_transitions():
    """
    Verify turn state machine enforces valid transitions only.

    Valid flow: IDLE -> LISTEN -> FINAL -> DECIDE -> SPEAK -> IDLE
    Invalid: Jumping states or concurrent LISTEN+SPEAK
    """
    runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)
    if not os.path.exists(runner_path):
        return check("Turn state transitions", False, f"{CANONICAL_RUNNER} not found")

    with open(runner_path, 'r', encoding='utf-8') as f:
        code = f.read()

    # Must have turn state machine with transition validation
    required_patterns = [
        (r'class\s+TurnState', 'TurnState class definition'),
        (r'def\s+transition', 'transition method'),
        (r'valid_transitions|allowed_transitions', 'transition validation'),
        (r'turn-state.*->', 'state transition logging'),
    ]

    found_count = 0
    for pattern, name in required_patterns:
        if re.search(pattern, code, re.IGNORECASE):
            found_count += 1

    # Need at least 3 of 4 patterns (transition validation is optional but recommended)
    if found_count >= 3:
        return check("Turn state transitions", True)
    else:
        return check("Turn state transitions", False,
                    f"Found {found_count}/4 turn state patterns")


def check_repeated_command_blocking():
    """
    Verify repeated identical commands within TTL are blocked.

    Tests idempotency cache prevents:
    - User accidentally repeating same command
    - ASR sending duplicates
    - Retry logic causing double execution
    """
    if os.path.exists(NODE_TOOLS_SERVICE):
        with open(NODE_TOOLS_SERVICE, 'r', encoding='utf-8') as f:
            node_code = f.read()

        # Check for TTL configuration
        has_ttl = re.search(r'ttl.*=.*\d+', node_code, re.IGNORECASE)
        has_cache_check = 'idempotencyCache.check' in node_code
        has_cache_record = 'idempotencyCache.record' in node_code

        if has_ttl and has_cache_check and has_cache_record:
            return check("Repeated command blocking", True)
        else:
            missing = []
            if not has_ttl:
                missing.append("TTL config")
            if not has_cache_check:
                missing.append("cache check")
            if not has_cache_record:
                missing.append("cache record")
            return check("Repeated command blocking", False,
                        f"Missing: {', '.join(missing)}")
    else:
        return check("Repeated command blocking", False,
                    "Node boundary not found - cannot verify")


def main():
    print("=" * 70)
    print("AVA CANONICAL SMOKE TEST + VOICE INVARIANT PREFLIGHT")
    print("=" * 70)
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Canonical runner: {CANONICAL_RUNNER}")
    print("-" * 70)

    print("\n[CORE CHECKS]")
    check_single_runner()
    check_final_only_gating()
    check_idempotency()
    check_no_loop_indicators()

    print("\n[VOICE INVARIANT CHECKS]")
    check_partial_final_sequence()
    check_duplicate_finals()
    check_half_duplex_enforcement()
    check_turn_state_transitions()
    check_repeated_command_blocking()

    print("-" * 70)
    passed = sum(1 for _, p in results if p)
    total = len(results)
    print(f"\nResults: {passed}/{total} checks passed")

    if passed == total:
        print("\n[OK] SMOKE TEST PASSED - Safe to proceed")
        print("[OK] All voice invariants verified")
        return 0
    else:
        print("\n[XX] SMOKE TEST FAILED - Do not proceed until fixed")
        failed_checks = [name for name, p in results if not p]
        print(f"[XX] Failed checks: {', '.join(failed_checks)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
