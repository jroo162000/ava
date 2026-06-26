# AVA — Full Tool Verification & Training Summary

_Prepared 2026-06-25. Covers the verification of all 41 of AVA's registered tools and an honest assessment of whether the training now makes her measurably better at tasks._

---

## 1. Executive summary

- AVA has **41 registered tools**. Every one now has (a) at least one realistic task in the training library, and (b) its **real code executed and observed at least once** — in the sandbox where that is safe, and on the real device where it is not.
- **Routing coverage: 41 / 41.** Earlier only 20 tools appeared in any task; the library was expanded so all 41 are exercised. On the 21 newly-added tools, AVA routed to the correct tool **36 / 42 paraphrases (86%)**.
- **Real code executed in the sandbox: 14 / 41** (the file/data/pure tools, plus the read-only `sys_ops`, `boot_repair`, `security_ops`).
- **Real code executed on the device: the remaining 27 / 41**, across five tiered passes plus a final `proactive_ops` test.
- **Net: 41 / 41 tools confirmed to actually run.** A handful "ran but need configuration to be fully useful" (noted below).
- The server was returned to normal mode after every test; the only intentional traces left behind are one test email (to your own address) and one Moltbook post.

---

## 2. What "verification" meant here — three distinct layers

These were conflated early on, so they are separated explicitly:

1. **Sandbox-safe (all 41).** The sandbox intercepts every tool so it can be run thousands of times with no real side effects. This proves the sandbox *handles* each tool safely — it is **not** a test of the tool's function.
2. **Routing tested (41 of 41).** A realistic task exists that should route to each tool; we measure whether AVA *chooses* the right tool with the right arguments. Most side-effect tools are **mocked** in the sandbox, so this layer tests her *decision*, not the tool's execution.
3. **Real code executed (41 of 41).** The tool's actual code ran and returned a real result — either in the sandbox (only possible for tools with no side effects) or on the real device.

The key structural fact: **a sandbox can only run real code for tools that don't change anything.** For a tool whose whole job is an action (send email, move the mouse, run a shell command), "running the real code" *is* the real-world effect, so it can only be verified on the real device.

---

## 3. Methodology

