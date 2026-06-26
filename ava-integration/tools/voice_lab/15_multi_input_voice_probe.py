"""Probe multiple non-webcam input devices during one spoken phrase.

The single-device probes proved that the current Realtek path can be alive while
still failing to capture a usable command. This tool records candidate inputs in
parallel, excludes webcam-style devices by default, then transcribes the strongest
captures so the runtime can stop guessing which physical mic is usable.
"""

from __future__ import annotations

import argparse
import audioop
import importlib.util
import json
import re
import subprocess
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TRANSCRIBE_PROBE = ROOT / "tools" / "voice_lab" / "12_live_mic_transcribe_probe.py"
DEFAULT_VOSK_MODEL = ROOT / "vosk-models" / "vosk-model-small-en-us-0.15"
DEFAULT_PIPER_EXE = ROOT / "vendor" / "piper" / "piper.exe"
DEFAULT_PIPER_MODEL = ROOT / "vendor" / "piper" / "models" / "en_US-lessac-medium.onnx"

BLOCKED_INPUT_NAME_PATTERNS = (
    "webcam",
    "camera",
    "c920",
    "c922",
    "brio",
    "logi",
    "logitech",
)


def _load_probe_module():
    spec = importlib.util.spec_from_file_location("live_mic_transcribe_probe", TRANSCRIBE_PROBE)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _normalize_text(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(text or "").lower()).strip()


def _text_score(text: str, expected: str) -> float:
    got = _normalize_text(text)
    want = _normalize_text(expected)
    if not got or not want:
        return 0.0
    if want in got or got in want:
        return 1.0
    want_tokens = set(want.split())
    got_tokens = set(got.split())
    if not want_tokens:
        return 0.0
    return round(len(want_tokens & got_tokens) / float(len(want_tokens)), 3)


def _is_blocked_input_name(name: str, blocked_patterns: tuple[str, ...] = BLOCKED_INPUT_NAME_PATTERNS) -> bool:
    normalized = _normalize_text(name)
    return any(pattern in normalized for pattern in blocked_patterns)


def _candidate_rates(default_rate: Any, preferred_rates: list[int]) -> list[int]:
    rates: list[int] = []
    try:
        default_int = int(round(float(default_rate)))
        if default_int > 0:
            rates.append(default_int)
    except Exception:
        pass
    rates.extend(int(rate) for rate in preferred_rates if int(rate) > 0)
    unique: list[int] = []
    for rate in rates:
        if rate not in unique:
            unique.append(rate)
    return unique


def _host_api_name(pa: Any, host_api_index: Any) -> str:
    try:
        info = pa.get_host_api_info_by_index(int(host_api_index))
        return str(info.get("name") or host_api_index)
    except Exception:
        return str(host_api_index)


def _openable_rate(device_index: int, rates: list[int]) -> tuple[int | None, str]:
    import pyaudio

    last_error = ""
    for rate in rates:
        pa = pyaudio.PyAudio()
        stream = None
        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=int(rate),
                input=True,
                input_device_index=int(device_index),
                frames_per_buffer=max(480, int(int(rate) * 0.03)),
            )
            return int(rate), ""
        except Exception as exc:
            last_error = str(exc)
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            pa.terminate()
    return None, last_error


