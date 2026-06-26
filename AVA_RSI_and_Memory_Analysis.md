# Recursive Self-Improvement & Agent Memory — and How It Applies to AVA

*Prepared for Jelani. A synthesis of recursive self-improvement (RSI) for AI agents
and the memory designs of OpenClaw and Hermes Agent, mapped onto AVA's real architecture.*

---

## 0. Method & honesty note

I cannot literally watch video or listen to audio, so I did **not** "watch" the
Dennis Yu video or others. What I actually did: located the video and Dennis Yu's
published material, then read multiple written sources (technical blogs, the framework
write-ups, and reference articles) on RSI, OpenClaw, and Hermes Agent, and synthesized
them. The YouTube page is JavaScript-rendered, so I could not extract a verbatim
transcript.

Source-reliability caveat: OpenClaw and Hermes Agent are **2026-era** frameworks. Much
of what's written about them online is secondary (technical blogs and some SEO/marketing
pages), and specific figures (exact character limits, GitHub star counts, release dates)
come from those secondary sources, not from me running the code. The *design principles*
below are corroborated across several independent sources and align with well-established
agent-memory research (Letta/MemGPT, Mem0, Zep, Databricks "memory scaling"), so I'm
confident in the principles even where I flag a specific number as unverified.

---

## 1. Recursive self-improvement (RSI) for AI agents

**The core idea.** An agent that can observe its own behavior, find its own weaknesses,
and modify itself (its code, prompts, tools, or knowledge) so the *next* run is better —
then repeat. The loop is: **act → observe outcome → diagnose → improve → record → repeat.**

**Dennis Yu's practical framing** (from his published material, not the video audio):
he is less about the sci-fi "intelligence explosion" and more about a *pragmatic*
version — agents that **document what they do and improve on the next run**, supervised
by a human, and built on **real work** rather than toy exercises. His company turns
processes into agents that "execute, document, and improve." The transferable lessons:

- Improvement comes from **capturing what happened** (logging + structured notes), not
  from magic. No memory of past runs → no improvement.
- Keep a **human in the loop** as the supervisor/approver of changes.
- Improve against **real tasks** with real feedback, so the signal is honest.

This matters for AVA because AVA already has the *substrate* for this loop
(`self_modification.py`, `self_awareness.py`, `learning.db`) — what's missing is closing
the loop so lessons actually persist and change future behavior.

---

## 2. Why OpenClaw's and Hermes's memory are praised

Both are "personal agent" frameworks (Hermes is from Nous Research; OpenClaw was formerly
"Moltbot/ClawdBot"). Their memory designs are admired for the **same handful of
principles**, which is the important part:

### 2.1 Memory is *curated and always-on*, not just *retrieved*
The biggest idea. Most systems treat memory as a database you query at request time
(retrieval/RAG), which adds latency, noise, and cost. Hermes instead keeps a small,
**bounded, curated block of memory injected into the system prompt on every turn** — the
agent doesn't *fetch* memory, it simply *has* it. Two files:
- **MEMORY.md** — the agent's own notes (environment facts, project conventions, lessons). ~2,200 chars.
- **USER.md** — the user profile (who you are, preferences, communication style). ~1,375 chars.

OpenClaw does a similar thing with daily memory files (`memory/YYYY-MM-DD.md`) plus a
**curated permanent knowledge base** file, auto-loaded at session start.

### 2.2 Bounded memory beats unlimited memory
The character caps are a *feature*, not a limitation. Limits force the agent to
**consolidate, generalize, and forget**. "User prefers Python" scales; "User ran command
X at 14:03 on Jan 5" is noise. When near full, the agent **merges/replaces** entries
rather than appending forever. Unbounded memory becomes slow and noisy and degrades the
model's attention.

### 2.3 Forgetting is maintenance, not failure
Explicit `remove`/`replace` actions let the agent unlearn outdated facts. An agent that
can't forget eventually carries as much noise as signal.

