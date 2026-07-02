# AVA Tier 3 Plan — The Stage, the Suite, and the Student

_Defined 2026-07-02 with Jelani, after Tier 2 (roadmap 10–15) completed and everything was
pushed to GitHub. The original roadmap (AVA_Full_Breakdown_and_Jarvis_Roadmap.md) ends at
Tier 2; this document continues its numbering. Pillars chosen: **finish Tier 2 debt**,
**autonomy depth**, and **the UI merge**._

Status of the world at Tier 3 start: streaming voice with barge-in live (491f7a9), self-mod
sandbox gating approvals (0202273), action-landed verification (45b7563), long-horizon
workflow engine (5a8b4ef), unified WebSocket transport with `agent.state` + `assistant.delta`
already pushed to the client (963cffb). Self-mod live-tree audit done: 3 broken changes
reverted, everything else reviewed + committed (6acf64c, 4f77cfc).

---

## Pillar A — The Stage (UI merge) — ACTIVE

Full design in `docs/UI_MERGE_PLAN.md`. Tier 2 #15 already delivered several of its §6
server prerequisites: `agent.state` events, `assistant.delta` streaming, push-instead-of-poll
for self-mod/moltbook/theme, and the ava-ui-3d node_modules cleanup.

**16. Stage Phase 1 — the command center (2D).**
`Stage.jsx` in ava-client: dark stage layout, conversation ticker, command line, unified
panel dock (`usePanelDock()`), real ToolTrace / orchestration / presenter / approval cards.
Core is a CSS/SVG placeholder driven by the real state machine (`agent.state` already on the
bus). `?classic=1` keeps MinimalAVA as the escape hatch. Everything in this phase uses events
that already exist.

**17. Stage Phase 2 — the body.**
Port `HolographicHead` into a small R3F canvas under the §7 performance budget (demand
frameloop, DPR clamp, fresnel shell instead of MeshTransmissionMaterial, Bloom only,
auto-degrade to SVG). Server: add `callId` to tool.start/tool.result pairing (parallel tools
currently mis-resolve cards) and `tts.level {rms}` amplitude events from the voice worker.

**18. Stage Phase 3 — depth.**
Tool-specific visualizer skins (all data-true), `sys.stats` vitals strip, `workflow.*`
pipeline cards from the Tier 2 workflow engine, her-theme (`self_express`) mapped across the
stage, retire list (`ava-ui-3d-v1/v2`, InfoHUD regex engine, MinimalAVA's client-side intent
regex).

## Pillar B — Tier 2 debt

**19. Full worktree test suite + sandbox gate hardening.** (do FIRST or alongside 16 — it
protects everything else)
~59 of 92 test suites don't load inside the self-mod sandbox worktree, so its jest gate is
partial. Today's audit proved the cost: three approved self-mod changes with fatal or
nonexistent-API bugs (selfRestart's missing `../llm.js` import would have crashed the next
server start) passed the gate because the suites that would catch them never ran. Fix the
worktree so all suites load, and add an **import-resolution check** (dynamic `import()` of
every touched module in the worktree) so a bad import path can never pass again.

**20. Voice tuning (needs Jelani at the mic).**
Barge-in echo thresholds (`AVA_BARGE_RMS_MULT` / `AVA_BARGE_MIN_RMS` / confirm frames /
guard window) tuned against real speaker bleed on the TONOR. NEED_TOOLS escalation
reliability on the streamed conversational path (one audit run answered a clipboard question
without checking): expand `looksLikeToolRequest` coverage and/or strengthen the routing
prompt; measure with the training harness rather than anecdotes.

## Pillar C — Autonomy depth (the Student)

**21. Self-improvement loop v2 — close the loop.**
The virtual training environment (69%→94.5% train, 97% holdout) becomes the *eval gate* for
her autonomous proposals: propose → sandbox (syntax + imports + full suite) → harness
eval-score → apply or revert with the score recorded. Feed the audit lessons in as standing
review rules (never reference an API without a grep-verified definition; check import paths
resolve; async-vs-sync; ordering of new pre-checks). The kept self-mod work from today
(lesson dedup in memoryReviewer, processRejection in lessonLearner, listRejectedLessons)
is already pointing at this — wire it together.

**22. Proactive autonomy on the workflow engine.**
Multi-day, self-initiated goals: curiosity/proactive engines propose bounded workflows, the
Tier 2 supervisor (stuck-vs-working, crash recovery, deadlines) runs them, outcomes feed
memory + Moltbook. Approval-gated writes stay approval-gated.

---

## Suggested order

19 (gate hardening) → 16 (Stage Phase 1) → 17 → 20 (needs live mic time) → 18 → 21 → 22.
16 can start immediately in parallel with 19 since Phase 1 touches only the client.

## Standing rules (unchanged)

Honest verification after every restart; no hardwired phrase→response mappings; sandbox gate
stays protected from self-weakening; never commit secrets; Windows-side verification for
Edit-tool-written files (VM mount truncation hazard); push after every landed item — origin
must never fall 10 commits behind again.