def discover_candidates(
    preferred_rates: list[int],
    include_devices: set[int] | None = None,
    exclude_webcams: bool = True,
    max_candidates: int = 12,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    import pyaudio

    pa = pyaudio.PyAudio()
    candidates: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    try:
        for idx in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(idx)
            max_inputs = int(info.get("maxInputChannels") or 0)
            if max_inputs <= 0:
                continue
            if include_devices is not None and idx not in include_devices:
                continue
            name = str(info.get("name") or f"device {idx}")
            host_api = info.get("hostApi")
            host_name = _host_api_name(pa, host_api)
            base = {
                "index": idx,
                "name": name,
                "host_api": host_api,
                "host_api_name": host_name,
                "max_input_channels": max_inputs,
                "default_sample_rate": info.get("defaultSampleRate"),
            }
            if exclude_webcams and _is_blocked_input_name(name):
                blocked.append({**base, "reason": "blocked_webcam_name"})
                continue
            rate, error = _openable_rate(idx, _candidate_rates(info.get("defaultSampleRate"), preferred_rates))
            if rate is None:
                blocked.append({**base, "reason": "not_openable", "error": error})
                continue
            candidates.append({**base, "rate": rate})
            if len(candidates) >= max_candidates:
                break
    finally:
        pa.terminate()
    return candidates, blocked


def _record_open_stream(candidate: dict[str, Any], args: argparse.Namespace, start_event: threading.Event, ready: dict[str, Any]) -> dict[str, Any]:
    import pyaudio

    probe = _load_probe_module()
    pa = pyaudio.PyAudio()
    stream = None
    device = int(candidate["index"])
    rate = int(candidate["rate"])
    frame_ms = max(10, int(args.frame_ms))
    frames_per_buffer = max(1, int(rate * frame_ms / 1000.0))
    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=rate,
            input=True,
            input_device_index=device,
            frames_per_buffer=frames_per_buffer,
        )
        with ready["lock"]:
            ready["count"] += 1
            if ready["count"] >= ready["total"]:
                ready["event"].set()
        start_event.wait(max(1.0, float(args.start_delay) + 10.0))
        expected_reads = max(1, int(round(float(args.duration) / (frames_per_buffer / float(rate)))))
        chunks: list[bytes] = []
        frame_sec = frames_per_buffer / float(rate)
        started = time.time()
        for idx in range(expected_reads):
            chunks.append(stream.read(frames_per_buffer, exception_on_overflow=False))
            target = started + ((idx + 1) * frame_sec)
            delay = target - time.time()
            if delay > 0:
                time.sleep(delay)
        pcm = b"".join(chunks)
        metrics = probe._rms_metrics(pcm, rate, frame_ms, int(args.vad_start), int(args.vad_stop), int(args.confirm_frames))
        return {
            "ok": True,
            "device": device,
            "name": candidate.get("name"),
            "host_api_name": candidate.get("host_api_name"),
            "rate": rate,
            "pcm": pcm,
            "metrics": metrics,
        }
    except Exception as exc:
        with ready["lock"]:
            ready["count"] += 1
            if ready["count"] >= ready["total"]:
                ready["event"].set()
        return {
            "ok": False,
            "device": device,
            "name": candidate.get("name"),
            "host_api_name": candidate.get("host_api_name"),
            "rate": rate,
            "error": str(exc),
        }
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        pa.terminate()


def _audible_cue(enabled: bool) -> None:
    if not enabled:
        return
    try:
        import winsound

        winsound.Beep(880, 180)
        time.sleep(0.08)
        winsound.Beep(1040, 220)
    except Exception:
        pass


def _write_wav(path: Path, pcm: bytes, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(rate))
        wf.writeframes(pcm)


def _read_wav_mono_int16(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as wf:
        channels = int(wf.getnchannels())
        sample_width = int(wf.getsampwidth())
        rate = int(wf.getframerate())
        pcm = wf.readframes(wf.getnframes())
    if sample_width != 2:
        raise ValueError(f"unsupported sample width: {sample_width}")
    if channels == 2:
        pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
    elif channels != 1:
        raise ValueError(f"unsupported channel count: {channels}")
    return pcm, rate


def _resample_pcm16(pcm: bytes, source_rate: int, target_rate: int) -> bytes:
    if int(source_rate) == int(target_rate):
        return pcm
    converted, _state = audioop.ratecv(pcm, 2, 1, int(source_rate), int(target_rate), None)
    return converted


def _gain_pcm16(pcm: bytes, gain: float) -> bytes:
    if gain <= 0:
        return pcm
    if abs(gain - 1.0) < 0.001:
        return pcm
    return audioop.mul(pcm, 2, float(gain))


def _synthesize_piper_wav(text: str, wav_path: Path, piper_exe: str, piper_model: str) -> dict[str, Any]:
    if not text:
        return {"ok": False, "error": "empty_speaker_text"}
    if not Path(piper_exe).exists():
        return {"ok": False, "error": f"missing piper exe: {piper_exe}"}
    if not Path(piper_model).exists():
        return {"ok": False, "error": f"missing piper model: {piper_model}"}
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from voice.tts.piper_bin import PiperBinTTS

    tts = PiperBinTTS(str(piper_exe), str(piper_model))
    chunks: list[bytes] = []
    try:
        tts.speak(str(text), chunks.append, frame_ms=100)
        pcm = b"".join(chunks)
        if not pcm:
            return {"ok": False, "error": "piper produced no audio"}
        rate = int(getattr(tts, "current_sample_rate", 22050) or 22050)
        _write_wav(wav_path, pcm, rate)
        return {"ok": True, "wav_path": str(wav_path), "rate": rate, "bytes": len(pcm)}
    finally:
        try:
            tts.stop()
        except Exception:
            pass


def _play_wav(path: Path, playback_rate: int, output_device: int | None = None, gain: float = 1.0) -> dict[str, Any]:
    import pyaudio

    pcm, source_rate = _read_wav_mono_int16(path)
    pcm = _resample_pcm16(pcm, source_rate, int(playback_rate))
    pcm = _gain_pcm16(pcm, max(0.1, min(float(gain or 1.0), 8.0)))
    pa = pyaudio.PyAudio()
    stream = None
    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=int(playback_rate),
            output=True,
            output_device_index=output_device,
            frames_per_buffer=4096,
        )
        stream.write(b"\x00\x00" * int(playback_rate * 0.2))
        for pos in range(0, len(pcm), 8192):
            stream.write(pcm[pos : pos + 8192])
        stream.write(b"\x00\x00" * int(playback_rate * 0.1))
        return {
            "ok": True,
            "source_rate": source_rate,
            "playback_rate": int(playback_rate),
            "output_device": output_device,
            "gain": max(0.1, min(float(gain or 1.0), 8.0)),
            "bytes": len(pcm),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "output_device": output_device}
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        pa.terminate()


