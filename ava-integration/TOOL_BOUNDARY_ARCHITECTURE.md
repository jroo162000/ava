# Tool Execution Boundary Architecture

## Single Execution Boundary Rule

**All tool execution flows through ONE and ONLY ONE boundary: the Node layer.**

The boundary is implemented in:
- `ava-server/src/services/tools.js` - The ToolsService class
- `ava-server/src/routes/tools.js` - The `/tools/:name/execute` endpoint

## Architecture Diagram

```
+------------------+       Intent + Metadata       +------------------+
|                  | ---------------------------> |                  |
|  Python Voice    |                              |  Node Boundary   |
|  (standalone)    |       Tool Result            |  (ava-server)    |
|                  | <--------------------------- |                  |
+------------------+                              +------------------+
                                                         |
                                                         | Validated Request
                                                         v
                                                  +------------------+
                                                  |  Python Worker   |
                                                  |  (ava_python_    |
                                                  |   worker.py)     |
                                                  +------------------+
                                                         |
                                                         | Tool Runtime
                                                         v
                                                  +------------------+
                                                  |    cmpuse        |
                                                  |  (tool library)  |
                                                  +------------------+
```

## What the Boundary Provides

1. **Idempotency Cache** - Prevents duplicate command execution within 60-second TTL
2. **Security Validation** - Checks tool risk level, path security, dangerous commands
3. **Audit Logging** - Complete logging with request ID, timing, decision, result
4. **Rate Limiting** - Future support for per-tool rate limits

## Python's Role (Intent Producer)

Python components (voice runner, bridge) are PRODUCERS of intent. They:
- Process voice/text input
- Route intent and extract parameters
- Emit structured messages to Node boundary
- **NEVER** execute tools directly

### Correct Pattern

```python
# Good: Route through Node boundary
result = self.server_client.execute_tool(
    tool_name='fs_ops',
    args={'operation': 'list', 'path': '/home'},
    confirmed=True,
    source='voice_standalone'
)
```

### Forbidden Pattern

```python
# BAD: Direct tool execution (VIOLATION)
plan = Plan(steps=[Step(tool='fs_ops', args={...})])
results = self.agent.run(plan, force=True)  # DO NOT DO THIS
```

## Node's Role (Execution Gateway)

Node receives intent messages from Python and:
1. Validates request against security policies
2. Checks idempotency cache (blocks duplicates within TTL)
3. Logs the execution decision
4. Executes approved tools via Python worker
5. Records successful execution in idempotency cache
6. Returns result with full context

## Files Modified

### Enforcement Files

| File | Change |
|------|--------|
| `ava_standalone_realtime.py` | `handle_tool_call()` now routes through `server_client.execute_tool()` |
| `ava_bridge.py` | `/tool` endpoint proxies to Node instead of executing directly |
| `ava_python_worker.py` | `execute_tool` command remains but is only called by Node |
| `ava_server_client.py` | Added `execute_tool()` method for boundary routing |

### Boundary Implementation Files

| File | Purpose |
|------|---------|
| `ava-server/src/services/tools.js` | IdempotencyCache + executeTool with validation |
| `ava-server/src/routes/tools.js` | REST endpoint `/tools/:name/execute` |

## Idempotency Behavior

When a repeated command is detected:
1. Node returns `reason: 'idempotency_blocked'`
2. Voice runner shows: "I already did that recently"
3. User can say "do it again" to bypass with `bypass_idempotency: true`

## Verification

Run smoke test to verify boundary enforcement:
```bash
python scripts/smoke_test.py
```

Expected output:
```
[PASS] Single runner (no duplicates)
[PASS] Final-only transcript gating
[PASS] Idempotency cache (Node boundary)
[PASS] No loop indicators (config valid)
Results: 4/4 checks passed
```

## Scanning for Violations

To find potential violations, search for direct tool execution:
```bash
grep -rn "agent\.run\|tool\.run" *.py --include="*.py"
```

Acceptable locations:
- `ava_python_worker.py` - Internal runtime (called by Node)
- `test_*.py` - Test files
- `archive/` - Archived files

Violations (should not exist):
- Direct `agent.run()` in `ava_standalone_realtime.py`
- Direct `agent.run()` in `ava_bridge.py`
- Any other runtime Python file calling `agent.run()` directly
