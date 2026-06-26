"""Record one live mic sample and compare Vosk/Whisper transcripts."""

from __future__ import annotations

import argparse
import audioop
import json
import statistics
import sys
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_VOSK_MODEL = ROOT / "vosk-models" / "vosk-model-small-en-us-0.15"
SAMPLE_WIDTH = 2
CHANNELS = 1

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.voice_lab.live_input_defaults import apply_configured_live_input  # noqa: E402


def _pcm_level(value: int, samples: int = 1600) -> bytes:
    return int(value).to_bytes(SAMPLE_WIDTH, "little", signed=True) * samples


def _chunk_rms_values(pcm: bytes, samples_per_chunk: int) -> list[int]:
    chunk_bytes = max(1, samples_per_chunk) * SAMPLE_WIDTH * CHANNELS
    values: list[int] = []
    for pos in range(0, len(pcm), chunk_bytes):
        chunk = pcm[pos : pos + chunk_bytes]
        if len(chunk) >= SAMPLE_WIDTH:
            values.append(audioop.rms(chunk, SAMPLE_WIDTH))
    return values


def _max_consecutive(values: list[int], threshold: int) -> int:
    best = 0
    current = 0
    for value in values:
        if value >= threshold:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def _first_last_above(values: list[int], threshold: int) -> tuple[int | None, int | None]:
    first = None
    last = None
    for idx, value in enumerate(values):
        if value >= threshold:
            if first is None:
                first = idx
            last = idx
    return first, last


def _rms_metrics(pcm: bytes, rate: int, frame_ms: int, vad_start: int, vad_stop: int, confirm_frames: int) -> dict[str, Any]:
    samples_per_chunk = max(1, int(rate * frame_ms / 1000.0))
    values = _chunk_rms_values(pcm, samples_per_chunk)
    if not values:
        return {
            "rms_mean": 0,
            "rms_median": 0,
            "rms_p95": 0,
            "rms_peak": 0,
            "above_start_frames": 0,
            "above_stop_frames": 0,
            "max_consecutive_start_ms": 0,
            "speech_like": False,
        }
    sorted_values = sorted(values)
    p95 = sorted_values[min(len(sorted_values) - 1, int((len(sorted_values) - 1) * 0.95))]
    consecutive = _max_consecutive(values, vad_start)
    stop_consecutive = _max_consecutive(values, vad_stop)
    first_stop, last_stop = _first_last_above(values, vad_stop)
    return {
        "rms_mean": int(sum(values) / len(values)),
        "rms_median": int(statistics.median(values)),
        "rms_p95": int(p95),
        "rms_peak": int(max(values)),
        "above_start_frames": int(sum(1 for value in values if value >= vad_start)),
        "above_stop_frames": int(sum(1 for value in values if value >= vad_stop)),
        "max_consecutive_start_ms": int(consecutive * frame_ms),
        "max_consecutive_stop_ms": int(stop_consecutive * frame_ms),
        "first_above_stop_ms": int(first_stop * frame_ms) if first_stop is not None else None,
        "last_above_stop_ms": int(last_stop * frame_ms) if last_stop is not None else None,
        "speech_like": bool(consecutive >= max(1, confirm_frames)),
    }


def _write_wav(path: Path, pcm: bytes, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(rate)
        wf.writeframes(pcm)


def _record_pcm(device: int, rate: int, duration: float, frame_ms: int) -> bytes:
    import pyaudio

    pa = pyaudio.PyAudio()
    stream = None
    frames_per_buffer = max(1, int(rate * frame_ms / 1000.0))
    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=rate,
            input=True,
            input_device_index=device,
            frames_per_buffer=frames_per_buffer,
        )
        expected_reads = max(1, int(round(duration / (frames_per_buffer / float(rate)))))
        chunks: list[bytes] = []
        frame_sec = frames_per_buffer / float(rate)
        started = time.time()
        for idx in range(expected_reads):
            chunks.append(stream.read(frames_per_buffer, exception_on_overflow=False))
            target = started + ((idx + 1) * frame_sec)
            delay = target - time.time()
            if delay > 0:
                time.sleep(delay)
        return b"".join(chunks)
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        pa.terminate()


