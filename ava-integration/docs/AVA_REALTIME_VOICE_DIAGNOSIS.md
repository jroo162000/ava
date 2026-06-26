# AVA Realtime Voice Diagnosis

Date: 2026-06-14

## Verdict

Do not restart from absolute zero. The local ASR, Piper TTS assets, device selection work, dashboard, and server `/respond` boundary are worth salvaging.

Do stop extending `ava_standalone_realtime.py` as the long-term realtime voice control plane. The recurring failures are orchestration failures: ASR finalization, response generation, TTS synthesis, playback, echo gating, and turn state are spread across too many paths and do not have one authoritative owner.

The recommended path is a parallel minimal local voice runner, then migration once it passes live multi-turn tests.

## Current Update: 2026-06-22

The local voice stack is healthy on clean input, but the current selected physical mic path is not producing usable speech.

Current live state:

- Active runner path: `ava_local_voice.py`.
- Active selected input: `Microphone (Realtek High Definition Audio)` device `2`, MME, `44100 Hz`.
- Webcam/C920e devices remain blocked and avoided.
- Dashboard diagnostics report the live mic loop as active, but `Voice session` and `Live acceptance` are warnings because no selected-input speech crosses VAD.
- Latest restarted runtime session after acoustic testing: `logs/realtime_ui/session_20260622_084942`.

Automated no-human speaker-to-mic result:

- Speaker-to-mic pass at `speaker_gain=3` played successfully, but Realtek capture only reached `peak=876`, `p95=340`; VAD start was `5000`. Vosk returned empty text, Whisper returned `Good.`, and AVA acceptance was `empty_transcript`.
- Speaker-to-mic pass at `speaker_gain=8` reached the mic more strongly but still failed: `peak=4214`, `p95=677`, `above_start_frames=0`. Vosk heard `asked`, Whisper heard `past`, and AVA acceptance was still `empty_transcript`.
- Direct local voice control test passed immediately afterward. Clean Piper-generated input was transcribed as `Hey Abel, what time is it? Hey Abel, what time is it?`, accepted command `what time is it`, and replied `It's 8:52 AM.`.
- The deterministic acceptance runner now supports `--live-loop`, which feeds a generated WAV through the actual `LISTENING -> FINALIZING` capture/VAD loop using a PyAudio-like synthetic stream. This catches failures that the older `--input-wav` shortcut could miss.
- Latest synthetic live-loop pass: `tools/voice_lab/16_local_input_wav_acceptance.py --live-loop` accepted `what time is it`, captured `4.35s` of synthetic mic audio, reached `captured_peak_rms=13234`, and replied `It's 9:15 AM.`.

Decision:

- Do not lower VAD just to make speaker bleed pass. The max-gain speaker capture is close in peak but not sustained speech, and ASR text is corrupted.
- Do not rewrite ASR/TTS or the brain path based on these acoustic failures. The clean generated WAV path proves wake cleanup, Whisper finalization, local response, and Piper synthesis are working.
- Do not count the old deterministic `--input-wav` shortcut as a full live-loop proof by itself. Prefer `--live-loop` because it exercises calibration, VAD, utterance capture, finalization, wake cleanup, response, and TTS attempt without physical mic/speaker acoustics.
- Treat speaker-to-mic as an acoustic pickup diagnostic only, not as the final acceptance gate for realtime voice.
- The next high-value target is the physical/Windows capture path: select a real non-webcam mic that can hear speech above VAD, fix Windows gain/permissions/mute, or add a virtual audio route for automated loopback when no human can speak.

Current acceptance rule:

- `Direct Local Voice Self-Test` proves the local voice stack when it uses `--live-loop`.
- `Speaker-to-Mic Self-Test` proves whether room audio from the speakers reaches the selected mic.
- Full realtime voice is not accepted until a non-webcam input produces real speech captures that cross VAD and generate accepted wake-command turns.

## Current Update: 2026-06-14

The diagnosis has moved beyond the original monolith/TTS lifecycle problem. The minimal local runner is now the correct path to keep editing; starting from scratch would throw away the parts that are finally giving us useful evidence.

Current live state:

- Active runner path: `ava_local_voice.py`, not the legacy realtime monolith.
- Dashboard reattaches to an already-running local runner and exposes the live acceptance analyzer.
- Latest focused tests: `10 passed` for local runner guardrails, acceptance analyzer, and deterministic transcript harness.
- Latest known stable runtime session: `logs/realtime_ui/session_20260614_230005`.
- Latest selected input: `Microphone (Realtek High Definition Audio) idx=14 host=Windows WASAPI rate=48000`.
- Latest VAD calibration on that input: `vad_start=699`, `vad_stop=466`.
- Latest failed live window did not reach ASR: `speech_starts=0`, `mic_idle_peak_max=355`, meaning the selected mic did not receive sustained speech above threshold during that test.

What actually failed in the newest live passes:

1. Stale configured input `idx=2` was an MME Realtek duplicate that stayed quiet and did not capture user speech.
2. DirectSound Realtek `idx=8` was hot/saturated and unsafe as an input.
3. WASAPI Realtek `idx=14` is the current best non-webcam fallback, but speech must physically reach that endpoint above VAD threshold.
4. Earlier WASAPI attempts showed audio could reach Whisper, but `faster-whisper` returned empty when `vad_filter=True`; the runner now retries with `vad_filter=False` only after VAD and wake-gate approval.
5. The last short test window showed no sustained speech on the selected input, so it did not exercise the new Whisper retry path.

The current blocker is therefore not TTS, not the brain server, and not the dashboard. It is the live input path: the selected non-webcam mic needs a successful spoken capture that crosses VAD, then we can verify whether the no-VAD Whisper retry recovers the transcript.

Decision:

- Continue editing the minimal local runner and diagnostic tools.
- Do not resume broad work in `ava_standalone_realtime.py`.
- Do not start from scratch; the architecture is now producing stage-specific evidence, and the remaining failures are localized.

Next live gate:

1. Keep the current local runner/dashboard open.
2. Speak directly into the active Windows input path and say `Ava, what is today?` several times.
3. Inspect `session_acceptance_analyzer.py` output.
4. If `speech_starts=0`, fix physical/Windows input selection or lower VAD for that endpoint.
5. If `whisper_retry_no_vad>0` and `ignored_empty_transcript>0`, capture/save the utterance WAV and debug Whisper model/audio format.
6. If `asr_final` appears but no reply, debug wake validation or command routing.

## What Is Actually Failing

The failures are not primarily the webcam mic, Realtek mic, wake words, or Piper voice quality.

The current runtime can hear, transcribe, call the brain server, and play Piper audio. The problem is that one spoken turn is not serialized as one owned transaction. The active unified path can overlap or desynchronize these phases:

1. ASR finalization
2. `/respond` request
3. TTS synthesis
4. playback queue drain
5. mic unmute / return to listening

That is why AVA can answer once or twice, then stop, cut herself off, or crash natively without a Python traceback.

## Evidence

Latest observed runtime failures:

- `session_20260613_093305`: AVA handled several turns, then the log ended during TTS after `MIC MUTED` and `TTS source rate...`, with no playback end and no Python traceback. The dashboard later reported native crash codes in the `0xC0000005` / `0xC0000409` family.
- `session_20260613_102119`: AVA accepted one turn, played one answer, returned to `IDLE`, then no later accepted input appeared. The log also showed repeated TTS lifecycle events for one logical answer.
- The active unified code segmented one reply and called `VoiceSession.speak()` repeatedly. Each call emitted `tts.start` and `tts.end`, while the runtime drained the playback queue on every `tts.start`.
- `tts.end` cleared `tts_active` when synthesis finished, not when playback finished. That let ASR and turn state advance while audio was still queued or playing.
- ASR final handling was still capable of running near TTS playback completion, proving the phases were not fully serialized.
- A fresh run on 2026-06-13 exited before user testing with code `3` after repeated `[vosk] ERROR: Failed to process waveform` while broad pre-wake Whisper rescue was processing non-wake background speech.
- After disabling broad pre-wake rescue, the runner stayed alive but still spent Whisper jobs on non-wake background audio via `hard_cutoff`; that path also needed wake/soft-wake evidence gating.
- After hard-cutoff suppression, live logs showed AVA remained stable but missed a likely date query because Vosk heard command fragments such as `date` without recognizing the wake phrase. A narrow query-content rescue was needed so Whisper can recover the wake phrase from buffered audio.

## Root Cause

