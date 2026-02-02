# Voice System Regression Tests - Quick Reference

## Quick Start

### Run All Tests
```bash
cd "C:/Users/USER 1/ava/ava-integration"

# Smoke test (pre-session check)
python scripts/smoke_test.py

# Full regression test suite
python -m pytest tests/test_voice_invariants.py -v
```

## Critical Invariants

| Invariant | What It Protects | Test Class |
|-----------|------------------|------------|
| **Partial Safety** | Tools never execute on partial transcripts | TestPartialTranscriptSafety |
| **Node Boundary** | All tools flow through Node's executeTool() | TestNodeBoundaryEnforcement |
| **Idempotency** | Duplicates blocked within 60s TTL | TestIdempotencyGuarantee |
| **Half-Duplex** | Mic gated during SPEAKING state | TestHalfDuplexDiscipline |
| **State Transitions** | Valid state flow only | TestTurnStateTransitions |

## Valid State Flow

```
IDLE → LISTEN → FINAL → DECIDE → SPEAK → IDLE
```

Emergency brake: `force_idle()` resets from any state

## Test Files

- **Unit tests:** `tests/test_voice_invariants.py` (20 tests)
- **Smoke test:** `scripts/smoke_test.py` (9 checks)

## Before Every Session

```bash
python scripts/smoke_test.py
```

Exit code 0 = Safe to proceed
Exit code 1 = DO NOT PROCEED

## If Tests Fail

1. **Stop immediately**
2. Determine what changed
3. Fix the regression
4. Re-run tests
5. Commit fix

**NEVER:**
- Modify tests to make them pass
- Skip failing tests
- Comment out assertions

## Protected Components

- `ava_standalone_realtime.py` - Voice runner with TurnStateMachine
- `ava-server/src/services/tools.js` - Node execution boundary with IdempotencyCache
- `ava_voice_config.json` - Echo cancellation settings

## Quick Test Commands

```bash
# Run specific test class
pytest tests/test_voice_invariants.py::TestPartialTranscriptSafety -v

# Run specific test
pytest tests/test_voice_invariants.py::test_idempotency_cache_blocks_duplicates -v

# Run with detailed output
pytest tests/test_voice_invariants.py -vv --tb=long

# Run smoke test with verbose output
python scripts/smoke_test.py
```

## Success Criteria

- ✅ All 20 unit tests passing
- ✅ All 9 smoke checks passing
- ✅ No production code modified

---

**Last updated:** 2026-02-02
**Status:** ✅ All tests passing
**Guardian activated:** Regressions prevented
