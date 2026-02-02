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
AVA_REPO_ROOT = os.path.join(os.path.dirname(PROJECT_ROOT), "ava")
NODE_TOOLS_SERVICE = os.path.join(AVA_REPO_ROOT, "ava-server", "src", "services", "tools.js")

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


def main():
    print("=" * 60)
    print("AVA CANONICAL SMOKE TEST")
    print("=" * 60)
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Canonical runner: {CANONICAL_RUNNER}")
    print("-" * 60)

    check_single_runner()
    check_final_only_gating()
    check_idempotency()
    check_no_loop_indicators()

    print("-" * 60)
    passed = sum(1 for _, p in results if p)
    total = len(results)
    print(f"Results: {passed}/{total} checks passed")

    if passed == total:
        print("\n[OK] SMOKE TEST PASSED - Safe to proceed")
        return 0
    else:
        print("\n[XX] SMOKE TEST FAILED - Do not proceed until fixed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