**Sandbox real-code path.** Read-only tools were promoted from "mock" to real execution behind a flag (`AVA_SANDBOX_REAL=1`) so they run their real code during a controlled test but stay mocked during normal training (we don't want real port scans on every rep).

**Tiered real-device path** (run against the normal server, with confirmation/safety per tier):
- **Tier 1 — read-only / observable:** system info, screen, camera, windows, audio level, email/calendar *read*, memory, Moltbook *read*. Non-disruptive.
- **Tier 2 — disruptive but recoverable:** open an app, type into a scratch Notepad, move + click the mouse, list/close windows, speak.
- **Tier 3 — irreversible, via safe stand-ins:** email to your own address, `Get-Date` shell, create-then-delete a throwaway calendar event, open a benign page, IoT device list.
- **Tier 5 — remaining:** Moltbook post (after claiming the account), a real browser form-fill practice, `computer_use` OCR-click, ElevenLabs voice, network scan.
- **Finale — `proactive_ops`:** set up a benign monitor → verify → tear it down with no residue.

---

## 4. Coverage results at a glance

| Layer | Count | Tools |
|---|---|---|
| Routing tasks in library | 41 / 41 | all |
| Real code run in **sandbox** | 14 | fs_ops, file_gen, fs_read, fs_find, json_ops, analysis_ops, layered_planner, test_echo, memory_search, self_awareness, status, sys_ops, boot_repair, security_ops |
| Real code run on **device** | 27 | (see per-tool table) |
| **Total real-executed** | **41 / 41** | all |

---

## 5. Per-tool verification table

| Tool | Category | Verified via | Real result observed | Notes |
|---|---|---|---|---|
| fs_ops | files | sandbox (real) | append/read/list/delete on fake device | append bug fixed |
| file_gen | files | sandbox (real) | created files (txt/docx/json/csv) | |
| fs_read | files | sandbox (real) | read file contents | |
| fs_find | files | sandbox (real) | found files by name | |
| json_ops | data | sandbox (real) | validated JSON | |
| analysis_ops | data | sandbox (real) | stats/math | |
| layered_planner | planning | sandbox (real) | step plan | |
| test_echo | test | sandbox (real) | echoed input | |
| memory_search | recall | sandbox (real) | searched memory/logs | |
| self_awareness | self | sandbox (real) | health diagnosis | |
| status | system | sandbox (real) | server status | |
| sys_ops | system | sandbox + device (real) | real OS/CPU/mem | |
| boot_repair | system | sandbox + device (real) | dry-run analysis | dry-run by design |
| security_ops | security | sandbox + device (real) | monitoring active | |
| screen_ops | perception | device (real) | screen size 1366×768 | |
| vision_ops | perception | device (real) | GPT vision described real screen | |
| window_ops | perception | device (real) | listed 30 windows; closed Notepad | |
| audio_ops | system | device (real) | volume read; spoke aloud | TTS via Windows fallback |
| self_mod | self | device (real) | diagnosed a tool | diagnose-only is read-only |
| learning_db | memory | device (real) | read patterns | |
| memory_system | memory | device (real) | recalled 8 memories | |
| camera_ops | perception | device (real) | real webcam capture + description | briefly turns camera on |
| comm_ops | comm | device (real) | read real Gmail; **sent a real email** | |
| calendar_ops | calendar | device (real) | read today; **created + deleted** event | |
| open_item | open | device (real) | launched Notepad | |
| key_ops | input | device (real) | typed 28 chars | |
| mouse_ops | input | device (real) | moved + left-clicked | |
| ps_exec | shell | device (real) | ran `Get-Date` | safe stand-in |
| browser_automation | web | device (real) | launched Chrome, typed fields, clicked submit | |
| computer_use | input | device (ran) | screenshot→OCR→click pipeline executed | OCR text-match unreliable |
| computer_use_control | input | device (real) | stopped automation | |
| voice_ops | voice | device (real) | spoke aloud | **ElevenLabs key not set → Windows TTS** |
| iot_ops | smarthome | device (ran) | listed devices | **Home Assistant not configured** |
| net_ops | web | device (ran) | returned "disabled" | **disabled by default** |
| remote_ops | remote | device (real) | scanned 192.168.1.1–255 | 0 devices found |
| moltbook_status | agents | device (real) | claimed; agent "AVA-Voice" | |
| moltbook_feed | agents | device (real) | read feed | |
| moltbook_search | agents | device (real) | 10 results | |
| moltbook_learnings | agents | device (real) | 102 learnings | |
| moltbook_post | agents | device (real) | **posted** (postId e0f03cce…) | needed account claim |
| proactive_ops | system | device (real) | schedule/start/status/health/cancel/stop | test torn down, monitor restored |

---

## 6. Tools that ran but need configuration to be fully useful

These executed their real code, but the external feature behind them isn't set up:

- **`voice_ops`** — works, but used Windows TTS because there is **no ElevenLabs API key**. Set `ELEVENLABS_API_KEY` to get the cloned/branded voices. (A credential, so it must be added by you.)
- **`iot_ops`** — code runs, but **Home Assistant isn't configured** (no `HOME_ASSISTANT_URL` / token), so there are no devices to control.
- **`net_ops`** — **disabled by default** as a safety setting; returns "network disabled."
- **`computer_use`** — the autonomous screenshot → OCR → click pipeline executes, but **OCR text-matching was unreliable**, so it didn't reliably land a click on the target text. Usable, but the weakest link.

---

## 7. What the training has actually changed in AVA's live behavior

The following are **live right now and persist across restarts**, and they do make her better at choosing/performing tasks:

- **Four routing/honesty rules** injected into her decision prompt: find→`fs_find` / read→`fs_read`; open/launch→`open_item`; create/write/append→`file_gen`/`fs_ops` **then read back to confirm before claiming success**; "what's on screen"→`screen_ops`/`vision_ops` without asking. One of these (the screen rule) was *learned and kept by the self-improvement loop* because it raised a held-out score; the others were hand-refined.
- **Four deterministic fast-paths** that bypass the model for intents it kept fumbling: camera-see, recall, **diagnose-a-tool**, and **open-a-file**. These convert previously-flaky behaviors into reliable ones.
- **Real tool fixes** discovered during training: the `fs_ops` append silent no-op, and the sandbox relative-path redirect.
- **Always-on learning substrate (P1–P5):** curated memory, skill capture after successful multi-step tasks, and an error→lesson distiller. These accrue slowly from real conversations.

---

## 8. Is the training now "consequential" — does AVA learn and get better?

**Short answer: yes, but in a specific, bounded sense — and not yet as an autonomous, continuous self-learner.**

What is genuinely true:
- She is **measurably better than before** at tool routing and honesty, because the learned/refined rules and deterministic handlers are live and persistent. That is real, durable improvement.
- The **self-improvement loop works**: it runs the task library, proposes a guidance rule, tests it, and **keeps it only if it raises a held-out score** — and it has kept genuine improvements with no regressions. So the machinery to "learn and get better" exists and is proven.
- The **always-on systems** (memory, skill capture, lessons-from-errors) do let her accrue small improvements from real use without any training run.

The honest limits:
- **Her model's weights are frozen** (GPT-4o-mini via API). "Learning" here means improving the *scaffolding around* the model — prompts, routing rules, skills, memory — **not** gradient/weight learning. This is "Path A" by design.
- **The training loop does not run on its own.** It only improves things when explicitly launched. Between runs, she is static except for the slow always-on accrual.
- **Autonomous gains so far are modest** — the loop has kept one or two rules per run; most of the visible improvement came from hand-refinement and the deterministic handlers, not from the loop teaching itself.

So: **she has gotten better, and the system can keep making her better — but right now that improvement is "on-demand and human-in-the-loop," not "continuous and self-driven."**

---

## 9. To make the training continuously consequential (recommended next steps)

1. **Schedule the meta-loop** (e.g., nightly/weekly) so it keeps proposing and held-out-validating rules against the task library without manual launches. (You previously deferred this.)
2. **Feed real failures back into the library** — when she fails or over-asks in actual use, capture that as a new graded task so she trains on real situations, not just synthetic ones.
3. **Strengthen the proposer** — let it target distinct failure clusters each iteration (already added), and add tasks per tool so the loop has signal for all 41.
4. **(Optional, the real "robot-RL" path)** — swap to a local open-weights model and fine-tune on her successful sandbox trajectories. This is the only path to true weight-level learning, and it needs a GPU + ML pipeline.

---

## 10. Key files (on this machine)

- Training library: `ava-integration/training/tasks.json` (120 graded tasks)
- Learned guidance (live): `ava-integration/memory/training_guidance.json`
- Sandbox + verifier + meta-loop: `ava-server/src/services/sandbox.js`, `ava-integration/ava_session_helpers/{run_tasks,meta_loop,stable_eval}.py`
- Verification outputs: `ava-integration/ava_session_helpers/deviceb_tier*.txt`, `realcode_test.txt`, `coverage_audit.txt`, `meta_report.txt`, `scoreboard.txt`
