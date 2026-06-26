# AVA Voice Project — Full Thread Report

**Source thread:** Codex Desktop session `019cc2ee-5b0c-7671-bda1-d253125ac9db`
**Span:** 2026-03-06 → 2026-06-22 (today) · ~97 user turns · ~150 agent work-cycles · ~50 source files touched
**Prepared:** 2026-06-22 from the full session transcript

---

## TL;DR

You set out to give AVA a **fully local, OpenAI-realtime-style voice** (hands-free: you speak, she hears, she answers through the speakers). Over ~3.5 months the agent rebuilt almost the entire voice software stack and proved, repeatedly and with hard evidence, that **the software works**: under clean/synthetic audio AVA reliably wakes, transcribes, answers, and speaks. The thing that has **never** been solved is the **physical microphone capture**. Your built-in Realtek mic is too noisy, and you've ruled out the webcam mic. Every "she can't hear me / no response" failure traces back to that one wall.

The agent's own standing verdict (stated many times): **continue editing, do not rewrite from scratch** — the architecture is sound, the blocker is hardware/acoustics. I agree with that read of the evidence. The single highest-value action is a **dedicated headset/USB mic** plus one human acceptance pass. Everything else is polish.

**Where it stopped:** mid-task on 2026-06-22. The agent added a "synthetic live-loop" self-test (so it can validate the real capture path without you speaking), verified it passes, but **could not restart the dashboard process** to load the new code because a usage limit blocked the command. So the code is on disk but the running dashboard may still use the old self-test.

---

## 1. What you're trying to achieve

From your own words early in the thread:

- *"Mimic OpenAI's realtime voice locally through a hybrid method."* (your 2nd message)
- *"The goal is to have a fully functioning local realtime voice capability."* (the formal goal set 2026-06-13)
- Hands-free conversation: wake word → she hears you → answers out loud, low latency, can be interrupted.
- Fully **local** (no cloud APIs for the realtime path) — local ASR, local TTS, local brain server.
- It must work with **your actual hardware**, choosing a good mic automatically, and **not** depend on the webcam mic (you explicitly rejected it as not good enough).

So success = you sit down, say *"Hey AVA, what time is it?"*, and hear a correct spoken reply, repeatably, without babysitting a terminal.

---

## 2. What AVA actually is (architecture)

AVA is a multi-part local assistant living under `C:\Users\USER 1\ava`:

- **`ava-server`** — Node.js "brain." Serves the LLM/response logic at `http://127.0.0.1:5051/respond`. The most mature, best-tested piece (server test suite was ~59/68 passing at the start; voice-related suites later grew to 160+ passing).
- **`ava-integration`** — the Python voice runtime. This is where ~90% of the work happened. Key files:
  - `ava_standalone_realtime.py` — the original giant (~6,000-line) realtime runtime: audio, wake, tools, health, self-mod all in one.
  - `ava_local_voice.py` — the leaner "minimal local voice runner" that became the active path.
  - `ava_hybrid_asr.py` — the hybrid speech recognition: **Vosk** for instant streaming partials + **Whisper (`tiny.en`)** for the final transcript.
  - `voice/tts/piper_bin.py` — **Piper** local text-to-speech (persistent warm worker).
  - `ava_realtime_ui.py` — the **AVA Realtime Lab** dashboard (browser UI at `http://127.0.0.1:8765/`).
  - `ava_voice_config.json` — audio/VAD/device config.
  - `tools/voice_lab/*` — a suite of diagnostic probes (loopback benchmark, mic-level probe, deterministic validators, WAV acceptance, etc.).
- **`ava-client`** — a React/Vite frontend (largely dormant for this effort; flagged as miswired early on).
- **Legacy `ava_tray.pyw`** (uses the separate `cmp-use` package) — an **older** tray version, now named **"AVA Startup"** (see §6).

**The realtime loop:** mic → VAD detects speech → Vosk streams partials → wake word gate (`hey ava`, `ava`, `hey eva`, etc.) → Whisper produces the committed transcript → POST to `/respond` → reply text → Piper speaks it → barge-in can cancel mid-sentence.

---

## 3. What has been done

### 3.1 Initial assessment (your 1st ask)
A full audit graded AVA as **late-prototype / early-alpha, not production-ready**. Concrete problems found and (mostly) addressed over time:
- No single source of truth — the server spawned a different `~/ava-integration` copy than the repo you were editing (edits could miss the running code).
- Frontend miswired — the mounted UI posted to routes the server didn't expose.
- Autonomy/curiosity policy silently failing to load (bad Ajv schema setup).
- **Security:** the local bridge fell back to a known default token and exposed raw `shell=True` execution — too weak for a machine-control assistant.
- Duplicate `POST /respond` handler (dead code).
- The monolithic `ava_standalone_realtime.py` flagged as the main brake on reliability.

### 3.2 The voice rebuild (the bulk of the work)
The voice problem was diagnosed as **three stacked failures**, each attacked in turn:

**TTS (output) — solved.** Piper was cold-starting on every reply. The agent built a **persistent warm Piper worker** with soft-cancel (so interruption doesn't force a re-warm). First-audio latency dropped from ~18.7s to ~5.3s on a long reply.

**ASR (recognition) — solved in software.**
- Switched the final model to **Whisper `tiny.en`** (the `small` model took ~30s on CPU and blew the finalize budget; `tiny.en` finalizes in ~3s).
- Made Whisper the trusted final path; **Vosk finals are no longer promoted** ungated.
- Whisper warms once at startup; finalization moved off the mic thread; stale Whisper jobs are superseded so old results don't leak across turns.
- Wake-word gating fixed (no-wake speech is dropped/stored as "overheard," not answered), plus a "soft wake rescue" so a strong utterance isn't permanently vetoed by a bad Vosk partial.

**Mic selection — heavily engineered, partially solved.** This is the long pole. The agent went through several generations:
1. Reject "hot" inputs (the Realtek mic idles at RMS ~12,000+ vs a sane ~280).
2. Rank all inputs by idle RMS instead of first-hit fallback.
3. Add a **loopback tone probe** (play a chirp, see which mic hears it).
4. Add a **speech-content probe** (play a spoken phrase, transcribe each candidate, score by match).
5. Add **non-webcam failover** that refuses the C920e webcam, per your instruction.

### 3.3 Deterministic test path — built
Because room acoustics kept polluting results, the agent built **WAV-backed / synthetic input** validation so the pipeline can be proven without you speaking. Under this clean path AVA **consistently** completes the full loop (`asr_final` → `llm_done` → spoken reply, e.g. *"It's 8:52 AM."*). This is the strongest proof the software is healthy.

### 3.4 The AVA Realtime Lab dashboard — built (your June goal #1)
A persistent browser UI (`ava_realtime_ui.py`, port 8765) that lets you **start/stop/restart** the runtime without killing the UI, and shows process status/PID, logs, brain-server health, ASR/TTS/mic markers, audio-device probing, an issue board, a **Direct Local Voice Self-Test**, a **failed-turn WAV analyzer**, and **non-webcam input probe/apply** controls. Readiness logic was tightened so the dashboard now **warns** ("Selected mic is not hearing usable speech") instead of showing green while the mic is effectively deaf. A desktop shortcut/icon was also created.

### 3.5 Legacy version isolated (your June discovery)
You noticed a *different* AVA that auto-starts and "responds through media player." The agent identified it as **`ava_tray.pyw`** (the old `cmp-use` stack): it auto-listens 1s after login, uses `speech_recognition` + **OpenAI TTS** (`tts-1-hd`, voice "sage"), writes MP3s to `~/.cmpuse/temp/` and opens them with Windows Media Player. It was **shut down** (killed PID 9516) and documented as **"AVA Startup,"** separate from realtime AVA. Note: its startup shortcut was left in place, so it can relaunch at next login unless disabled.

### 3.6 Verification discipline
Throughout, changes were guarded with `py_compile`/`node --check` and a growing regression suite (voice invariants grew from ~48 to ~168 passing; a small number of *unrelated* scheduler-path tests stayed red the whole time). Subagents were spawned at points to parallelize repo exploration.

---

## 4. The core diagnosis (the one thing to internalize)

Stated by the agent in nearly identical form a dozen times, with evidence each time:

> **AVA's local ASR / wake / response / TTS path is healthy. The failure is the live physical capture path: the selected Realtek mic hears audio/noise/speaker-bleed, but the captured audio does not become intelligible, wake-qualified speech.**

The clinching evidence (2026-06-22): the agent replayed AVA's own **saved failed-turn mic recordings** straight back through the clean deterministic pipeline — and they **still transcribed as empty**. That rules out wake-gate logic, VAD thresholds, and ASR as the culprit. The captured audio itself doesn't contain recoverable speech. The recommendation was explicit: **do not lower VAD to force speaker-bleed through** — that just creates false triggers.

One important data point in your favor: when a **Logitech H5 headset mic** was briefly the selected input (2026-06-14), idle noise was `noise_rms=2` (essentially silent) and all dashboard cards went green. That's the cleanest the input path ever looked — strong evidence a proper close-talk mic removes the wall.

---

## 5. Secondary issues worth knowing

- **"She responds once, then stops."** You reported this several times (she answers 1–3 times then goes silent, or is "choppy," or cuts off mid-time-readout). I found **no task cycle that root-caused this multi-turn drop-off** — the agent was consumed by the capture problem. This is a real, separate symptom that has not been investigated and should be, *once capture is reliable.*
- **Usage-limit friction.** Several cycles (and the very last one) were cut off by a Codex usage gate that blocked running tests or restarting processes. This is why "code is on disk but not loaded into the running process" keeps recurring — including right now.
- **Dual-runtime confusion.** Early on, the running code and the repo you edited could diverge. Mostly addressed, but worth keeping in mind if a fix "doesn't take."
- **Security flags (not voice, but raised):** the legacy tray ran with shell enabled, confirmation/dry-run disabled, network enabled, and whitelist = all of `C:\`. Separately, startup entries `BAMonitor` / `BAStartup` / `BAUpdater` under "Browser Assistant" use hidden PowerShell with execution-policy bypass — flagged as **not AVA** but deserving a security review.

---

## 6. Where it left off (exact final state, 2026-06-22 ~14:18)

Your last instruction (2026-06-21): *"I won't be able to say the words for the test… find a way to run the voice test yourself — produce the sound through the speaker to see if the mic picks it up."*

The agent did exactly that, then concluded the speaker→room→mic path is too degraded to be a valid test, and pivoted to a better idea. Final actions:

1. Ran the no-human speaker-to-mic test at gain 3 and gain 8 → **both failed** (peak well below the VAD start threshold; Whisper heard junk like "Good." / "past"). Clean control WAV **passed**. Documented in `docs/AVA_REALTIME_VOICE_DIAGNOSIS.md`.
2. Built a **`--live-input-wav` "synthetic live-loop" mode** in `ava_local_voice.py` (+ `tools/voice_lab/16_local_input_wav_acceptance.py --live-loop`). This feeds a generated WAV through the **real** capture/VAD/finalize loop — not the old shortcut that skipped calibration. So the live state machine can now be tested without your voice, the webcam, or weak speaker bleed.
3. **Verified it works:** focused tests `39 passed`; the live-loop run captured a 4.35s utterance, transcribed *"Hey Abel, what time is it?"*, accepted `what time is it`, and replied *"It's 9:15 AM."*
4. Wired the dashboard's self-test button to use the stronger `--live-loop` mode **when the dashboard restarts**.

**The unfinished step:** restarting the dashboard process to load the new self-test was **blocked by the usage gate**. So:
- New code is on disk and tested. ✅
- The currently-running dashboard may still use the **old** self-test until restarted. ⚠️
- Realtime AVA was last running as `ava_local_voice.py` (PID `3368` earlier, then a fresh PID after restart).
- The fundamental gap is unchanged: **no real-world spoken acceptance has ever passed**, because no good physical mic has been used.

---

## 7. What I recommend next (prioritized, tied to your goal)

The evidence is overwhelming that you are ~1 hardware decision away from a working system. Ordered by value-per-effort:

**P0 — Prove it with a real mic (do this first, it's probably "the fix").**
Plug in a **USB or headset mic** (the Logitech H5 already on your machine, a gaming headset, or any ~$30–60 USB mic). In the dashboard: *Probe Non-Webcam Inputs* → *Apply Best Input* → restart AVA → say *"Hey AVA, what time is it?"*. The whole thread predicts this passes on the first try. If it does, the "voice doesn't work" saga is effectively over and the remaining work is polish. This is the cheapest, highest-probability path to your actual goal.

**P0.5 — Finish the last step the agent couldn't.**
When usage resets, **restart the dashboard** so its self-test button uses the new `--live-loop` code, then run the Direct Local Voice Self-Test once to confirm green. (One command; it was the only thing blocking "done" on the last cycle.)

**P1 — Decide the automated-test strategy and stop fighting room acoustics.**
The speaker→mic loopback is a dead end for automated testing (proven twice). Adopt the agent's own conclusion: use the **synthetic `--live-loop`** path for regression/CI, and reserve **physical mic testing for real human/headset speech**. Optionally install a **virtual audio cable** (e.g. VB-CABLE) so an automated test can route generated audio into a real input device — the closest thing to a true end-to-end test without you in the room.

**P2 — Root-cause the "responds once then stops" drop-off.**
This is the next real bug after capture, and it's never been investigated. Once a good mic gives reliable multi-turn input, run a 6-prompt acceptance pass and watch whether she goes silent after N turns — likely a session/barge-in/worker-readiness issue, not ASR.

**P3 — Close the OpenAI-realtime "feel" gap.**
Your stated north star is OpenAI-realtime smoothness. After capture is solved, the remaining latency levers the agent already identified: keep Piper warm across barge-in, keep replies short in voice mode, and tighten turn finalization. This is the difference between "it works" and "it feels instant."

**P4 — Housekeeping / safety.**
Disable the legacy "AVA Startup" tray shortcut so it can't relaunch and fight for the mic; lock down the `ava_bridge.py` default token and raw shell exec; and separately review the "Browser Assistant" `BA*` startup entries the agent flagged.

---

## 8. Honest caveats about this report

- It's built from the session's **user messages, the agent's own end-of-turn summaries, goal records, and file-change log** — i.e., what the agent *reported* doing and the transcript of what you told it. I did not independently open the AVA source files (they live under `C:\Users\USER 1\ava`, outside the folder you connected), so code-level claims reflect the thread's record, not a fresh code audit.
- The "responds once then stops" gap is my inference from your repeated reports plus the absence of any cycle addressing it — flagging it as un-investigated, not as a confirmed root cause.
- If you want, I can next do a **direct code audit** of the AVA repo (connect `C:\Users\USER 1\ava`) to verify the runtime matches these summaries and pin down the multi-turn drop-off.