### 2.4 Two tiers: "brain" vs "library"
- **Internal memory (brain):** small, curated, always-active — identity, preferences,
  conventions, fresh lessons.
- **External knowledge (library):** vast, on-demand — files, docs, web, past
  conversation logs. *Looked up*, not "remembered."
- **Distillation pattern:** when something from the library matters long-term, distill
  the *one-line takeaway* into the brain; leave the bulk in the library.

### 2.5 Cheap, instant recall for the rest (full-text session search)
Everything not in the curated block still lives in SQLite. Hermes uses **SQLite + FTS5
full-text search** over all past conversations ("did we talk about X last week?").
OpenClaw adds **embedding search** (sqlite-vec) for semantic recall. This is the
on-demand layer — unlimited, but only paid for when needed.

### 2.6 Clear write/read triggers
The agent saves **proactively but selectively**: on a user **correction**, a discovered
**preference**, an **environment fact**, a **project convention**, or a hard-won
**workaround** — and *skips* trivia and ephemera. Reads are automatic (it's in the
prompt) plus on-demand search when the question is historical.

### 2.7 Safety + performance details worth copying
- **Prompt-injection scanning on every memory write** (blocks credential-exfil, hidden
  Unicode, "ignore previous instructions" poisoning) + de-duplication.
- **Frozen snapshot:** memory is loaded once at session start and held static, so the
  model isn't reacting to its own mid-session edits — and the static prefix enables
  **prefix caching** (faster, cheaper turns).

### 2.8 The "5 pillars" framing (Hermes)
memory · **skills** · **soul** (persona/identity in a SOUL.md) · **crons** (scheduled
self-runs) · **self-improving loop**. This is essentially a blueprint for a persistent
personal agent — and AVA already has all five in some form.

---

## 3. Where AVA stands today (mapped to the 5 pillars)

AVA is, conceptually, **already a Hermes/OpenClaw-class agent** — in fact it's built in
that ecosystem (AVA posts to "Moltbook," and the productivity plugin's memory skill uses
the exact `CLAUDE.md` + `memory/` directory pattern). Pillar by pillar:

| Pillar | What AVA already has | Gap vs. Hermes/OpenClaw |
|---|---|---|
| **Memory** | SQLite `ava_memory.db` + `learning.db` (facts, corrections, patterns, preferences), JSONL memory store, per-day conversation logs, `memory_search` builtin, `retrieveRelevant()` | Memory is **retrieved**, not a curated always-on block. No bounded MEMORY.md/USER.md injected into the live voice prompt. No consolidation/forgetting. No full-text/semantic index over conversation logs. |
| **Skills** | ~30 cmp-use tools + productivity/ops skills | Fine. Could add "save a successful multi-step workflow as a reusable skill." |
| **Soul** | `ava_identity.json` + `persona.js` (the personality we just wired into every prompt) | This is solid — equivalent to Hermes SOUL.md. |
| **Crons** | `scheduled-tasks` MCP | Fine. Underused for self-improvement runs. |
| **Self-improving loop** | `self_modification.py` (diagnose_codebase/diagnose_tool/propose→approve→rollback), `self_awareness.py` (introspect/diagnose, learned facts) | The loop isn't **closed**: diagnoses and lessons don't reliably persist into memory and change future behavior. |

**The single most important finding:** AVA's **learned facts/preferences are not injected
into the live voice conversational prompt.** The conversational `/respond` path injects
persona + recent session turns, but not a curated "what I know about Jelani / what I've
learned" block. (`generatePersona()` / `includeMemory` exist but are used by *other*
routes.) So AVA *stores* learnings it never *uses* in normal conversation — the opposite
of the Hermes "always-on memory" principle.

---

## 4. Concrete recommendations for AVA (prioritized)

### P1 — Always-active curated memory block (highest leverage)
Create AVA's equivalent of **USER.md** (about Jelani) and **MEMORY.md** (AVA's own
notes/lessons), kept bounded (~1–2k chars each), and **inject them into every `/respond`
system prompt**, right alongside the persona block we already add. Seed USER.md from the
facts already in `learning.db`/`ava_identity.json`. This alone makes her feel continuous
without any retrieval latency. *(Builds directly on the persona injector — same hook.)*

