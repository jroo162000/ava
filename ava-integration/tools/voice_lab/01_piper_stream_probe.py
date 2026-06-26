"""Piper true-streaming probe.

Run this on your Windows host where Piper is installed.

What it measures (per utterance):
  - time to first stdout byte
  - time to WAV 'data' chunk start
  - time to first PCM frame emitted

Why you want this:
  If first PCM arrives only after the whole WAV is produced, your "streaming" is fake
  and local voice will never feel realtime.

Usage:
  python tools/voice_lab/01_piper_stream_probe.py
  python tools/voice_lab/01_piper_stream_probe.py --config ava_voice_config.json
  python tools/voice_lab/01_piper_stream_probe.py --text "Hey, this is a test"
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from typing import Optional, Tuple


def _parse_wav_header(buf: bytes) -> Tuple[Optional[int], Optional[int]]:
    if len(buf) < 44:
        return None, None
    if buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        return None, None

    i = 12
    sr: Optional[int] = None
    while i + 8 <= len(buf):
        chunk_id = buf[i:i + 4]
        chunk_size = int.from_bytes(buf[i + 4:i + 8], "little", signed=False)
        payload_start = i + 8
        payload_end = payload_start + chunk_size
        if payload_end > len(buf):
            return sr, None
        if chunk_id == b"fmt " and chunk_size >= 16:
            try:
                sr = int.from_bytes(buf[payload_start + 4: payload_start + 8], "little", signed=False)
            except Exception:
                pass
        if chunk_id == b"data":
            return sr, payload_start
        i = payload_end + (chunk_size % 2)
    return sr, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="ava_voice_config.json", help="Path to ava_voice_config.json")
    ap.add_argument("--text", default="Hey Ava, this is a realtime streaming probe.")
    ap.add_argument("--read", type=int, default=4096, help="stdout read size")
    args = ap.parse_args()

    cfg_path = args.config
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    lf = cfg.get("local_fallback") or {}
    piper = lf.get("piper") or {}
    exe = piper.get("exe")
    model = piper.get("model")
    if not exe or not model:
        print("[probe] Missing local_fallback.piper.exe/model in config")
        return 2

    espeak_dir = os.path.join(os.path.dirname(exe), "espeak-ng-data")
    cmd = [exe, "-m", model, "-f", "-"]
    if os.path.isdir(espeak_dir):
        cmd += ["--espeak_data", espeak_dir]

    t0 = time.perf_counter()
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    assert proc.stdin and proc.stdout

    proc.stdin.write((args.text + "\n").encode("utf-8", errors="ignore"))
    proc.stdin.flush()
    proc.stdin.close()

    first_byte_ms: Optional[float] = None
    data_ms: Optional[float] = None
    first_pcm_ms: Optional[float] = None
    sr: Optional[int] = None
    data_offset: Optional[int] = None
    header_buf = b""
    pcm_seen = 0

    while True:
        b = proc.stdout.read(args.read)
        if not b:
            break
        now_ms = (time.perf_counter() - t0) * 1000.0
        if first_byte_ms is None:
            first_byte_ms = now_ms
        if data_offset is None:
            header_buf += b
            sr, data_offset = _parse_wav_header(header_buf)
            if data_offset is not None and data_ms is None:
                data_ms = now_ms
                # Anything already received beyond data_offset is PCM
                pcm_seen += max(0, len(header_buf) - data_offset)
                if pcm_seen > 0 and first_pcm_ms is None:
                    first_pcm_ms = now_ms
        else:
            pcm_seen += len(b)
            if pcm_seen > 0 and first_pcm_ms is None:
                first_pcm_ms = now_ms

        if first_pcm_ms is not None:
            # We already proved streaming; keep reading a bit then stop.
            if pcm_seen > 48000:  # ~1 sec of 24k mono 16-bit, conservative
                break

    try:
        proc.terminate()
    except Exception:
        pass

    stderr = ""
    try:
        stderr = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
    except Exception:
        pass

    print("\n=== Piper Stream Probe ===")
    print(f"exe:   {exe}")
    print(f"model: {model}")
    print(f"sr:    {sr or 'unknown'}")
    print(f"text:  {args.text}")
    print("-")
    print(f"first_stdout_byte_ms: {first_byte_ms if first_byte_ms is not None else 'N/A'}")
    print(f"wav_data_chunk_ms:    {data_ms if data_ms is not None else 'N/A'}")
    print(f"first_pcm_byte_ms:    {first_pcm_ms if first_pcm_ms is not None else 'N/A'}")
    if stderr.strip():
        print("-")
        print("stderr:")
        print(stderr.strip())
    print("=========================\n")

    if first_pcm_ms is None:
        print("[probe] FAIL: never observed PCM bytes. Check paths/model and Piper output.")
        return 1
    if data_ms is None:
        print("[probe] WARN: PCM observed but WAV 'data' chunk not detected (unexpected format?)")
        return 0
    if first_pcm_ms - data_ms > 2500:
        print("[probe] WARN: PCM starts very late after data chunk start (buffering?)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