def _energy_score(metrics: dict[str, Any]) -> float:
    p95 = float(metrics.get("rms_p95") or 0)
    peak = float(metrics.get("rms_peak") or 0)
    sustained = float(metrics.get("max_consecutive_stop_ms") or 0)
    start_frames = float(metrics.get("above_start_frames") or 0)
    return (min(p95, 12000.0) * 0.35) + (min(peak, 24000.0) * 0.08) + (min(sustained, 4000.0) * 1.2) + (start_frames * 80.0)


def score_result(result: dict[str, Any], expected_text: str) -> dict[str, Any]:
    metrics = result.get("metrics") or {}
    vosk_text = str(((result.get("vosk") or {}).get("text")) or "")
    whisper_text = str(((result.get("whisper") or {}).get("text")) or "")
    vosk_score = _text_score(vosk_text, expected_text)
    whisper_score = _text_score(whisper_text, expected_text)
    text_score = max(vosk_score, whisper_score)
    energy = _energy_score(metrics)
    sustained = int(metrics.get("max_consecutive_stop_ms") or 0)
    p95 = int(metrics.get("rms_p95") or 0)
    score = energy + (text_score * 10000.0)
    if p95 < 300:
        score -= 5000.0
    if sustained < 300:
        score -= 1500.0
    viable = bool(text_score >= 0.55 and p95 >= 800 and sustained >= 300)
    return {
        **result,
        "vosk_score": vosk_score,
        "whisper_score": whisper_score,
        "text_score": text_score,
        "score": round(score, 3),
        "viable": viable,
    }


def _strip_pcm(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "pcm"}


def run_child_record(args: argparse.Namespace) -> int:
    probe = _load_probe_module()
    target = float(args.start_at or 0.0)
    delay = target - time.time()
    if delay > 0:
        time.sleep(delay)
    started = time.time()
    try:
        pcm = probe._record_pcm(int(args.device), int(args.rate), max(1.0, float(args.duration)), max(10, int(args.frame_ms)))
        wav_path = Path(str(args.wav_path))
        probe._write_wav(wav_path, pcm, int(args.rate))
        metrics = probe._rms_metrics(
            pcm,
            int(args.rate),
            max(10, int(args.frame_ms)),
            int(args.vad_start),
            int(args.vad_stop),
            int(args.confirm_frames),
        )
        payload = {
            "ok": True,
            "device": int(args.device),
            "name": str(args.name or ""),
            "host_api_name": str(args.host_api_name or ""),
            "rate": int(args.rate),
            "wall_elapsed_sec": round(time.time() - started, 3),
            "wav_path": str(wav_path),
            "metrics": metrics,
        }
        print(json.dumps(payload, indent=2))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "device": int(args.device),
                    "name": str(args.name or ""),
                    "host_api_name": str(args.host_api_name or ""),
                    "rate": int(args.rate),
                    "error": str(exc),
                },
                indent=2,
            )
        )
        return 1


