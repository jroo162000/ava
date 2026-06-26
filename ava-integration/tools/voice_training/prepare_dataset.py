#!/usr/bin/env python3
"""
AVA Piper voice — dataset prep.

Turns raw audio (any format, one long file or many clips) into an LJSpeech-format
dataset for Piper training:
    <output>/wavs/<id>.wav      (22050 Hz, mono, 16-bit)
    <output>/metadata.csv       (lines: "<id>|<transcript>")

Forgiving by design: splits long recordings on silence into 3-15s clips,
normalizes loudness, auto-transcribes each clip with Whisper, and drops clips
that are too short/long or transcribe to nothing.

Run in Google Colab (GPU) or locally:
    python prepare_dataset.py --input ./raw_audio --output ./dataset --whisper-model small.en
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from pathlib import Path

TARGET_SR = 22050
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".mp4", ".webm"}


def log(*a):
    print("[prep]", *a, flush=True)


def ensure_deps():
    try:
        import pydub  # noqa: F401
        import soundfile  # noqa: F401
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception:
        log("Installing dependencies (pydub, soundfile, faster-whisper, ffmpeg)...")
        os.system(f"{sys.executable} -m pip install -q pydub soundfile faster-whisper")
        os.system("apt-get -qq install -y ffmpeg >/dev/null 2>&1 || true")


def clean_text(t: str) -> str:
    t = (t or "").strip()
    t = re.sub(r"\s+", " ", t)
    return t


def segment_audio(audio, min_sec, max_sec, min_silence_ms, silence_thresh_db):
    """Split on silence, then merge/slice into min_sec..max_sec windows."""
    from pydub import silence, AudioSegment

    chunks = silence.split_on_silence(
        audio,
        min_silence_len=min_silence_ms,
        silence_thresh=silence_thresh_db,
        keep_silence=200,
    )
    if not chunks:
        chunks = [audio]

    segments = []
    buf = AudioSegment.empty()
    min_ms, max_ms = int(min_sec * 1000), int(max_sec * 1000)
    for ch in chunks:
        buf += ch
        if len(buf) >= min_ms:
            while len(buf) > max_ms:
                segments.append(buf[:max_ms])
                buf = buf[max_ms:]
            if len(buf) >= min_ms:
                segments.append(buf)
                buf = AudioSegment.empty()
    if len(buf) >= min_ms:
        segments.append(buf)
    return segments


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="folder of raw audio files")
    ap.add_argument("--output", required=True, help="dataset output folder")
    ap.add_argument("--whisper-model", default="small.en", help="faster-whisper model (small.en good; medium.en more accurate)")
    ap.add_argument("--min-sec", type=float, default=3.0)
    ap.add_argument("--max-sec", type=float, default=15.0)
    ap.add_argument("--min-silence-ms", type=int, default=500)
    ap.add_argument("--silence-thresh-db", type=int, default=-38)
    args = ap.parse_args()

    ensure_deps()
    from pydub import AudioSegment
    from pydub.effects import normalize
    from faster_whisper import WhisperModel

    in_dir, out_dir = Path(args.input), Path(args.output)
    wav_dir = out_dir / "wavs"
    wav_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in in_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS)
    if not files:
        log(f"No audio files found under {in_dir}")
        sys.exit(1)
    log(f"Found {len(files)} source file(s).")

    # Whisper on GPU if available, else CPU.
    try:
        import torch
        use_gpu = torch.cuda.is_available()
    except Exception:
        use_gpu = False
    device = "cuda" if use_gpu else "cpu"
    compute = "float16" if use_gpu else "int8"
    log(f"Loading Whisper '{args.whisper_model}' on {device}...")
    asr = WhisperModel(args.whisper_model, device=device, compute_type=compute)

    rows = []
    idx = 0
    total_sec = 0.0
    for f in files:
        log(f"Processing {f.name} ...")
        try:
            audio = AudioSegment.from_file(f)
        except Exception as exc:
            log(f"  skip (cannot read): {exc}")
            continue
        audio = audio.set_channels(1).set_frame_rate(TARGET_SR)
        segments = segment_audio(audio, args.min_sec, args.max_sec, args.min_silence_ms, args.silence_thresh_db)
        log(f"  {len(segments)} candidate clip(s)")
        for seg in segments:
            seg = normalize(seg).set_channels(1).set_frame_rate(TARGET_SR).set_sample_width(2)
            wav_id = f"ava_{idx:05d}"
            wav_path = wav_dir / f"{wav_id}.wav"
            seg.export(wav_path, format="wav")
            seg_list, _info = asr.transcribe(str(wav_path), language="en", beam_size=5)
            text = clean_text(" ".join(s.text for s in seg_list))
            if len(text) < 2 or not re.search(r"[A-Za-z]", text):
                wav_path.unlink(missing_ok=True)
                continue
            rows.append((wav_id, text))
            total_sec += len(seg) / 1000.0
            idx += 1
            if idx % 25 == 0:
                log(f"  ...{idx} clips kept")

    if not rows:
        log("No usable clips produced. Check that the audio is clean speech.")
        sys.exit(1)

    meta = out_dir / "metadata.csv"
    with open(meta, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter="|", quoting=csv.QUOTE_MINIMAL)
        for wav_id, text in rows:
            w.writerow([wav_id, text])

    log("=" * 60)
    log(f"DONE. {len(rows)} clips, ~{total_sec/60.0:.1f} min total.")
    log(f"Dataset: {out_dir}")
    log(f"  wavs/        ({len(rows)} files, 22050 Hz mono)")
    log(f"  metadata.csv (id|text)")
    log("Spot-check a few transcripts in metadata.csv for accuracy before training.")
    log("=" * 60)


if __name__ == "__main__":
    main()
