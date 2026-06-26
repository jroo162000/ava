# AVA Custom Piper Voice — Training Guide

Goal: train a custom Piper voice (Southern Black American woman) that runs **fast and local** on AVA — same engine and speed as her current voice. Training happens **once** on a free Google Colab GPU; the resulting lightweight `.onnx` then runs on AVA's existing hardware with no latency penalty.

---

## ⚠️ Read first — about the source audio

- A Piper voice is trained on **one speaker's** recordings, so the result will sound like **whoever's audio you provide**. It's not an "average accent" — it's that person's voice. Pick a source voice you actually like.
- **Consent / rights matter.** Only use audio you have the right to use: your own voice, a friend / family member / voice actor who **consents**, or properly licensed / royalty-free content. Do **not** train on a specific real person (a celebrity, someone from a random video, etc.) without their consent.
- Since you said "just the vibe, no specific person," the cleanest source is **one consenting Southern Black American woman** whose voice has the sound you want.

## What to give me (the "sample" = a small dataset, not one short clip)

Piper *training* needs much more than the ~10s a cloning tool would. Aim for:

- **Speaker:** ONE Southern Black American woman, natural conversational speech.
- **Amount:** more is better. Minimum useful ≈ 15–20 min; good ≈ 30–60 min; great ≈ 1–2 hr (~1,300 short phrases is the sweet spot).
- **Quality:** clean — no background music, TV, other voices, heavy noise, or strong echo. Consistent mic and room.
- **Variety:** lots of different sentences (reading varied text aloud is ideal), not a few repeated lines.
- **Format:** anything (`.wav/.mp3/.m4a/...`), one long file or many clips — the prep step handles splitting and conversion. Sample rate/mono/stereo don't matter (I resample to 22050 Hz mono).

When you have this, just hand me the folder/files and I'll take it from there.

## Workflow (what will happen)

1. **You gather** the audio above (to a folder or Google Drive).
2. **Data prep** (`prepare_dataset.py`, runs in Colab): splits long audio into 3–15s clips, resamples to 22050 Hz mono, auto-transcribes each clip with Whisper, and writes an LJSpeech dataset (`wavs/` + `metadata.csv`). You'll eyeball a few transcripts for accuracy.
3. **Fine-tune** on the Colab GPU from the `en_US-lessac-medium` checkpoint (medium quality, US English), ~1,000–2,000 epochs (a few hours).
4. **Export** to `model.onnx` + `model.onnx.json`.
5. **Install into AVA:** drop those two files into `ava-integration/vendor/piper/models/`, point `ava_voice_config.json → local_fallback.piper.model` at the new file, restart AVA. She now speaks in the new voice — at the same speed as today.

## Training settings (use these)

| Setting | Value | Why |
|---|---|---|
| Base checkpoint | `en_US-lessac-medium` | matches her current quality tier + speed |
| Quality | `medium` | same speed profile as now (don't use `high` on this hardware) |
| Language | `en-us` (US English) | best results with the pre-trained base |
| Validation split | `0.05` | tune up/down with dataset size |
| Fine-tune epochs | ~1,000–2,000 over the base | enough to take on the new voice |

## Who does what

- **I built:** the data-prep script, the notebook scaffold, and these instructions — and I'll walk you through running it cell by cell and troubleshoot errors live.
- **You do:** provide the audio, open the notebook in **your** Google account, switch the runtime to **GPU (T4)**, upload the audio, run the cells, and let it train for a few hours. (I can't run a multi-hour job on your Google login for you — but it's mostly "click Run and wait," and I'll be here for every snag.)

## Files in this folder

- `prepare_dataset.py` — turns raw audio into a Piper-ready LJSpeech dataset.
- `AVA_piper_train.ipynb` — the Colab notebook (prep → fine-tune → export → download).

> Note: Piper's training tooling changes fairly often. The notebook pins what it can, but the **training** step is the one most likely to need a small version tweak — if it errors, the maintained community notebook (rmcpantoja/piper) is a known-good fallback, and I'll adapt to whatever it expects.
