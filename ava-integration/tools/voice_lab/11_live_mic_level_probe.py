"""Live mic level probe for AVA local voice.

This intentionally does not run ASR or TTS. It answers one narrow question:
does the selected input device produce sustained voice energy above AVA's VAD
thresholds when the user speaks?
"""

from __future__ import annotations

import argparse
import audioop
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import pyaudio

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "ava_voice_config.json"
SAMPLE_WIDTH = 2
CHANNELS = 1
FORMAT = pyaudio.paInt16
TARGET_ASR_RATE = 16000


def _load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(math.ceil((pct / 100.0) * len(ordered))) - 1))
    return int(ordered[idx])


def _host_api_name(audio: pyaudio.PyAudio, info: dict[str, Any]) -> str:
    try:
        host = audio.get_host_api_info_by_index(int(info.get("hostApi") or 0))
        return str(host.get("name") or "")
    except Exception:
        return ""


def _device_candidates(audio: pyaudio.PyAudio, config: dict[str, Any]) -> list[dict[str, Any]]:
    audio_cfg = config.get("audio") if isinstance(config, dict) else {}
    audio_cfg = audio_cfg if isinstance(audio_cfg, dict) else {}
    configured_idx = audio_cfg.get("input_device")
    configured_rate = int(audio_cfg.get("input_sample_rate") or 44100)
    block_terms = ["webcam", "c920e"] + [str(x).lower() for x in audio_cfg.get("input_device_blocklist") or []]
    avoid_terms = [str(x).lower() for x in audio_cfg.get("input_device_avoid") or []]
    preferences = [str(x).lower() for x in audio_cfg.get("input_device_preferences") or []]
    try:
        configured_idx_int = int(configured_idx) if configured_idx is not None else None
    except Exception:
        configured_idx_int = None

    def blocked(name: str) -> bool:
        low = name.lower()
        return any(term in low for term in block_terms)

    raw: list[tuple[int, int, str, int, str]] = []
    for idx in range(audio.get_device_count()):
        try:
            info = audio.get_device_info_by_index(idx)
        except Exception:
            continue
        if int(info.get("maxInputChannels") or 0) <= 0:
            continue
        name = str(info.get("name") or f"device {idx}")
        if blocked(name):
            continue
        low = name.lower()
        host_name = _host_api_name(audio, info)
        host_low = host_name.lower()
        penalty = 0
        if any(term in low for term in avoid_terms):
            penalty += 100
        for pref_idx, term in enumerate(preferences):
            if term and term in low:
                penalty -= max(5, 25 - pref_idx * 5)
        if "microphone" in low:
            penalty -= 20
        if "headset" in low:
            penalty -= 15
        if configured_idx_int == idx:
            penalty -= 5
        if "wasapi" in host_low:
            penalty -= 45
        elif "directsound" in host_low:
            penalty += 5
        elif "mme" in host_low:
            penalty += 30
        elif "wdm-ks" in host_low:
            penalty += 60
        rate = int(info.get("defaultSampleRate") or configured_rate or TARGET_ASR_RATE)
        raw.append((penalty, idx, name, rate, host_name))

    seen: set[tuple[int, int]] = set()
    result: list[dict[str, Any]] = []
    fallback_rates = [configured_rate, TARGET_ASR_RATE, 44100, 48000]
    for penalty, idx, name, preferred_rate, host_name in sorted(raw, key=lambda x: x[0]):
        rates = [preferred_rate]
        if "wasapi" in host_name.lower():
            rates.extend([48000, configured_rate, TARGET_ASR_RATE, 44100])
        else:
            rates.extend(fallback_rates)
        for rate in rates:
            key = (int(idx), int(rate))
            if key in seen:
                continue
            seen.add(key)
            result.append({
                "idx": int(idx),
                "name": name,
                "rate": int(rate),
                "penalty": int(penalty),
                "host_api": host_name,
            })
    return result


