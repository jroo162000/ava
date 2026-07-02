# AVA UI Merge Plan — "The Stage"

Goal: one UI that is a **presence, not a chat log**. The prototype's visual language (dark, reactive, holographic) driven entirely by the main client's **real** event bus. Every panel on screen shows true system state; nothing decorative renders fake data.

Design principles (the Jarvis test):

1. **Data-true** — a panel may only exist if it's rendering a real event, real file, real diff, real result. If the data source is a regex on the transcript, delete it.
2. **Appear-when-relevant** — panels spawn on events, hold focus while active, and dissolve when done. Nothing is permanently mounted except the core and the input line.
3. **Voice-first, chat-secondary** — the transcript is a fading ticker, not a scrollable document. Text input is a command line, not a messenger box.
4. **The body reacts** — the core's motion/color is driven by AVA's actual state (listening / thinking / speaking / working / needs-attention), never by timers guessing.

---

## 1. Architecture decision

**Shell: keep `ava-client` (Vite + Electron). Port the good R3F components out of `ava-ui-3d`. Retire all three Next.js prototypes.**

Why: `ava-client` already has the working nervous system — `/voice/ws` hook, self-mod polling, Moltbook verification, `self/theme`, file downloads, Electron packaging. Next.js buys nothing for a local desktop UI and adds a second server + build system. `react-three-fiber`, `drei`, and `postprocessing` install cleanly into Vite.

- New primary component: `src/components/Stage.jsx` (the merged UI).
- `MinimalAVA.jsx` stays mounted behind a `?classic=1` route as fallback — there's a history of white-screen incidents with the complex UI (see PRIMARY_UI.md); never lose the escape hatch.
- Port from `ava-ui-3d`: `HolographicHead.tsx` (the shader core), the HUD *aesthetic* (colors, borders, entrance animations). Do **not** port: `InfoHUD`'s regex context engine, `TestControlPanel`, the fake visualizer contents, `AvatarHead` (duplicate of HolographicHead), the doubled `OrbitControls` in page.tsx.
- Delete/archive `ava-ui-3d-v1` and `ava-ui-3d-v2` — three copies of node_modules for one experiment.

**Hybrid rendering (important on this hardware):** the 3D canvas renders *only* the core + rings. All panels are **DOM overlays** positioned around the canvas, not `drei <Html>` inside it. DOM panels are cheaper, crisper, accessible, and reuse the already-written renderers (`ArtifactPanel.jsx`'s markdown/mermaid/table/video code, MinimalAVA's diff renderer).

---

## 2. Layout

Fullscreen dark stage (`#000204`), four zones:

```
┌─────────────────────────────────────────────────────┐
│ vitals strip (top-right): CPU · RAM · foreground app │
│                                                      │
│  conversation      ┌──────┐        panel dock        │
│  ticker            │ CORE │        (HUD cards spawn  │
│  (left, fades)     └──────┘         here, spread/    │
│                                      stack layout)   │
│                                                      │
│  attention tray (approvals/verifications) — bottom-L │
│  ▸ command line ______________________  (bottom)     │
└─────────────────────────────────────────────────────┘
```

- **Core** — ported HolographicHead. Idle anchor + state indicator.
- **Conversation ticker** — last ~6 turns, older ones fade out. `transcript.final` = user line, `assistant.final` = AVA line. A key toggles full history overlay when you actually need scrollback.
- **Panel dock** — one unified panel manager (see §4). ArtifactBus cards AND tool/agent panels live here under the same layout rules.
- **Attention tray** — self-mod approvals and Moltbook verifications. These are the two things that must never be missable; they also drive the ATTENTION state on the core.
- **Command line** — single input, monospace, no send button (Enter sends). Placeholder: `speak, or type…`.

---

## 3. Event → panel mapping (all real, all existing)

| Signal (already emitted) | Panel | Behavior |
|---|---|---|
| `transcript.final` | ticker | user line appears, core drops out of LISTENING |
| `assistant.final` | ticker | AVA line; core → SPEAKING while TTS plays |
| `tool.start {tool, args}` | **ToolTrace card** | spawns card titled with tool name + real arg hint (query/url/path); spinner state |
| `tool.result {tool, ok, summary}` | same card | resolves to ✓/✕ + real summary; auto-dismiss after ~8s unless focused |
| `agent.activity` `phase: delegate` | **Orchestration graph** | graph panel opens; root node = the goal |
| `phase: subagent_start` | orchestration | node spawns off root, pulsing, labeled with the subagent's actual task |
| `phase: subagent_done` | orchestration | node resolves ✓ |
| `phase: synthesize` | orchestration | edges converge into root |
| `phase: done` | orchestration | graph holds 4s, collapses; core leaves WORKING |
| `panel {cards, focusedId, layout}` (artifactBus) | **Presenter cards** | mirror exactly — she controls open/focus/spread/stack/move/close; reuse ArtifactPanel.jsx renderers restyled dark |
| `/self_mod` pending (poll) | **Code matrix card** | real diff, colored hunks (renderer already exists in MinimalAVA), reviewer recommendation, Approve/Reject buttons; puts core in ATTENTION |
| `/moltbook/verifications` (poll) | **Verification card** | challenge + answer input; ATTENTION state |
| `/self/theme` (poll, exists) | whole stage | keep this — AVA theming her own body via `self_express` is exactly the right idea; map her theme keys onto the stage's CSS variables |