### P2 — Write triggers + distillation
Have AVA proactively update that block on: a **correction** ("no, I use X"), a discovered
**preference**, a stable **fact about you or the environment**, or a useful **workaround**.
`self_awareness.py` already records corrections/preferences to `learning.db`; the change
is to (a) trigger saves on those signals and (b) **distill** them into the bounded block
(one dense line each), not dump raw logs.

### P3 — Bounded memory + consolidation + forgetting
Cap the curated block; when it's ~80% full, have AVA **merge/replace** entries and drop
stale ones. Prefer general statements over timestamped specifics. This prevents the
"poisoned/over-stuffed memory" problems we already hit once (the false-WARNING entries).

### P4 — Cheap historical recall (FTS over conversation logs)
AVA already writes per-day conversation JSONL. Add a **SQLite FTS5** index (or reuse
`memory_search`) so "what did we decide about the camera last week?" is a fast lookup —
the "library," separate from the always-on "brain." OpenClaw-style embedding search
(`sqlite-vec`) is a nice upgrade for semantic recall.

### P5 — Close the self-improvement loop
Wire the RSI substrate together: when a tool fails, AVA runs `diagnose_tool`, and the
**lesson** ("browser_automation needs Selenium-Manager, not webdriver_manager") gets
distilled into MEMORY.md so the mistake isn't repeated; optionally `propose_fix` →
you approve → `rollback` available. A nightly **cron** can review the day's failures and
update memory. This is exactly Dennis Yu's "document what you did and improve next run."

### P6 — Safety on memory writes
Add **prompt-injection scanning + de-dup** before anything is written to memory
(reuse `security.js`). This matters specifically because AVA reads email/files/web —
untrusted text must never silently become a "memory" that alters her behavior.

### P7 — Frozen snapshot / prefix stability
Load the curated block once per session and keep it static during the turn, so AVA isn't
reacting to her own mid-turn edits, and so the stable prompt prefix can be cached
(faster, cheaper responses).

---

## 5. Bottom line

AVA isn't missing the *ideas* behind OpenClaw and Hermes — she's built in the same family
and already has memory DBs, a soul/persona, skills, crons, and a self-modification engine.
What she's missing is the **discipline** those frameworks are praised for:

1. a **small, curated, always-on** memory block injected every turn (not just retrieved),
2. **proactive write triggers + distillation** so lessons actually accumulate,
3. **bounded memory with consolidation and forgetting** so it stays signal, not noise,
4. a **fast searchable archive** for everything else, and
5. a **closed self-improvement loop** that turns diagnoses into remembered lessons.

The first one (P1) is the highest-leverage and smallest change, and it plugs into the
exact prompt hook we already added for personality.

---

## 6. Update — final plan after the Dennis Yu RSI + Auto Agent transcripts

Two more transcripts (Dennis Yu's own RSI episode, and an Auto Agent / Auto Research
breakdown) confirmed the analysis and added three disciplines:

- **Meta-article → definitive-article loop + maturity gate.** Log what the agent did each
  run (meta), and only *promote* a procedure to a reusable skill after it's succeeded a
  few times (≈3). Track per-skill/tool **success counters** (the "thousand-task library"
  idea). AVA's `learning.db` already has a `patterns(frequency)` table to build on.
- **"Dreaming" = scheduled async consolidation.** Persistence + Anthropic's "agents
  dreaming" is the same async memory/skill consolidation reviewer, run on a **cron**
  ("weekly fleet audit"). Host on AVA's existing scheduler infra.
- **Auto-code-evolution requires an eval harness.** Autonomous harness/code improvement
  (Karpathy's auto-research, Kevin Goo's Auto Agent) only works with a task DB +
  programmatic verification + sandboxed keep/revert. AVA's existing **test scripts are the
  seed** of that benchmark. Defer until/unless we grow them into an eval set; keep code
  self-modification human-approved.

