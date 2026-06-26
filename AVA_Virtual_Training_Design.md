# Training AVA in a Virtual Environment — Design & Requirements

*How to train AVA the way robots are trained in simulation, so she becomes an expert at
using her tools on Jelani's local device. Honest about what's feasible today.*

---

## 0. The fork in the road (read this first)

Robots learn in sim by **reinforcement learning on a neural network's weights**: a
simulator, a reward signal, thousands of trials, and gradient updates to the policy.

AVA's "policy" is currently **GPT‑4o‑mini via API** — closed weights you cannot
gradient-train. So "train AVA in a virtual environment" means one of two things:

- **Path A — Agent-harness training (in-context).** Keep the current model. Build a
  sandbox that mimics the device + a library of tasks with automatic pass/fail checks +
  a loop that runs AVA, scores her, and **keeps the changes that raise the score** —
  changes to her tool descriptions, routing logic, captured **skills**, and **memory**.
  This is the "Auto‑Agent" pattern from the videos you shared. *No GPU. Works now. This
  is where most of the practical "expert at your device" gains come from.*

- **Path B — Weight training (the literal robot‑RL analog).** Swap her brain to a
  **local open-weights model** (e.g. a small Llama/Qwen), then **fine-tune** it on her
  successful runs (behavioral cloning) and optionally **RL** it (GRPO/PPO/DPO) using the
  verifier as the reward. Needs a GPU and a real ML pipeline, and a "sim-to-real" step.

Both use the **same simulator + tasks + verifier**. You build that once; Path A uses it
to tune the harness, Path B additionally uses it to train weights. Recommendation: build
the sim + Path A first (high value, low risk), add Path B later only if you want her to
run fully local and keep improving without an API.

---

## 1. The components (mapped to robot-sim training)

### 1.1 The simulator — a virtual device that mimics yours ("the world")
So she can act thousands of times with **no real side effects**:
- **Sandbox filesystem**: a throwaway copy of the relevant folders (synthetic Downloads/
  Documents/Desktop with realistic files — PDFs, docx, f941 forms, screenshots).
- **Stubbed external services**: fake email/calendar/contacts so "send an email to Sarah"
  records a *simulated* send instead of really sending; fake smart-home, etc.
- **Virtual screen/camera**: pre-recorded frames or canned vision responses so "what do
  you see" is reproducible and free.
- **Tool redirection ("sandbox mode")**: every tool either runs against the sandbox copy
  or is mocked to return realistic output **and log what was attempted**. Destructive
  actions (delete/send/format) hit the sandbox, never the real device.
- **Snapshot + reset**: restore the sandbox to a known state between episodes (like
  resetting a sim run).