**Tool-specific visualizer skins** (Phase 3, same ToolTrace card, richer body — still data-true):

- `web_search` → result titles/URLs listed as they return (the globe is fine as a *background* motif; the content is the real results).
- `fs_ops` / `file_resolve` → the actual path being read/written, rendered as a breadcrumb tree.
- `image_ops` / `model3d_ops` → the actual generated artifact preview (already have download endpoints).
- `browser` tools → current URL + honest CAPTCHA/login status (already emitted).
- `self_diagnostics` → recent commits list (already available to her env block).

---

## 4. Panel manager (one system, not five)

Single `usePanelDock()` store managing every card: `{id, kind, title, body, state: spawning|active|resolved|dismissing, pinned, ts}`.

Rules:
- Max ~6 visible; oldest unpinned resolved card dismisses first (artifactBus already caps at 12 — mirror its cards but let the dock govern visibility).
- Every card animates in (150–250ms scale+fade, the prototype's cubic-bezier is good) and out. No pops.
- Resolved tool cards auto-dismiss; ATTENTION cards (approvals/verifications) never auto-dismiss.
- `spread`/`stack` layout modes — adopt artifactBus's semantics for *all* cards so her `panel layout` tool controls the whole dock.
- Clicking a card pins/focuses it; Esc dismisses focused.

---

## 5. Core state machine

```
IDLE → LISTENING → THINKING → SPEAKING → IDLE
              ↘  WORKING (parallel, while tools/agents run)
ATTENTION (overlay state whenever approvals/verifications pending)
```

Visual mapping: IDLE slow rotation, dim · LISTENING rings brighten inward · THINKING fast internal shader motion · SPEAKING pulse rings + color shift (prototype already does this) · WORKING orbit rings speed up + orange tint · ATTENTION amber flash every few sec until tray cleared.

**Honest gap: today the client would have to *infer* most of these** (MinimalAVA fakes WORKING with a 15s timeout). Fix at the source — see §6.

---

## 6. Server-side upgrades required (small, high leverage)

1. **`agent.state` events.** Emit explicit `listening`, `thinking.start`, `speaking.start/end`, `working.start/end` from the voice worker + agentLoop via `emitVoiceEvent`. Kills every timeout hack in the UI. (~20 lines total; the bus already exists.)
2. **Pair tool events with an id.** `tool.start`/`tool.result` currently match by tool name — broken now that parallel read-only tools exist (same tool twice in flight = wrong card resolves). Add `callId` to both events.
3. **Streaming text.** Only `*.final` events exist; emit `assistant.delta` tokens so replies type into the ticker live. Biggest single "she's alive" upgrade for the cost.
4. **Speech amplitude.** Have the voice worker emit `tts.level {rms}` at ~20Hz while playing (it already owns the audio buffer). Drive the core's pulse from real amplitude instead of a boolean — this is the difference between reactive and animated.
5. **`sys.stats` event** every ~5s: CPU, RAM, foreground window (the data already exists in her os-awareness context — just re-emit it on the bus) → vitals strip.
6. **`workflow.*` events.** The long-workflow engine checkpoints stages; emit stage transitions so multi-hour workflows render as a live pipeline card instead of silence.

---

## 7. Performance budget (non-negotiable on this machine)

No discrete GPU (Intel iGPU) and Whisper/Piper already eat CPU. The prototype as-is will not hold 60fps here.

- `frameloop="demand"` + invalidate on state change; full framerate only while SPEAKING/WORKING.
- Clamp DPR to 1–1.5. `antialias: false` (already set).
- **Drop `MeshTransmissionMaterial`** (10 samples of transmission is the single most expensive thing in the prototype). Replace the glass shell with a cheap fresnel-rim shader — visually ~90% the same.
- Postprocessing: keep Bloom only. Cut ChromaticAberration/Noise/Vignette or fold them into one cheap shader pass.
- Panels in DOM (per §1) so the canvas repaint area stays small.
- Add an auto-degrade: if frame time > 33ms sustained, swap core to a static SVG + CSS animation version. She should never stutter her own voice to render her face.

---

## 8. Phased delivery

**Phase 1 — the command center (2D, biggest visible win, lowest risk).**
Restyle into the Stage layout with dark theme, ticker, command line, unified panel dock, real ToolTrace + orchestration + presenter + approval cards. No 3D yet — core is a CSS/SVG placeholder with the state machine wired. *Everything in this phase uses events that already exist.*

**Phase 2 — the body.**
Port HolographicHead into a small R3F canvas with the perf budget above. Wire `agent.state` + `tts.level` (server items 1, 2, 4).

**Phase 3 — depth.**
`assistant.delta` streaming, tool-specific visualizer skins, `sys.stats` vitals, workflow pipeline cards, motion polish, her-theme integration across the stage.

Each phase ships behind the `?classic=1` fallback. Self-mod note: once she starts proposing changes to Stage.jsx, the approval diff card is protecting her own face — keep it prominent.

---

## 9. Retire list

- `ava-ui-3d-v1/`, `ava-ui-3d-v2/` — archive or delete.
- `InfoHUD.tsx` context regex + all fake visualizer bodies (keep the CSS/entrance animation as reference).
- `TestControlPanel.tsx`, duplicated `OrbitControls`, `AvatarHead.tsx`.
- MinimalAVA's client-side "create a pdf/docx" regex router in `sendMessage` — the server routes tools now; the UI shouldn't second-guess intent.
- The 15s `working` timeout once `agent.state` lands.
