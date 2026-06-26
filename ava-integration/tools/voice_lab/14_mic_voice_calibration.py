"""Guided mic calibration: compare background audio against user's voice."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TRANSCRIBE_PROBE = ROOT / "tools" / "voice_lab" / "12_live_mic_transcribe_probe.py"
PTT_ONCE = ROOT / "tools" / "voice_lab" / "13_push_to_talk_once.py"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.voice_lab.live_input_defaults import apply_configured_live_input  # noqa: E402


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", str(text or "").lower())).strip()


def score_text(actual: str, expected: str) -> float:
    actual_norm = _normalize(actual)
    expected_norm = _normalize(expected)
    if not actual_norm or not expected_norm:
        return 0.0
    if actual_norm == expected_norm or expected_norm in actual_norm:
        return 1.0
    actual_words = set(actual_norm.split())
    expected_words = set(expected_norm.split())
    if not actual_words or not expected_words:
        return 0.0
    overlap = len(actual_words & expected_words) / float(len(expected_words))
    if "time" in expected_words and "time" in actual_words:
        overlap = max(overlap, 0.72)
    if {"today", "date", "day"} & expected_words and {"today", "date", "day"} & actual_words:
        overlap = max(overlap, 0.72)
    return round(min(1.0, overlap), 3)


def evaluate_calibration(
    background: dict[str, Any],
    voice: dict[str, Any],
    vosk_text: str,
    whisper_text: str,
    command: str,
    expected_text: str,
    min_delta: int = 1200,
    min_ratio: float = 1.8,
    min_voice_p95: int = 1800,
    min_peak: int = 3000,
    min_text_score: float = 0.55,
) -> dict[str, Any]:
    bg_p95 = int(background.get("rms_p95") or 0)
    bg_peak = int(background.get("rms_peak") or 0)
    voice_p95 = int(voice.get("rms_p95") or 0)
    voice_peak = int(voice.get("rms_peak") or 0)
    p95_delta = voice_p95 - bg_p95
    peak_delta = voice_peak - bg_peak
    p95_ratio = round(voice_p95 / float(max(bg_p95, 1)), 2)
    peak_ratio = round(voice_peak / float(max(bg_peak, 1)), 2)
    energy_ok = (
        voice_p95 >= int(min_voice_p95)
        and voice_peak >= int(min_peak)
        and p95_delta >= int(min_delta)
        and p95_ratio >= float(min_ratio)
    )

    vosk_score = score_text(vosk_text, expected_text)
    whisper_score = score_text(whisper_text, expected_text)
    command_score = score_text(command, expected_text)
    text_score = max(vosk_score, whisper_score, command_score)
    asr_ok = text_score >= float(min_text_score) or bool(_normalize(command))
    viable = bool(energy_ok and asr_ok)

    no_voice_detected = voice_p95 < int(min_voice_p95) and voice_peak < int(min_peak)
    voice_weaker_than_background = p95_delta <= 0 and peak_delta <= 0
    has_timing = "max_consecutive_stop_ms" in voice
    sustained_voice_ms = int(voice.get("max_consecutive_stop_ms") or 0)
    first_voice_ms = voice.get("first_above_stop_ms")
    last_voice_ms = voice.get("last_above_stop_ms")
    short_voice_window = (
        has_timing
        and not energy_ok
        and not no_voice_detected
        and not voice_weaker_than_background
        and sustained_voice_ms < 700
        and voice_peak >= int(min_peak)
    )

    if viable:
        verdict = "viable"
        recommendation = "This mic can hear the test phrase above background and ASR found a usable command."
    elif no_voice_detected or voice_weaker_than_background:
        verdict = "no_voice_detected"
        recommendation = (
            "The voice phase did not contain usable speech. The timing may have been missed, "
            "the selected input may be wrong, or this mic is not picking up your voice."
        )
    elif short_voice_window:
        verdict = "short_voice_window"
        recommendation = (
            "The mic saw only a brief voice burst. Start speaking immediately after the voice cue "
            "and repeat the phrase for the full capture window, or move closer to the mic."
        )
    elif not energy_ok:
        verdict = "bad_energy"
        recommendation = (
            "Voice did not beat background enough. Move closer, lower room/media audio, "
            "choose another mic, or use a headset before realtime wake detection."
        )
    else:
        verdict = "bad_asr"
        recommendation = "Energy is usable, but ASR did not recognize the test phrase. Try another input or a larger ASR model."

    return {
        "viable": viable,
        "verdict": verdict,
        "recommendation": recommendation,
        "energy_ok": bool(energy_ok),
        "asr_ok": bool(asr_ok),
        "no_voice_detected": bool(no_voice_detected),
        "voice_weaker_than_background": bool(voice_weaker_than_background),
        "short_voice_window": bool(short_voice_window),
        "sustained_voice_ms": int(sustained_voice_ms),
        "first_voice_ms": first_voice_ms,
        "last_voice_ms": last_voice_ms,
        "p95_delta": int(p95_delta),
        "peak_delta": int(peak_delta),
        "p95_ratio": p95_ratio,
        "peak_ratio": peak_ratio,
        "voice_p95": int(voice_p95),
        "voice_peak": int(voice_peak),
        "background_p95": int(bg_p95),
        "background_peak": int(bg_peak),
        "text_score": float(text_score),
        "vosk_score": float(vosk_score),
        "whisper_score": float(whisper_score),
        "command_score": float(command_score),
    }


def _record_phase(probe, path: Path, device: int, rate: int, seconds: float, frame_ms: int, vad_start: int, vad_stop: int, confirm_frames: int) -> tuple[bytes, dict[str, Any]]:
    pcm = probe._record_pcm(device, rate, max(1.0, seconds), max(10, frame_ms))
    probe._write_wav(path, pcm, rate)
    metrics = probe._rms_metrics(pcm, rate, max(10, frame_ms), vad_start, vad_stop, confirm_frames)
    return pcm, metrics


def _audible_cue(enabled: bool, phase: str) -> None:
    if not enabled:
        return
    try:
        import winsound

        if phase == "voice":
            winsound.Beep(1200, 180)
            time.sleep(0.08)
            winsound.Beep(1500, 220)
        else:
            winsound.Beep(700, 180)
    except Exception:
        print("\a", file=sys.stderr, flush=True)


def run_calibration(args: argparse.Namespace) -> dict[str, Any]:
    probe = _load_module(TRANSCRIBE_PROBE, "live_mic_transcribe_probe")
    ptt = _load_module(PTT_ONCE, "push_to_talk_once")
    input_defaults = apply_configured_live_input(args)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if args.prompt:
        print(str(args.prompt), file=sys.stderr, flush=True)
    print(f"Background capture: stay quiet for {float(args.background_sec):g} second(s).", file=sys.stderr, flush=True)
    _audible_cue(bool(args.audible_cues), "background")
    time.sleep(max(0.0, float(args.start_delay or 0.0)))
    bg_wav = out_dir / f"mic_cal_{stamp}_background_dev{args.device}_{args.rate}hz.wav"
    _bg_pcm, background = _record_phase(
        probe,
        bg_wav,
        int(args.device),
        int(args.rate),
        float(args.background_sec),
        int(args.frame_ms),
        int(args.vad_start),
        int(args.vad_stop),
        int(args.confirm_frames),
    )

    print(
        f"Voice capture: repeat '{args.expected_text}' for {float(args.voice_sec):g} second(s).",
        file=sys.stderr,
        flush=True,
    )
    _audible_cue(bool(args.audible_cues), "voice")
    time.sleep(max(0.0, float(args.between_delay or 0.0)))
    voice_wav = out_dir / f"mic_cal_{stamp}_voice_dev{args.device}_{args.rate}hz.wav"
    _voice_pcm, voice = _record_phase(
        probe,
        voice_wav,
        int(args.device),
        int(args.rate),
        float(args.voice_sec),
        int(args.frame_ms),
        int(args.vad_start),
        int(args.vad_stop),
        int(args.confirm_frames),
    )

    vosk = probe._transcribe_vosk(voice_wav, Path(args.vosk_model))
    whisper = probe._transcribe_whisper(voice_wav, str(args.whisper_model))
    command, command_source = ptt.resolve_command(
        str(vosk.get("text") or ""),
        str(whisper.get("text") or ""),
        voice,
    )
    evaluation = evaluate_calibration(
        background,
        voice,
        str(vosk.get("text") or ""),
        str(whisper.get("text") or ""),
        command,
        str(args.expected_text or ""),
        min_delta=int(args.min_delta),
        min_ratio=float(args.min_ratio),
        min_voice_p95=int(args.min_voice_p95),
        min_peak=int(args.min_peak),
        min_text_score=float(args.min_text_score),
    )

    return {
        "ok": bool(evaluation["viable"]),
        "device": int(args.device),
        "rate": int(args.rate),
        "input_defaults": input_defaults,
        "expected_text": str(args.expected_text or ""),
        "background_wav": str(bg_wav),
        "voice_wav": str(voice_wav),
        "background": background,
        "voice": voice,
        "vosk": vosk,
        "whisper": whisper,
        "command": command,
        "command_source": command_source,
        "evaluation": evaluation,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate whether a mic can hear AVA commands above background.")
    parser.add_argument("--device", type=int, default=None, help="PyAudio input device index; defaults to ava_voice_config.json")
    parser.add_argument("--rate", type=int, default=None, help="Input sample rate; defaults to ava_voice_config.json")
    parser.add_argument("--background-sec", type=float, default=3.0)
    parser.add_argument("--voice-sec", type=float, default=8.0)
    parser.add_argument("--start-delay", type=float, default=1.0)
    parser.add_argument("--between-delay", type=float, default=1.0)
    parser.add_argument("--frame-ms", type=int, default=30)
    parser.add_argument("--vad-start", type=int, default=5000)
    parser.add_argument("--vad-stop", type=int, default=1800)
    parser.add_argument("--confirm-frames", type=int, default=3)
    parser.add_argument("--expected-text", default="ava what time is it")
    parser.add_argument("--whisper-model", default="tiny.en")
    parser.add_argument("--vosk-model", default=str(ROOT / "vosk-models" / "vosk-model-small-en-us-0.15"))
    parser.add_argument("--output-dir", default=str(ROOT / "tmp_mic_voice_calibration"))
    parser.add_argument("--min-delta", type=int, default=1200)
    parser.add_argument("--min-ratio", type=float, default=1.8)
    parser.add_argument("--min-voice-p95", type=int, default=1800)
    parser.add_argument("--min-peak", type=int, default=3000)
    parser.add_argument("--min-text-score", type=float, default=0.55)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--audible-cues", action="store_true", help="Play short beeps before background and voice phases")
    args = parser.parse_args()

    payload = run_calibration(args)
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