def _measure_device(
    audio: pyaudio.PyAudio,
    candidate: dict[str, Any],
    duration_sec: float,
    start_threshold: int,
    stop_threshold: int,
    confirm_frames: int,
    prompt: str,
) -> dict[str, Any]:
    idx = int(candidate["idx"])
    rate = int(candidate["rate"])
    frames = max(int(rate * 0.03), 240)
    result: dict[str, Any] = {
        "idx": idx,
        "name": candidate["name"],
        "host_api": candidate.get("host_api") or "",
        "rate": rate,
        "frames_per_buffer": frames,
        "ok": False,
    }
    stream = None
    try:
        stream = audio.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=rate,
            input=True,
            input_device_index=idx,
            frames_per_buffer=frames,
        )
        if prompt:
            print(prompt, file=sys.stderr, flush=True)
        values: list[int] = []
        above_start = 0
        above_stop = 0
        max_consecutive_start = 0
        consecutive_start = 0
        frame_sec = frames / float(rate)
        expected_reads = max(1, int(math.ceil(duration_sec / frame_sec)))
        started_at = time.time()
        hard_deadline = started_at + duration_sec + 2.0
        for read_index in range(expected_reads):
            if time.time() > hard_deadline:
                break
            data = stream.read(frames, exception_on_overflow=False)
            rms = audioop.rms(data, SAMPLE_WIDTH)
            values.append(rms)
            if rms >= start_threshold:
                above_start += 1
                consecutive_start += 1
                max_consecutive_start = max(max_consecutive_start, consecutive_start)
            else:
                consecutive_start = 0
            if rms >= stop_threshold:
                above_stop += 1
            target_next = started_at + ((read_index + 1) * frame_sec)
            remaining = target_next - time.time()
            if remaining > 0:
                time.sleep(min(remaining, frame_sec))
        elapsed = max(0.0, time.time() - started_at)
        frame_ms = frame_sec * 1000.0
        result.update(
            {
                "ok": True,
                "duration_sec": duration_sec,
                "wall_elapsed_sec": round(elapsed, 3),
                "expected_reads": expected_reads,
                "frames": len(values),
                "rms_mean": int(sum(values) / len(values)) if values else 0,
                "rms_median": _percentile(values, 50),
                "rms_p95": _percentile(values, 95),
                "rms_peak": max(values) if values else 0,
                "above_start_frames": above_start,
                "above_stop_frames": above_stop,
                "above_start_ms": int(above_start * frame_ms),
                "above_stop_ms": int(above_stop * frame_ms),
                "max_consecutive_start_ms": int(max_consecutive_start * frame_ms),
                "vad_start": start_threshold,
                "vad_stop": stop_threshold,
                "confirm_frames": confirm_frames,
                "speech_like": max_consecutive_start >= confirm_frames and above_stop * frame_ms >= 250,
            }
        )
    except Exception as exc:
        result["error"] = str(exc)
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure live mic levels against AVA VAD thresholds.")
    parser.add_argument("--duration", type=float, default=8.0, help="Seconds to record per tested device.")
    parser.add_argument("--device", type=int, default=None, help="Specific PyAudio input device index.")
    parser.add_argument("--rate", type=int, default=None, help="Specific input sample rate.")
    parser.add_argument("--all", action="store_true", help="Probe all ranked candidates instead of the first usable one.")
    parser.add_argument("--vad-start", type=int, default=900, help="AVA speech-start RMS threshold.")
    parser.add_argument("--vad-stop", type=int, default=450, help="AVA speech-stop RMS threshold.")
    parser.add_argument("--confirm-frames", type=int, default=2, help="Consecutive frames above start threshold required.")
    parser.add_argument(
        "--prompt",
        default="SPEAK NOW: say 'Ava, what is today?' in your normal voice.",
        help="Prompt printed to stderr at the start of capture. Empty string disables it.",
    )
    args = parser.parse_args()

    config = _load_config()
    audio = pyaudio.PyAudio()
    try:
        candidates = _device_candidates(audio, config)
        if args.device is not None:
            rate = args.rate
            if rate is None:
                try:
                    info = audio.get_device_info_by_index(args.device)
                    rate = int(info.get("defaultSampleRate") or 44100)
                    name = str(info.get("name") or f"device {args.device}")
                except Exception:
                    rate = 44100
                    name = f"device {args.device}"
            else:
                try:
                    info = audio.get_device_info_by_index(args.device)
                    name = str(info.get("name") or f"device {args.device}")
                except Exception:
                    name = f"device {args.device}"
            candidates = [{"idx": args.device, "name": name, "rate": int(rate), "penalty": 0}]
        if not candidates:
            print(json.dumps({"ok": False, "error": "No input candidates found"}, indent=2))
            return 2

        tested = candidates if args.all else candidates[:1]
        results = [
            _measure_device(
                audio,
                candidate,
                max(1.0, float(args.duration)),
                int(args.vad_start),
                int(args.vad_stop),
                max(1, int(args.confirm_frames)),
                str(args.prompt or ""),
            )
            for candidate in tested
        ]
        best = max(results, key=lambda item: int(item.get("max_consecutive_start_ms") or 0)) if results else {}
        payload = {
            "ok": bool(best.get("ok")),
            "speech_like": bool(best.get("speech_like")),
            "best": best,
            "results": results,
            "candidate_count": len(candidates),
        }
        print(json.dumps(payload, indent=2))
        return 0 if payload["speech_like"] else 1
    finally:
        audio.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