def _child_record_command(candidate: dict[str, Any], args: argparse.Namespace, wav_path: Path, start_at: float) -> list[str]:
    return [
        sys.executable or "python",
        "-u",
        str(Path(__file__).resolve()),
        "--child-record",
        "--device",
        str(int(candidate["index"])),
        "--rate",
        str(int(candidate["rate"])),
        "--duration",
        f"{float(args.duration):g}",
        "--frame-ms",
        str(int(args.frame_ms)),
        "--vad-start",
        str(int(args.vad_start)),
        "--vad-stop",
        str(int(args.vad_stop)),
        "--confirm-frames",
        str(int(args.confirm_frames)),
        "--wav-path",
        str(wav_path),
        "--start-at",
        f"{start_at:.6f}",
        "--name",
        str(candidate.get("name") or ""),
        "--host-api-name",
        str(candidate.get("host_api_name") or ""),
    ]


def _collect_child_recordings(
    candidates: list[dict[str, Any]],
    args: argparse.Namespace,
    out_dir: Path,
    stamp: str,
) -> list[dict[str, Any]]:
    start_at = time.time() + max(3.0, float(args.ready_timeout))
    processes: list[tuple[dict[str, Any], subprocess.Popen[str]]] = []
    for candidate in candidates:
        wav_path = out_dir / f"multi_mic_{stamp}_dev{candidate['index']}_{candidate['rate']}hz.wav"
        cmd = _child_record_command(candidate, args, wav_path, start_at)
        processes.append(
            (
                candidate,
                subprocess.Popen(
                    cmd,
                    cwd=str(ROOT),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                ),
            )
        )

    cue_at = start_at - max(0.7, float(args.start_delay))
    cue_delay = cue_at - time.time()
    if cue_delay > 0:
        time.sleep(cue_delay)
    _audible_cue(bool(args.audible_cues))
    playback_result: dict[str, Any] | None = None
    speaker_wav = str(getattr(args, "speaker_wav", "") or "").strip()
    if speaker_wav:
        playback_result = _play_wav(
            Path(speaker_wav),
            int(getattr(args, "playback_rate", 44100) or 44100),
            getattr(args, "output_device", None),
            float(getattr(args, "speaker_gain", 1.0) or 1.0),
        )

    results: list[dict[str, Any]] = []
    timeout = max(15.0, float(args.duration) + float(args.ready_timeout) + 20.0)
    for candidate, proc in processes:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate(timeout=5)
            results.append(
                {
                    "ok": False,
                    "device": int(candidate["index"]),
                    "name": candidate.get("name"),
                    "host_api_name": candidate.get("host_api_name"),
                    "rate": int(candidate["rate"]),
                    "error": "child_record_timeout",
                    "stderr": str(stderr or "")[-2000:],
                }
            )
            continue
        try:
            parsed = json.loads((stdout or "").strip() or "{}")
        except Exception:
            parsed = {"ok": False, "raw_stdout": (stdout or "")[-2000:]}
        parsed.setdefault("device", int(candidate["index"]))
        parsed.setdefault("name", candidate.get("name"))
        parsed.setdefault("host_api_name", candidate.get("host_api_name"))
        parsed.setdefault("rate", int(candidate["rate"]))
        if proc.returncode != 0:
            parsed["ok"] = False
            parsed["returncode"] = proc.returncode
        if stderr:
            parsed["stderr"] = str(stderr)[-2000:]
        results.append(parsed)
    if playback_result is not None:
        for result in results:
            result["playback"] = playback_result
    return results


