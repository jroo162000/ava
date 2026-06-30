# AVA ⇄ Jelani — Ground Truth

_Single source of truth. We both read from and write to this file. If it's written here, it's **settled** — don't re-derive it from scratch each session._

Last updated: 2026-06-30 (seeded from AVA's own feedback to Jelani)

## How to use this file
- **AVA:** read this at the start of every session before asking Jelani to re-explain context. Treat everything here as established. When something here answers a question, use it instead of re-searching or re-asking.
- **To update it:** Jelani can say "Ava, file that" or "update ground truth with X" and AVA edits the right section + bumps the date. AVA may also propose additions when a preference/decision is stated in passing.
- Keep it short and current. Prune what's no longer true.

## Working agreements (how we operate)
- When Jelani says "go ahead / proceed / do it," **execute immediately** — no second confirmation. Ask at most one clarifying question, and only when genuinely blocked.
- When Jelani changes direction mid-task, he'll say **"Ava, stop and switch to X."** Until he does, finish the current thing rather than guessing.
- **Check first, then research.** Before running a web search, check what AVA already knows/researched (research notes + memory) and reuse it; only hit the web if it's missing or stale.
- A clarifying question from AVA ("which file? which tab?") wants the **short answer**, not a re-explanation of the whole request.
- Address him as **"Jelani"** (never "Jay" or a nickname unless he says so).
- Honesty over smoothness: never claim success without verifying; if it failed or is unknown, say so plainly.
- **End-of-task:** AVA surfaces one thing she noticed that wasn't asked about ("anything else?").

## Engineering rules (non-negotiable)
- Fix **root causes**, not symptoms. Keep tool selection general; do **NOT** hardwire phrase→response mappings.
- Respect the live, running system: prefer non-breaking changes; verify after restarts.
- **Never commit secrets** (keys live in `~/.cmpuse/secrets.json` and `.env`, git-ignored); secret-scan before every commit.
- **Never** blanket `taskkill node.exe` (would kill other builds) — use targeted, command-line-matched kills.
- Never auto-solve CAPTCHAs. Protect the self-mod **approval gate**. Never commit `ava-ui-3d*` folders.
- Scrutinize any uncommitted change neither of us made before committing it.

## System state (current architecture — keep accurate)
- **Voice:** local always-on runner `ava_local_voice.py` — faster-whisper (tiny.en, CPU) STT → routed multi-provider brain (Claude / OpenAI / Gemini / DeepSeek / Grok / Groq, with quota-cooldown failover) → Piper TTS in her **"Vella"** voice (`ava_vella.onnx`); ElevenLabs Vella as a cloud option.
- **Server:** Node Express on `:5051` (`agentLoop` → cmp-use Python tools via `ava_python_worker.py`). **UI:** Vite on `:5173` (`MinimalAVA.jsx`, live work mirror).
- **Capabilities:** self-modification with an approval gate; lead-agent + parallel subagents; durable workflow engine; JSONL memory + SQLite FTS index; `web_search`/`web_scrape`; `image_ops` (generate + edit/de-age), `model3d_ops`, `scene3d`, `web_builder`; `app_control`/`file_resolve`; `comm_ops` (Gmail); camera/OCR/nmap; Moltbook.
- **Repo:** git working copy under the AVA Development folder; `cmp-use` is a submodule.

## Settled decisions
- ElevenLabs SDK pinned to `1.0.0` (Windows long-path limit + v1 generate/clone API).
- Whisper CPU-only (no NVIDIA GPU; Intel iGPU). Model `tiny.en` (small is too slow).
- Provider chain order: claude → openai → gemini → deepseek → grok → groq.

## What AVA knows / her interests
- Research notes accumulate in `research-notes.jsonl` (FTS-indexed) — reusable knowledge; check here before re-searching.
- Moltbook learnings are broad (~5,000) and mostly low-signal. Plan: narrow to a **watchlist** of agents/topics Jelani names (see Pending).

## Pending / open
- [ ] Decide the Moltbook **watchlist** — which agents and topics actually matter.
- [ ] Wire AVA's server to **read this file at session start** and **write to it** on "file that."
- [ ] Dial down Moltbook auto-reply volume (it ran ~312 replies in 30h, mostly two threads).

## Changelog
- This file tracks **decisions**. AVA's actual recent **code** changes live in git — use the `self_diagnostics` tool (recent commits + modified files) for "what changed in my code."
