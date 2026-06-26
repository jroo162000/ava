"""One-shot local push-to-talk path for AVA.

This intentionally stays separate from the always-listening runner. It records a
short sample, uses local ASR, resolves the command without requiring a wake word,
routes through AVA's local reply path, and optionally speaks with Piper.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TRANSCRIBE_PROBE = ROOT / "tools" / "voice_lab" / "12_live_mic_transcribe_probe.py"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ava_local_voice import (  # noqa: E402
    CHANNELS,
    FORMAT,
    _load_config,
    _local_fact_reply,
    _normalize,
    _resample_pcm16,
    _server_respond,
    _strip_wake,
)
from tools.voice_lab.live_input_defaults import apply_configured_live_input  # noqa: E402
from voice.tts.piper_bin import PiperBinTTS  # noqa: E402


def _load_probe_module():
    spec = importlib.util.spec_from_file_location("live_mic_transcribe_probe", TRANSCRIBE_PROBE)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _is_bad_transcript(text: str) -> bool:
    normalized = _normalize(text)
    if not normalized:
        return True
    bad_exact = {
        "okay",
        "okay good job",
        "good job",
        "thank you",
        "thank you so much",
        "thanks for watching",
        "we will see you later",
    }
    if normalized in bad_exact:
        return True
    bad_phrases = (
        "thanks for watching",
        "see you later",
        "like and subscribe",
        "going to tell you this",
    )
    return any(phrase in normalized for phrase in bad_phrases)


def _local_hint_command(text: str) -> str:
    normalized = _normalize(text)
    if not normalized:
        return ""
    words = set(normalized.split())
    if any(pattern in normalized for pattern in ("what time", "time is it", "current time", "the time")):
        return "what time is it"
    if normalized == "time" or (words <= {"the", "time"} and "time" in words):
        return "what time is it"
    if any(pattern in normalized for pattern in ("what is today", "what day", "what date", "date today")):
        return "what is today"
    if normalized in {"today", "date", "day"}:
        return "what is today"
    if any(pattern in normalized for pattern in ("who are you", "what are you", "your name")):
        return "who are you"
    return ""


def _command_from_text(text: str) -> str:
    if _is_bad_transcript(text):
        return ""
    hint = _local_hint_command(text)
    if hint:
        return hint
    _has_wake, command = _strip_wake(text)
    return _normalize(command)


def resolve_command(vosk_text: str, whisper_text: str, metrics: dict[str, Any] | None = None) -> tuple[str, str]:
    """Return (command, source) for a push-to-talk recording."""
    metrics = metrics or {}
    speech_like = bool(metrics.get("speech_like", True))

    # Prefer compact Vosk local hints; Whisper often hallucinates on this Realtek path.
    vosk_hint = _local_hint_command(vosk_text)
    if vosk_hint and speech_like:
        return vosk_hint, "vosk_local_hint"

    whisper_command = _command_from_text(whisper_text)
    if whisper_command:
        return whisper_command, "whisper"

    vosk_command = _command_from_text(vosk_text)
    if vosk_command and speech_like:
        return vosk_command, "vosk"

    return "", "none"


def reply_for_command(command: str, config: dict[str, Any]) -> tuple[str, str]:
    local = _local_fact_reply(command)
    if local:
        return local, "local_fact"
    reply = _server_respond(command, config) if command else ""
    if reply:
        return reply, "server"
    return "I didn't catch that clearly. Try again closer to the microphone.", "fallback"


def _speak(reply: str, config: dict[str, Any]) -> bool:
    if not reply:
        return False
    import pyaudio

    audio_cfg = config.get("audio") or {}
    piper_cfg = ((config.get("local_fallback") or {}).get("piper") or {})
    exe = str(piper_cfg.get("exe") or (ROOT / "vendor" / "piper" / "piper.exe"))
    model = str(piper_cfg.get("model") or (ROOT / "vendor" / "piper" / "models" / "en_US-lessac-medium.onnx"))
    playback_rate = int(audio_cfg.get("playback_rate") or 44100)
    output_idx = audio_cfg.get("output_device")

    pa = pyaudio.PyAudio()
    stream = None
    tts = PiperBinTTS(exe, model)
    try:
        kwargs = {
            "format": FORMAT,
            "channels": CHANNELS,
            "rate": playback_rate,
            "output": True,
            "frames_per_buffer": max(int(playback_rate * 0.05), 512),
        }
        if output_idx is not None:
            kwargs["output_device_index"] = int(output_idx)
        stream = pa.open(**kwargs)
        source_rate = int(getattr(tts, "current_sample_rate", playback_rate) or playback_rate)

        def on_chunk(pcm: bytes) -> None:
            if pcm:
                stream.write(_resample_pcm16(pcm, source_rate, playback_rate))

        tts.speak(reply, on_chunk, frame_ms=100)
        return True
    finally:
        try:
            tts.stop()
        except Exception:
            pass
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        pa.terminate()


def run_once(args: argparse.Namespace) -> dict[str, Any]:
    probe = _load_probe_module()
    config = _load_config()
    input_defaults = apply_configured_live_input(args)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.prompt:
        print(str(args.prompt), file=sys.stderr, flush=True)
    if float(args.start_delay or 0.0) > 0:
        print(f"Recording starts in {float(args.start_delay):g} second(s)...", file=sys.stderr, flush=True)
        time.sleep(max(0.0, float(args.start_delay)))

    started = time.time()
    pcm = probe._record_pcm(args.device, args.rate, max(1.0, args.duration), max(10, args.frame_ms))
    wav_path = output_dir / f"ptt_{datetime.now().strftime('%Y%m%d_%H%M%S')}_dev{args.device}_{args.rate}hz.wav"
    probe._write_wav(wav_path, pcm, args.rate)
    metrics = probe._rms_metrics(pcm, args.rate, max(10, args.frame_ms), args.vad_start, args.vad_stop, args.confirm_frames)
    vosk = probe._transcribe_vosk(wav_path, Path(args.vosk_model))
    whisper = probe._transcribe_whisper(wav_path, str(args.whisper_model))

    command, command_source = resolve_command(
        str(vosk.get("text") or ""),
        str(whisper.get("text") or ""),
        metrics,
    )
    reply, reply_source = reply_for_command(command, config)
    spoke = False
    if not args.no_speak:
        spoke = _speak(reply, config)

    return {
        "ok": bool(command),
        "device": args.device,
        "rate": args.rate,
        "input_defaults": input_defaults,
        "duration_sec": float(args.duration),
        "wall_elapsed_sec": round(time.time() - started, 3),
        "wav_path": str(wav_path),
        "metrics": metrics,
        "vosk": vosk,
        "whisper": whisper,
        "command": command,
        "command_source": command_source,
        "reply": reply,
        "reply_source": reply_source,
        "spoke": spoke,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one local AVA push-to-talk turn.")
    parser.add_argument("--device", type=int, default=None, help="PyAudio input device index; defaults to ava_voice_config.json")
    parser.add_argument("--rate", type=int, default=None, help="Input sample rate; defaults to ava_voice_config.json")
    parser.add_argument("--duration", type=float, default=5.0, help="Seconds to record")
    parser.add_argument("--frame-ms", type=int, default=30, help="Capture frame size in milliseconds")
    parser.add_argument("--vad-start", type=int, default=5000, help="Speech-start RMS threshold for metrics")
    parser.add_argument("--vad-stop", type=int, default=1800, help="Speech-stop RMS threshold for metrics")
    parser.add_argument("--confirm-frames", type=int, default=3, help="Consecutive frames needed for speech_like")
    parser.add_argument("--whisper-model", default="tiny.en", help="faster-whisper model")
    parser.add_argument("--vosk-model", default=str(ROOT / "vosk-models" / "vosk-model-small-en-us-0.15"))
    parser.add_argument("--output-dir", default=str(ROOT / "tmp_push_to_talk"), help="Artifact directory")
    parser.add_argument("--no-speak", action="store_true", help="Do not play the reply through speakers")
    parser.add_argument("--prompt", default="", help="Prompt printed to stderr before capture")
    parser.add_argument("--start-delay", type=float, default=1.0, help="Seconds to wait before recording")
    args = parser.parse_args()

    print(json.dumps(run_once(args), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