- **Faithfulness knobs**: inject realistic latency and tool errors (e.g. "camera cold-load
  takes 40s", "file not found", "app not installed") so she learns to handle them.

### 1.2 The task library / curriculum ("the missions")
A graded set of tasks she should master, each with a **precise goal** and an
**automatic success check**:
- *Single-tool*: "create a docx named X in Documents", "find files starting with f941",
  "what's my CPU usage", "open notes.txt".
- *Recall/memory*: "what did we discuss about the camera" → must call memory_search and
  include the seeded fact.
- *Risky (sandboxed)*: "email Sarah the report" → a simulated send with correct to/subject/body.
- *Multi-step*: "take a screenshot, then write a note summarizing it."
- *Curriculum*: single-tool → multi-step → **your real phrasings** (pulled from her voice
  logs) → edge cases (missing file, tool error → recover) → adversarial (ambiguous, typo'd).
- **Domain randomization**: vary filenames, wording, and injected errors so she generalizes
  instead of memorizing one phrasing.

### 1.3 The verifier / reward ("did it actually succeed?")
Programmatic checks per task — the crux of the whole thing:
- Filesystem/state assertions (file exists, valid format, correct content).
- The **right tool** was called with the right args.
- The answer **contains the required facts** (for recall/info tasks).
- **No destructive side effect** outside what was asked.
- **Honesty**: she didn't claim success when the tool failed (we already guard this).
- Plus **latency and token cost** as secondary signals.

### 1.4 The training loop
**Path A (in-context, overnight, no GPU):**
1. Run AVA on the task batch in the sandbox → score with the verifiers.
2. A "meta" pass reads the **failures + reasoning traces** and proposes improvements to:
   tool descriptions, the routing/decision prompts, deterministic handlers, captured
   **skills**, and **curated memory**.
3. Re-run the batch; **keep** changes that raise the score, **revert** ones that don't.
4. Repeat. Output: a better-tuned harness + a library of *proven* skills. Code/harness
   changes stay **human-approved** (safety).

**Path B (weights, the literal robot-RL analog, optional):**
1. Collect **trajectories** (state → AVA's tool calls → outcome → reward) from the sim.
2. **Behavioral cloning / SFT**: fine-tune a local open model on the *successful*
   trajectories so it imitates good tool use on your device.
3. **RL** (GRPO/PPO/DPO/RFT) using the verifier as reward to push past imitation.
4. Swap AVA's brain from GPT‑4o‑mini to the trained local model.

### 1.5 Sim-to-real
- Keep the sandbox **faithful** (real-ish files, real tool latencies/errors, your actual
  phrasings).
- Periodically validate on the **real device** with safe tasks; measure the gap.
- Domain randomization in sim is what makes the real-device behavior robust.

### 1.6 Evaluation & regression
- A **held-out** task set she never "trained" on, scored before/after each loop to prove
  real improvement and **catch regressions** (so tuning one task doesn't break another).
- A **scoreboard over time** (pass-rate, by category, latency, cost).

---

## 2. What we already have (the head start)
- **Tools** that can be redirected/sandboxed; the **agent loop**.
- **Skills + memory + lessons** — the entire in-context learning substrate (P1–P5 already
  built): she captures skills, distills facts, and remembers fixes.
- **Self-diagnosis / self-modification** engine (propose → approve → rollback).
- **~12 test harnesses** (file-ops, tool tests, recall, persona A/B, denial sweep) — these
  are literally the **seed of the task library + verifiers**.

## 3. What we'd need to build
1. **Sandbox mode**: a redirect/mock layer for file/app/comm/vision tools + snapshot/reset.
2. **Task library + verifiers**: grow the harnesses into a graded curriculum (~50→300 tasks),
   seeded from your real voice logs so it matches how *you* actually talk.
3. **Meta-loop runner**: an orchestrator that runs the batch, scores, proposes harness/skill/
   memory changes, and keeps/reverts by score (Path A).
4. **Scoreboard + held-out eval**: track progress and prevent regressions.
5. *(Optional, Path B)*: a local open-weights model + GPU/rented compute + an SFT/RL pipeline,
   and switching her brain to the local model.

## 4. Honest constraints
- You **cannot** gradient-train GPT‑4o‑mini — real "RL on weights" requires a local open
  model (Path B). Path A improves everything *around* the model (tools, routing, skills,
  memory) and is where the near-term wins are.
- A perfect mirror of your device is impossible; we **approximate** (copy folders, stub
  services, record camera frames) and keep a small real-device check for the gap.
- **Safety**: all training runs in the sandbox (no real sends/deletes); harness/code
  changes stay human-approved — consistent with "no autonomous code self-evolution
  without an eval harness + approval."
- This is a real project (days→weeks of build), not a switch. But the foundation
  (tools, agent loop, skills, memory, test harnesses) is already in place.

## 5. Suggested phasing
- **Phase 0** — Sandbox mode: redirect file/app/comm/vision tools to a fake device + reset.
- **Phase 1** — Task library + verifiers: grow harnesses into ~50–100 graded tasks from your logs.
- **Phase 2** — Meta training loop (Path A): run → score → propose → keep/revert, overnight.
  *This alone makes her measurably better at your tools, with the current model.*
- **Phase 3** — Scoreboard + held-out eval + sim-to-real validation.
- **Phase 4 (optional)** — Path B: local open model + SFT on successful trajectories + RL.

The smallest first step that proves the idea: **Phase 0 + a 20-task Phase 1 + one Phase 2
loop**, and watch the pass-rate climb on the held-out tasks.
