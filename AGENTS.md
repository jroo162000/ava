# AVa Development Notes

## Canonical Runtime

- Repository paths must be discovered from the checkout; do not embed a user-profile path in code.
- `ava-integration/ava_local_voice.py` is the only canonical voice runner.
- `START_AVA.bat` delegates to `docs/start_ava.ps1`, which owns the server, UI, voice runner,
  health checks, logs, duplicate prevention, and watchdog.
- Never start `ava_standalone_realtime.py` as the normal runner.
- Do not set `DISABLE_AUTONOMY` during normal voice use. Moltbook learning and proposal scans run
  inside the canonical server on their configured cadence.

## Change Safety

- Back up every file before editing it and preserve all user or generated work already present.
- Do not alter wake-word, microphone, or audio settings unless live evidence identifies that layer.
- Do not weaken the approval gate in `ava_self_modification.py` or its protected companion files.
- Approved self-modifications are syntax-checked, sandbox-tested where configured, and reloaded by
  the server restart helper; the canonical watchdog reconnects the rest of the stack.

## Sources Of Truth

- Runtime capabilities: `ava-server/src/services/capabilityRegistry.js`
- Durable goals and receipts: `goalManager.js`, `workflowEngine.js`, `eventLedger.js`
- Proposals and reviews: `selfImprove.js`, `externalProposalReview.js`
- Local memory and learned procedures: `memory.js`, `skillStore.js`
- Moltbook learning and engagement: `moltbookScheduler.js`, `moltbookComposer.js`