### Final implementation order
1. **Always-on bounded curated memory** — `USER.md` (about Jelani) + `MEMORY.md` (AVA's
   notes) + a small index, injected into every `/respond` prompt beside the persona.
   Seed from `learning.db`/`ava_identity.json`. *(Highest leverage, smallest change.)*
2. **Async background reviewers ("dreaming")** — every ~10 turns / nightly cron: extract
   durable facts into the bounded files, capture proven procedures as skills, consolidate
   + dedup + prune stale entries. On existing scheduler infra.
3. **Searchable history+memory tool** — SQLite FTS over conversation logs + memory files
   (one `memory_search`); optional embeddings later.
4. **Autonomous skill capture + maturity gate + `skill_guard` scan** — promote after N
   successes; reject-pattern/injection scan before save; track usage counters.
5. **Error→lesson hook** — on tool failure, run `diagnose_tool` and distill the fix into
   memory so it doesn't recur.
6. **Keep code self-modification human-gated**; only pursue auto-code-evolution after an
   eval harness exists (seeded by current test scripts).

## 7. Status — implemented (2026-06-24)

- **P1 — Always-on curated memory**: DONE & verified. `curatedMemory.js` injects USER.md +
  MEMORY.md into every prompt; she recalls seeded facts in a fresh session.
- **P2 — Dreaming reviewer**: DONE & verified. `memoryReviewer.js` extracts durable facts
  every ~6 turns / on demand, deduped + injection-guarded + consolidated.
- **P3 — Searchable recall**: DONE & verified. `memory_search` now searches curated memory
  + skills + all conversation logs; agent uses it by voice. (Also made the agent decision
  parser tolerant of tool-name-as-type — fixes a general failure class.)
- **P4 — Skill capture**: DONE & verified. `skillStore.js` + `skillCapture.js` distill
  reusable how-tos after successful multi-step tasks, with maturity counters and a
  `skill_guard` scan; skills are listed, searchable, and indexed into the agent prompt.
- **P5 — Error→lesson**: DONE & verified. `lessonLearner.js` distills a guarded preventive
  lesson into MEMORY.md on tool failure (with `diagnose_tool` enrichment).
- **P6 — Code self-modification stays human-gated**: unchanged by design (no eval harness yet).

Env switches: `AVA_MEMORY_OFF`, `AVA_MEMORY_REVIEW_OFF`, `AVA_MEMORY_REVIEW_EVERY`,
`AVA_SKILL_CAPTURE_OFF`, `AVA_LESSONS_OFF`. Memory lives under `ava-integration/memory/`
(USER.md, MEMORY.md, skills/).

## Sources

- Recursive Self-Improvement (video): https://www.youtube.com/watch?v=t7_ZXgfJVG8
- About Dennis Yu: https://dennisyu.com/about/
- Recursive self-improvement (overview): https://en.wikipedia.org/wiki/Recursive_self-improvement
- Recursive Self-Improvement in AI labs (IEEE Spectrum): https://spectrum.ieee.org/recursive-self-improvement
- OpenClaw AI Agent Memory: https://aiagentmemory.org/articles/openclaw-ai-agent-memory/
- How OpenClaw Works (architecture): https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764
- Mem0 — persistent memory for OpenClaw: https://mem0.ai/blog/mem0-memory-for-openclaw
- Hermes Agent Memory System (deep technical guide): https://www.glukhov.org/ai-systems/hermes/hermes-agent-memory-system/
- Hermes Agent 5-pillar architecture (MindStudio): https://www.mindstudio.ai/blog/hermes-agent-5-pillar-architecture-memory-skills-soul-crons
- How memory works in Hermes Agent (Mem0): https://mem0.ai/blog/how-memory-works-in-hermes-agent-(and-how-to-improve-it)
- Hermes Agent memory (Vectorize/Hindsight): https://vectorize.io/articles/hermes-agent-memory-explained