def _transcribe_whisper(wav_path: Path, model_name: str) -> dict[str, Any]:
    try:
        from faster_whisper import WhisperModel

        started = time.time()
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(wav_path), language="en", vad_filter=True, beam_size=1)
        text = " ".join((segment.text or "").strip() for segment in segments).strip()
        retry_text = ""
        if not text:
            segments, _ = model.transcribe(str(wav_path), language="en", vad_filter=False, beam_size=1)
            retry_text = " ".join((segment.text or "").strip() for segment in segments).strip()
            text = retry_text
        return {
            "ok": True,
            "text": text,
            "no_vad_retry_text": retry_text,
            "elapsed_sec": round(time.time() - started, 3),
        }
    except Exception as exc:
        return {"ok": False, "text": "", "error": str(exc)}


def _transcribe_vosk(wav_path: Path, model_path: Path) -> dict[str, Any]:
    try:
        from vosk import KaldiRecognizer, Model, SetLogLevel

        SetLogLevel(-1)
        if not model_path.exists():
            return {"ok": False, "text": "", "error": f"model not found: {model_path}"}
        with wave.open(str(wav_path), "rb") as wf:
            rate = wf.getframerate()
            recognizer = KaldiRecognizer(Model(str(model_path)), rate)
            while True:
                data = wf.readframes(4000)
                if not data:
                    break
                recognizer.AcceptWaveform(data)
        final = json.loads(recognizer.FinalResult() or "{}")
        return {"ok": True, "text": str(final.get("text") or "").strip()}
    except Exception as exc:
        return {"ok": False, "text": "", "error": str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Record one live mic sample and transcribe it with Vosk and Whisper.")
    parser.add_argument("--device", type=int, default=None, help="PyAudio input device index; defaults to ava_voice_config.json")
    parser.add_argument("--rate", type=int, default=None, help="Input sample rate; defaults to ava_voice_config.json")
    parser.add_argument("--duration", type=float, default=5.0, help="Seconds to record")
    parser.add_argument("--frame-ms", type=int, default=30, help="Capture frame size in milliseconds")
    parser.add_argument("--vad-start", type=int, default=6500, help="Speech-start RMS threshold for metrics")
    parser.add_argument("--vad-stop", type=int, default=2500, help="Speech-stop RMS threshold for metrics")
    parser.add_argument("--confirm-frames", type=int, default=3, help="Consecutive start frames needed for speech_like")
    parser.add_argument("--whisper-model", default="tiny.en", help="faster-whisper model")
    parser.add_argument("--vosk-model", default=str(DEFAULT_VOSK_MODEL), help="Vosk model path")
    parser.add_argument("--output-dir", default=str(ROOT / "tmp_live_mic_transcribe"), help="Artifact directory")
    parser.add_argument("--prompt", default="", help="Prompt printed before recording")
    args = parser.parse_args()
    input_defaults = apply_configured_live_input(args)

    if args.prompt:
        print(args.prompt, file=sys.stderr, flush=True)
    print("Recording starts in 1 second...", file=sys.stderr, flush=True)
    time.sleep(1.0)

    started = time.time()
    pcm = _record_pcm(args.device, args.rate, max(1.0, args.duration), max(10, args.frame_ms))
    elapsed = time.time() - started
    out_dir = Path(args.output_dir)
    wav_path = out_dir / f"mic_probe_{datetime.now().strftime('%Y%m%d_%H%M%S')}_dev{args.device}_{args.rate}hz.wav"
    _write_wav(wav_path, pcm, args.rate)

    metrics = _rms_metrics(pcm, args.rate, max(10, args.frame_ms), args.vad_start, args.vad_stop, args.confirm_frames)
    result = {
        "ok": True,
        "device": args.device,
        "rate": args.rate,
        "input_defaults": input_defaults,
        "duration_sec": float(args.duration),
        "wall_elapsed_sec": round(elapsed, 3),
        "wav_path": str(wav_path),
        "metrics": metrics,
        "vosk": _transcribe_vosk(wav_path, Path(args.vosk_model)),
        "whisper": _transcribe_whisper(wav_path, str(args.whisper_model)),
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