def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    probe = _load_probe_module()
    include_devices = None
    if args.devices:
        include_devices = {int(part.strip()) for part in str(args.devices).split(",") if part.strip()}
    preferred_rates = [int(part.strip()) for part in str(args.rates).split(",") if part.strip()]
    candidates, blocked = discover_candidates(
        preferred_rates=preferred_rates,
        include_devices=include_devices,
        exclude_webcams=not bool(args.allow_webcam),
        max_candidates=max(1, int(args.max_candidates)),
    )
    if not candidates:
        return {
            "ok": False,
            "message": "No non-webcam input candidates could be opened.",
            "candidates": [],
            "blocked": blocked,
            "best": None,
        }

    max_workers = max(1, min(int(args.max_parallel), len(candidates)))
    active_candidates = candidates[:max_workers]
    skipped_candidates = candidates[max_workers:]

    if args.prompt:
        print(str(args.prompt), file=sys.stderr, flush=True)
    print(
        f"Recording {len(active_candidates)} input candidate(s). Repeat '{args.expected_text}' until capture ends.",
        file=sys.stderr,
        flush=True,
    )

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    speaker_probe: dict[str, Any] | None = None
    speaker_text = str(getattr(args, "speaker_text", "") or "").strip()
    if speaker_text:
        speaker_wav = out_dir / f"speaker_probe_{stamp}.wav"
        speaker_probe = _synthesize_piper_wav(
            speaker_text,
            speaker_wav,
            str(getattr(args, "piper_exe", DEFAULT_PIPER_EXE) or DEFAULT_PIPER_EXE),
            str(getattr(args, "piper_model", DEFAULT_PIPER_MODEL) or DEFAULT_PIPER_MODEL),
        )
        if not speaker_probe.get("ok"):
            return {
                "ok": False,
                "message": "Could not synthesize speaker probe audio.",
                "speaker_probe": speaker_probe,
                "candidates": [],
                "blocked": blocked,
            }
        args.speaker_wav = str(speaker_wav)
    results = _collect_child_recordings(active_candidates, args, out_dir, stamp)

    scored = [score_result(result, str(args.expected_text)) for result in results]
    scored.sort(key=lambda item: float(item.get("score") or -999999), reverse=True)

    for result in scored[: max(0, int(args.whisper_top_n))]:
        if not result.get("ok") or not result.get("wav_path"):
            continue
        wav_path = Path(str(result["wav_path"]))
        result["vosk"] = probe._transcribe_vosk(wav_path, Path(args.vosk_model))
        result["whisper"] = probe._transcribe_whisper(wav_path, str(args.whisper_model))

    scored = [score_result(result, str(args.expected_text)) for result in scored]
    scored.sort(key=lambda item: float(item.get("score") or -999999), reverse=True)
    best = scored[0] if scored else None
    return {
        "ok": bool(best and best.get("viable")),
        "message": (
            f"Best non-webcam input: device {best.get('device')} ({best.get('name')})"
            if best
            else "No usable non-webcam input found."
        ),
        "expected_text": str(args.expected_text),
        "duration_sec": float(args.duration),
        "speaker_probe": speaker_probe,
        "best": _strip_pcm(best) if best else None,
        "candidates": [_strip_pcm(item) for item in scored],
        "skipped_candidates": skipped_candidates,
        "blocked": blocked,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Record and rank multiple non-webcam input devices at once.")
    parser.add_argument("--duration", type=float, default=8.0)
    parser.add_argument("--frame-ms", type=int, default=30)
    parser.add_argument("--vad-start", type=int, default=5000)
    parser.add_argument("--vad-stop", type=int, default=1800)
    parser.add_argument("--confirm-frames", type=int, default=3)
    parser.add_argument("--expected-text", default="ava what time is it")
    parser.add_argument("--rates", default="48000,44100,16000")
    parser.add_argument("--devices", default="", help="Optional comma-separated device indices to probe")
    parser.add_argument("--allow-webcam", action="store_true", help="Allow webcam/camera devices; off by default")
    parser.add_argument("--max-candidates", type=int, default=8)
    parser.add_argument("--max-parallel", type=int, default=8)
    parser.add_argument("--ready-timeout", type=float, default=6.0)
    parser.add_argument("--start-delay", type=float, default=1.0)
    parser.add_argument("--whisper-top-n", type=int, default=3)
    parser.add_argument("--whisper-model", default="tiny.en")
    parser.add_argument("--vosk-model", default=str(DEFAULT_VOSK_MODEL))
    parser.add_argument("--output-dir", default=str(ROOT / "tmp_multi_input_voice_probe"))
    parser.add_argument("--prompt", default="")
    parser.add_argument("--audible-cues", action="store_true")
    parser.add_argument("--speaker-text", default="", help="Synthesize and play this phrase through speakers while recording")
    parser.add_argument("--playback-rate", type=int, default=44100)
    parser.add_argument("--speaker-gain", type=float, default=1.0)
    parser.add_argument("--output-device", type=int, default=None)
    parser.add_argument("--piper-exe", default=str(DEFAULT_PIPER_EXE))
    parser.add_argument("--piper-model", default=str(DEFAULT_PIPER_MODEL))
    parser.set_defaults(speaker_wav="")
    parser.add_argument("--child-record", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--device", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--rate", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--wav-path", default="", help=argparse.SUPPRESS)
    parser.add_argument("--start-at", type=float, default=0.0, help=argparse.SUPPRESS)
    parser.add_argument("--name", default="", help=argparse.SUPPRESS)
    parser.add_argument("--host-api-name", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.child_record:
        return run_child_record(args)

    payload = run_probe(args)
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
