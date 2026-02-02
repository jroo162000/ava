# AVA Integration Lead Harness

This folder contains governance artifacts for the AVA voice system. These files are read at the start of every session to prevent context amnesia.

## Files

| File | Purpose |
|------|---------|
| `DECISIONS.md` | Irreversible architecture choices + session restart protocol |
| `ava_state.json` | Canonical runtime facts (paths, ports, feature flags) |
| `ava_feature_list.json` | Phase-based checklist (`passes: false` → `true` only) |
| `ava_progress.txt` | Session log (what changed, what test proved it, what's next) |

## Session Startup

```
1. Read all four files above
2. Run smoke test:
   cd "C:/Users/USER 1/ava-integration"
   python scripts/smoke_test.py
3. If smoke test fails → STOP, fix it first
4. Restate: canonical runner, tool boundary, current phase
```

## Canonical Facts

- **Runner:** `ava_standalone_realtime.py` (only one)
- **Tool boundary:** Node `/tools/:name/execute` (Python never executes directly)
- **Sample rate:** 22050 Hz
- **ASR:** Vosk (partials) + Whisper (finals)
- **Gating:** Finals only trigger tools, partials are display-only

## Subagents

| Agent | Allowed | Do NOT Touch |
|-------|---------|--------------|
| **Repo Curator** | File organization, archival, startup scripts | Tool boundary, ASR, voice code |
| **Tool Gate Engineer** | Node tools.js, routes, server client | Voice/ASR, turn-state, UI |
| **Voice Stabilizer** | Canonical runner, config, TTS | Node boundary, new ASR pipelines |
| **QA / Regression** | Tests only | Runtime behavior, production code |

## Workflow

```
Every cycle:
1. Read state + feature list
2. Select ONE passes:false item
3. Spawn ONE subagent with exact scope
4. Subagent implements → tests → reports back
5. Review diff → run smoke test → merge or reject
6. Update ava_progress.txt
7. Flip ONE feature to passes:true

No subagent talks directly to another.
```

## If Something Breaks

1. Run smoke test to identify failure
2. Fix the specific failure (don't proceed with other work)
3. Re-run smoke test until green
4. Resume normal workflow