`ava_standalone_realtime.py` is doing too much in one process and one file:

- audio device probing and fallback
- ASR wake gating and finalization
- VAD / echo gating
- server brain routing
- TTS synthesis
- playback queue ownership
- tool and validation gating
- dashboard/runtime integration
- legacy cloud and local fallback paths

The result is multiple semi-overlapping state machines. Fixes have repeatedly improved one path while another path still violated the same invariant.

## Stabilizer Applied

The current runner now has a bridge fix for the proven TTS lifecycle bug:

- `AVA_TTS_SEGMENTING` defaults to off in `_segment_text_for_tts`, so one logical reply gets one `VoiceSession.speak()` lifecycle by default.
- `AVA_TTS_CHUNKING` now requires explicit opt-in, so Piper cannot silently split a reply into multiple internal `speak()` calls.
- ASR finals are ignored while either `tts_active` is set or playback is still awaiting drain.
- `tts_active` remains set until playback drains, rather than clearing at synthesis end.
- An empty-queue guard unblocks AVA if synthesis ends after playback already drained or no audio was queued.
- Broad pre-wake Whisper rescue is disabled by default and requires `AVA_ASR_PREWAKE_RESCUE=1`, preventing ordinary room audio from repeatedly triggering Whisper finalization before a wake hint.
- Hard-cutoff finalization now suppresses pre-wake audio without exact wake or soft-wake command evidence, so background speech/noise does not keep dispatching Whisper before AVA is addressed.
- Pre-wake query rescue is enabled by default for Vosk fragments that look like user command/query content (`date`, `time`, `today`, `what`, etc.). This allows Whisper to inspect the buffered utterance, but it does not bypass validation: if Whisper does not recover a wake phrase, the runtime still suppresses the final.
- The dashboard records the relevant runtime env knobs in status.
- Voice invariants now cover this behavior.

Verification:

```powershell
python -m py_compile .\ava_standalone_realtime.py .\ava_realtime_ui.py .\tests\test_voice_invariants.py
python -m pytest tests\test_voice_invariants.py -q
```

Result: `97 passed`.
Updated after the inner Piper chunking guard: `98 passed`.

Updated current verification after the local runner/dashboard/server fixes:

```powershell
python -m pytest tests\test_python_worker.py tests\test_minimal_local_voice_runner.py -q
npm test -- --runInBand tests/configPath.test.js tests/chat.test.js
```

Results:

- Python worker/local voice tests: `23 passed`.
- Server config/respond tests: `6 passed`.
- Live dashboard status: `ava_local_voice.py` running as the local voice runner.
- Live brain status: dashboard-managed server up with Python worker ready.
- Live `/tools`: `41` tools total, including `31` cmp-use/Python tools and `10` builtins.

## Recommendation

Continue with a parallel rebuild of only the local realtime voice runner. Do not keep expanding the current monolith except for small stabilizers needed to keep the dashboard usable.

Build a new runner, `ava_local_voice.py`, with one explicit loop:

1. `LISTENING`: capture mic frames and feed ASR.
2. `FINALIZING`: stop accepting mic frames and obtain one final transcript.
3. `RESPONDING`: call local `/respond` once.
4. `SPEAKING`: synthesize/play one Piper utterance and keep mic muted.
5. `COOLDOWN`: clear ASR buffers, wait briefly, return to `LISTENING`.

Current scaffold:

- `ava_local_voice.py`: minimal half-duplex local runner.
- `start_local_voice.bat`: launcher for the minimal runner.
- `tests/test_minimal_local_voice_runner.py`: static guardrails proving this path stays separate from `ava_standalone_realtime.py`.

This runner intentionally drops Vosk from the hot path. It records one utterance, transcribes with local Whisper, validates wake on the final transcript, answers local date/time directly, calls `/respond` for other commands, and plays one Piper utterance synchronously.

Current implementation status:

- The dashboard now defaults to this local runner instead of the legacy monolith.
- The dashboard has separate `Start Local Voice` and `Start Legacy Realtime` controls.
- The dashboard parser understands `[local-voice]` readiness, input, ASR, and Piper markers.
- Desktop shortcuts exist for `AVA Realtime Lab` and `AVA Local Voice`.
- The local runner blocks the Logitech C920e/webcam mic by default and uses the configured Realtek mic when available.
- Wake-only turns open a 10-second guarded follow-up window after playback ends.
- Common ASR wake confusions (`Aba`, `Able`, `Abel`, `Hey bud`, `Hey but`) are accepted without disabling the wake gate.
- Local date/time facts are answered without server routing.
- Spoken self-description prompts such as `tell me about yourself` are no longer routed through the tool agent path that produced `Done.`.
- The server now resolves the actual sibling `ava-integration` directory instead of the old `%USERPROFILE%\ava-integration` path.
- The Python worker now starts from the real repo path and loads self-awareness, self-modification, and cmp-use modules.
- The tool cache no longer treats pre-worker-ready builtin-only results as fresh after the Python worker becomes ready.
- The local runner now records utterance duration, voiced time, peak RMS, and mean RMS, then drops low-confidence transients before Whisper and filters common no-wake Whisper filler such as `Okay` / `Thank you`.
- The latest long-running local session proved the remaining idle problem was ambient media/background speech, not random mic noise: Whisper produced hundreds of plausible non-wake transcripts from room audio. The local runner now loads the existing Vosk model as a wake prefilter from the first captured utterance, so background speech is logged as `ignored_wake_gate_no_wake` before Whisper instead of being fully transcribed.
- A synthetic Piper-to-Vosk wake check showed Vosk can mishear `Hey Ava, what time is it?` as query-shaped text such as `hey other what time is it`. The wake prefilter therefore includes a narrow query bypass (`wake_gate_query_bypass`) that sends command-shaped speech to Whisper for final wake validation instead of requiring Vosk to be the authoritative wake recognizer.
- The same synthetic matrix showed wake-only `Ava` can be heard by Vosk as `offer`. The wake prefilter now treats short/loud single-word phonetic wake aliases (`offer`, `over`, `other`, `evil`) as prefilter bypass hints only; Whisper still performs the final wake validation before AVA responds.
- Tool-style command verbs such as `open`, `search`, and `stop` also bypass the prefilter to Whisper for final validation, preventing the wake prefilter from blocking real addressed commands that Vosk recognizes only partially.
- `tools/voice_lab/session_acceptance_analyzer.py` analyzes a saved local voice session log against the live acceptance gate, including local input/Whisper/Piper readiness, date/time/identity replies, one cooldown per spoken reply, and critical runtime failures. Use it after each live pass so the result is evidence instead of memory.
- `tools/voice_lab/10_local_voice_turn_harness.py` runs a deterministic transcript-level acceptance path through the local runner without mic/speaker dependence. It verifies wake-only acknowledgement, no-wake follow-up, local date/time/identity facts, one general server-routed question, and silence/no-reply behavior before a human live pass.

Keep:

- `HybridASREngine`, after wrapping it behind a simpler interface.
- Piper binary/model assets.
- dashboard start/stop/log UI.
- device scoring and calibration as preflight utilities.
- server `/respond` as the single brain boundary.

Drop from the local realtime hot path:

- cloud ASR switching
- Edge TTS / MP3 / pygame / shell playback fallbacks
- reply micro-segmentation
- barge-in until basic half-duplex is reliable
- passive learning / overheard audio in the realtime loop
- runtime config watching and self-modification during voice turns

## Acceptance Gate

The local voice feature is not done until a live session can complete this without process restart:

1. `Hey Ava, what is today?`
2. `Ava, what time is it?`
3. `Ava, who are you?`
4. one general `/respond` question
5. one silence period
6. another wake-command turn

Required evidence:

- no native process crash
- no TTS cutoffs
- one answer per accepted final transcript
- no server path for local date/time facts
- mic automatically resumes after playback
- logs show one lifecycle per turn

Evidence helper:

```powershell
python .\tools\voice_lab\session_acceptance_analyzer.py .\logs\realtime_ui\<session>\stdout.log
python .\tools\voice_lab\10_local_voice_turn_harness.py
```

Current remaining gap:

- The dashboard/runtime evidence is green, and the local runner has completed successful wake/follow-up live tests, but the full six-step acceptance gate still needs one fresh live pass after the latest server/tool and wake-gate fixes.
- The current live runner has the VAD/noise confidence gate and Vosk wake prefilter active. It still needs a fresh live pass to prove the wake prefilter did not reduce wake-word sensitivity while reducing background/no-wake ASR churn.
