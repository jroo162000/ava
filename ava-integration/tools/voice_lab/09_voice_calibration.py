"""Voice Lab tool: 09_voice_calibration.py

Guided calibration for AVa's live speaker-to-mic path using either a
prerecorded reference wake sample or a directly recorded one.

This keeps the real acoustic loop in play:
- record a short wake sample from a ranked live mic or load an existing WAV
- sweep candidate output devices
- for each output, reuse AVa's ranked live input selector and speech probe
- save the first calibrated input/output pair to logs/voice_calibration.json
- write a machine-readable summary of the run
"""

from __future__ import annotations

import argparse
import audioop
import json
import os
import shutil
import sys
import time
import types
import wave
from pathlib import Path
from typing import Any

import pyaudio

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _make_runner():
    from ava_standalone_realtime import StandaloneRealtimeAVA

    return StandaloneRealtimeAVA()


def _get_whisper_model_class():
    try:
        from faster_whisper import WhisperModel

        return WhisperModel
    except Exception:
        return None


DEFAULT_EXPECTED_TEXT = "Hey Ava say hello there"


def _timestamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def _load_voice_config() -> dict[str, Any]:
    return json.loads((ROOT / "ava_voice_config.json").read_text(encoding="utf-8"))


def _normalize_label(text: str) -> str:
    return " ".join(str(text or "").split()).strip()


def _default_probe_text() -> str:
    cfg = _load_voice_config()
    text = _normalize_label(
        str((((cfg.get("audio") or {}).get("loopback_probe") or {}).get("speech_text") or DEFAULT_EXPECTED_TEXT))
    )
    return text or DEFAULT_EXPECTED_TEXT


def _dedupe_candidates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[int, str]] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        idx = int(item.get("idx", -1))
        label = _normalize_label(str(item.get("label") or ""))
        key = (idx, label.casefold())
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _candidate_rates(preferred_rate: int, default_rate: int) -> list[int]:
    rates: list[int] = []
    for rate in [preferred_rate, default_rate, 48000, 44100, 16000]:
        try:
            rate_i = int(rate)
        except Exception:
            continue
        if rate_i > 0 and rate_i not in rates:
            rates.append(rate_i)
    return rates or [44100, 48000, 16000]


def _list_input_devices() -> list[dict[str, Any]]:
    pa = pyaudio.PyAudio()
    devices: list[dict[str, Any]] = []
    try:
        for idx in range(int(pa.get_device_count() or 0)):
            try:
                info = pa.get_device_info_by_index(idx)
            except Exception:
                continue
            if int(info.get("maxInputChannels", 0) or 0) <= 0:
                continue
            label = _normalize_label(str(info.get("name") or f"device idx={idx}"))
            default_rate = int(round(float(info.get("defaultSampleRate", 44100) or 44100)))
            devices.append({
                "idx": int(idx),
                "label": label,
                "default_rate": int(default_rate),
                "max_input_channels": int(info.get("maxInputChannels", 0) or 0),
            })
    finally:
        pa.terminate()
    return devices


def _print_input_devices(devices: list[dict[str, Any]]) -> None:
    for device in devices:
        print(
            f"INPUT_DEVICE idx={int(device['idx'])}\t"
            f"label={device['label']}\t"
            f"default_rate={int(device['default_rate'])}\t"
            f"channels={int(device['max_input_channels'])}"
        )


def _resolve_input_device_override(pa, requested_index: int | None, requested_name: str) -> dict[str, Any] | None:
    if requested_index is None and not _normalize_label(requested_name):
        return None

    devices: list[dict[str, Any]] = []
    for idx in range(int(pa.get_device_count() or 0)):
        try:
            info = pa.get_device_info_by_index(idx)
        except Exception:
            continue
        if int(info.get("maxInputChannels", 0) or 0) <= 0:
            continue
        devices.append({
            "idx": int(idx),
            "label": _normalize_label(str(info.get("name") or f"device idx={idx}")),
            "rate": int(round(float(info.get("defaultSampleRate", 44100) or 44100))),
        })

    if requested_index is not None:
        for device in devices:
            if int(device["idx"]) == int(requested_index):
                return device
        raise RuntimeError(f"Requested record input index not found or not usable: {requested_index}")

    requested_name_n = _normalize_label(requested_name).lower()
    exact = [device for device in devices if device["label"].lower() == requested_name_n]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        matches = ", ".join(f"idx={int(device['idx'])}:{device['label']}" for device in exact)
        raise RuntimeError(
            f"Requested record input name is ambiguous: {requested_name} -> {matches}; use --record-input-index"
        )

    partial = [device for device in devices if requested_name_n in device["label"].lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        partial.sort(key=lambda item: (len(item["label"]), int(item["idx"])))
        matches = ", ".join(f"idx={int(device['idx'])}:{device['label']}" for device in partial)
        raise RuntimeError(
            f"Requested record input name is ambiguous: {requested_name} -> {matches}; use --record-input-index"
        )
    raise RuntimeError(f"Requested record input name not found: {requested_name}")


def _copy_probe_wav(run_dir: Path, input_wav: str) -> tuple[Path, Path]:
    source = Path(str(input_wav or "").strip()).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(f"Input WAV not found: {source}")
    if source.suffix.lower() != ".wav":
        raise ValueError(f"Input file must be a WAV: {source}")
    target = run_dir / "reference_probe.wav"
    if source != target:
        shutil.copy2(source, target)
    return target, source


def _write_pcm_wav(wav_path: Path, pcm_bytes: bytes, sample_rate: int) -> None:
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(max(int(sample_rate or 16000), 1))
        wf.writeframes(bytes(pcm_bytes or b""))


def _load_probe_pcm(wav_path: Path) -> tuple[bytes, int]:
    with wave.open(str(wav_path), "rb") as wf:
        channels = int(wf.getnchannels() or 1)
        sample_width = int(wf.getsampwidth() or 2)
        sample_rate = int(wf.getframerate() or 16000)
        pcm = wf.readframes(wf.getnframes())
    if channels > 1:
        pcm = audioop.tomono(pcm, sample_width, 0.5, 0.5)
        channels = 1
    if sample_width != 2:
        pcm = audioop.lin2lin(pcm, sample_width, 2)
    if channels != 1:
        raise ValueError(f"Probe WAV must decode to mono PCM: {wav_path}")
    return bytes(pcm), sample_rate


def _transcribe_reference_wav(wav_path: Path, model_name: str) -> str:
    whisper_model_cls = _get_whisper_model_class()
    if whisper_model_cls is None:
        return ""
    model = whisper_model_cls(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        str(wav_path),
        language="en",
        beam_size=1,
        best_of=1,
        temperature=0.0,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    return " ".join(seg.text.strip() for seg in segments if getattr(seg, "text", "").strip()).strip()


def _resolve_expected_text(reference_wav: Path, explicit_text: str) -> tuple[str, str]:
    explicit_text = _normalize_label(explicit_text)
    if explicit_text:
        return explicit_text, "cli"

    cfg = _load_voice_config()
    model_name = str((cfg.get("local_fallback") or {}).get("whisper_model") or "tiny.en").strip() or "tiny.en"
    transcribed = _normalize_label(_transcribe_reference_wav(reference_wav, model_name))
    if transcribed:
        return transcribed, "whisper"

    return _default_probe_text(), "config"


def _output_sort_key(candidate: dict[str, Any], *, current_idx: int | None, current_name: str, saved_name: str):
    label = str(candidate.get("label") or "")
    label_l = label.lower()
    score = 0.0
    if current_idx is not None and int(candidate.get("idx", -1)) == int(current_idx):
        score -= 300.0
    if current_name:
        current_name_l = current_name.lower()
        if label_l == current_name_l:
            score -= 180.0
        elif current_name_l in label_l:
            score -= 120.0
    if saved_name:
        saved_name_l = saved_name.lower()
        if label_l == saved_name_l:
            score -= 120.0
        elif saved_name_l in label_l:
            score -= 90.0
    if any(term in label_l for term in ("speaker", "headphone", "headset", "realtek", "usb")):
        score -= 20.0
    if any(term in label_l for term in ("sound mapper", "stereo mix", "loopback", "what u hear")):
        score += 150.0
    return (score, label_l, int(candidate.get("idx", -1)))


def _enumerate_output_candidates(pa, runner: StandaloneRealtimeAVA, max_outputs: int) -> list[dict[str, Any]]:
    aud_cfg = runner.cfg.get("audio") or {}
    saved_state = getattr(runner, "_voice_calibration_state", {}) or {}
    current_idx = runner.output_device_index
    current_name = _normalize_label(str(aud_cfg.get("output_device_name") or ""))
    saved_name = _normalize_label(str(saved_state.get("output_device_name") or ""))
    candidates: list[dict[str, Any]] = []

    try:
        dev_count = int(pa.get_device_count() or 0)
    except Exception:
        dev_count = 0

    for idx in range(dev_count):
        try:
            info = pa.get_device_info_by_index(idx)
        except Exception:
            continue
        if int(info.get("maxOutputChannels", 0) or 0) <= 0:
            continue
        label = _normalize_label(str(info.get("name") or f"device idx={idx}"))
        default_rate = int(round(float(info.get("defaultSampleRate", aud_cfg.get("playback_rate", 44100)) or 44100)))
        if default_rate <= 0:
            default_rate = int(aud_cfg.get("playback_rate") or 44100)
        candidates.append(
            {
                "idx": int(idx),
                "label": label,
                "rate": int(default_rate),
            }
        )

    ranked = sorted(
        _dedupe_candidates(candidates),
        key=lambda item: _output_sort_key(item, current_idx=current_idx, current_name=current_name, saved_name=saved_name),
    )
    if int(max_outputs or 0) > 0:
        ranked = ranked[: int(max_outputs)]
    return ranked


def _install_probe_override(
    runner: StandaloneRealtimeAVA,
    *,
    probe_pcm: bytes,
    probe_sample_rate: int,
    expected_text: str,
) -> None:
    pcm_cache: dict[int, bytes] = {}

    def _probe_from_reference(self, probe_cfg: dict | None, output_rate: int):
        rate = int(output_rate or probe_sample_rate or 16000)
        cached = pcm_cache.get(rate)
        if cached is None:
            pcm = bytes(probe_pcm)
            if probe_sample_rate > 0 and rate > 0 and probe_sample_rate != rate:
                pcm, _ = audioop.ratecv(pcm, 2, 1, probe_sample_rate, rate, None)
            cached = bytes(pcm)
            pcm_cache[rate] = cached
        return cached, expected_text

    runner._synthesize_loopback_probe_speech = types.MethodType(_probe_from_reference, runner)


def _open_record_input_stream(
    runner,
    pa,
    *,
    aud_cfg: dict[str, Any],
    requested_input: dict[str, Any] | None,
):
    config_rate = int(aud_cfg.get("input_sample_rate") or 44100)
    if requested_input is None:
        rates_to_try = _candidate_rates(config_rate, config_rate)
        return runner._open_ranked_input_stream(
            pa,
            sample_format=pyaudio.paInt16,
            channels=1,
            rates_to_try=rates_to_try,
            config_rate=config_rate,
            mode_label="input",
        )

    idx = int(requested_input["idx"])
    label = str(requested_input["label"])
    rates_to_try = _candidate_rates(config_rate, int(requested_input.get("rate") or config_rate))
    for rate in rates_to_try:
        frame_count = max(int(rate * 0.02), 160)
        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=int(rate),
                input=True,
                frames_per_buffer=frame_count,
                input_device_index=idx,
            )
            print(f"[audio] Forced record input: {label} (idx={idx}) @ {int(rate)} Hz")
            return stream, idx, int(rate), frame_count
        except Exception as exc:
            print(f"[audio] Forced record input failed: {label} (idx={idx}) @ {int(rate)} Hz: {exc}")
    raise RuntimeError(f"Requested record input unavailable: {label} (idx={idx})")


def _record_reference_sample(
    *,
    run_dir: Path,
    expected_text: str,
    record_seconds: float,
    record_input_index: int | None = None,
    record_input_name: str = "",
) -> tuple[Path, dict[str, Any]]:
    runner: StandaloneRealtimeAVA | None = None
    stream = None
    requested_input_name = _normalize_label(record_input_name)
    try:
        runner = _make_runner()
        runner.cfg = dict(runner.cfg)
        aud_cfg = dict(runner.cfg.get("audio") or {})
        probe_cfg = dict(aud_cfg.get("loopback_probe") or {})
        probe_cfg["enabled"] = False
        probe_cfg["require_speech_calibration"] = False
        probe_cfg["allow_failed_calibration_fallback"] = True
        aud_cfg["loopback_probe"] = probe_cfg
        runner.cfg["audio"] = aud_cfg

        pa = runner.audio
        if pa is None:
            raise RuntimeError("PyAudio did not initialize in StandaloneRealtimeAVA")

        requested_input = _resolve_input_device_override(pa, record_input_index, requested_input_name)
        runner.input_device_index = int(requested_input["idx"]) if requested_input is not None else None

        stream, selected_input_idx, selected_input_rate, frame_count = _open_record_input_stream(
            runner,
            pa,
            aud_cfg=aud_cfg,
            requested_input=requested_input,
        )
        if stream is None or selected_input_idx is None or selected_input_rate is None or frame_count is None:
            raise RuntimeError("No usable input device available to record a reference sample")

        try:
            info = pa.get_device_info_by_index(int(selected_input_idx))
            selected_input_name = _normalize_label(str(info.get("name") or ""))
        except Exception:
            selected_input_name = str(requested_input.get("label") or "") if requested_input else ""

        duration_sec = max(float(record_seconds or 0.0), 1.0)
        lead_in_sec = 1.0
        read_count = max(int((duration_sec * float(selected_input_rate)) / float(frame_count)), 1)
        print(f"RECORDING_PROMPT={expected_text}")
        print(f"RECORDING_INPUT={selected_input_name}")
        print(f"RECORDING_SECONDS={duration_sec:.1f}")
        print(f"RECORDING_START_IN={lead_in_sec:.1f}")
        time.sleep(lead_in_sec)

        chunks = []
        for _ in range(read_count):
            chunks.append(stream.read(frame_count, exception_on_overflow=False))
        pcm = b"".join(chunks)
        recorded_wav = run_dir / "recorded_reference.wav"
        _write_pcm_wav(recorded_wav, pcm, int(selected_input_rate))

        cfg = _load_voice_config()
        model_name = str((cfg.get("local_fallback") or {}).get("whisper_model") or "tiny.en").strip() or "tiny.en"
        recorded_text = _normalize_label(_transcribe_reference_wav(recorded_wav, model_name))
        probe_cfg = ((cfg.get("audio") or {}).get("loopback_probe") or {})
        min_score = float(probe_cfg.get("speech_calibration_min", probe_cfg.get("speech_match_min", 0.60)) or 0.60)
        transcription_score = float(runner._score_loopback_probe_transcript(recorded_text, expected_text)) if recorded_text else 0.0
        transcription_accepted = bool(recorded_text) and transcription_score >= min_score
        rms = int(audioop.rms(pcm, 2)) if pcm else 0
        metadata = {
            "reference_wav": str(recorded_wav),
            "input_device_index": int(selected_input_idx),
            "input_device_name": selected_input_name,
            "input_rate": int(selected_input_rate),
            "record_seconds": float(duration_sec),
            "recorded_rms": int(rms),
            "prompt_text": expected_text,
            "transcribed_text": recorded_text,
            "transcription_score": float(transcription_score),
            "transcription_min_score": float(min_score),
            "transcription_accepted": bool(transcription_accepted),
            "requested_input_index": int(record_input_index) if record_input_index is not None else None,
            "requested_input_name": requested_input_name,
            "input_override_applied": bool(requested_input is not None),
        }
        print(f"RECORDED_REFERENCE_WAV={recorded_wav}")
        print(f"RECORDED_REFERENCE_RMS={rms}")
        print(f"RECORDED_REFERENCE_TEXT={recorded_text}")
        print(f"RECORDED_REFERENCE_SCORE={transcription_score:.2f}")
        print(f"RECORDED_REFERENCE_ACCEPTED={int(bool(transcription_accepted))}")
        return recorded_wav, metadata
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        if runner is not None:
            try:
                if getattr(runner, "audio", None) is not None:
                    runner.audio.terminate()
            except Exception:
                pass


def _write_summary(summary: dict[str, Any]) -> Path:
    summary_path = Path(summary["summary_json"])
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary_path


def _build_recording_summary(
    *,
    run_dir: Path,
    expected_text: str,
    expected_text_source: str,
    max_output_candidates: int,
    no_save: bool,
    input_wav_source: str = "",
    reference_probe_wav: str = "",
    recording: dict[str, Any] | None = None,
    error: str = "",
    preflight_only: bool = False,
) -> dict[str, Any]:
    recording_data = dict(recording or {})
    return {
        "run_dir": str(run_dir),
        "summary_json": str(run_dir / "summary.json"),
        "input_wav_source": input_wav_source,
        "reference_probe_wav": reference_probe_wav,
        "probe_expected_text": expected_text,
        "probe_expected_text_source": expected_text_source,
        "max_output_candidates": int(max_output_candidates or 0),
        "no_save": bool(no_save),
        "preflight_only": bool(preflight_only),
        "calibration_state_path": str((ROOT / "logs" / "voice_calibration.json").resolve()),
        "saved": False,
        "saved_state": {},
        "attempts": [],
        "selected_output_name": "",
        "selected_input_name": str(recording_data.get("input_device_name") or ""),
        "recording": recording_data,
        "error": error,
    }


def run_calibration(
    *,
    input_wav: str,
    expected_text: str = "",
    output_dir: str = "",
    max_output_candidates: int = 0,
    no_save: bool = False,
) -> tuple[int, Path, dict[str, Any]]:
    run_dir = Path(output_dir).expanduser().resolve() if output_dir else (ROOT / f"tmp_voice_calibration_{_timestamp()}").resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    reference_wav, input_wav_source = _copy_probe_wav(run_dir, input_wav)
    probe_pcm, probe_sample_rate = _load_probe_pcm(reference_wav)
    resolved_expected_text, expected_text_source = _resolve_expected_text(reference_wav, expected_text)

    old_env = {
        "AVA_HARNESS": os.environ.get("AVA_HARNESS"),
        "AVA_HARNESS_DIR": os.environ.get("AVA_HARNESS_DIR"),
        "VALIDATION_MODE": os.environ.get("VALIDATION_MODE"),
        "DISABLE_AUTONOMY": os.environ.get("DISABLE_AUTONOMY"),
        "AVA_INPUT_WAV": os.environ.get("AVA_INPUT_WAV"),
        "AVA_INPUT_WAV_REALTIME": os.environ.get("AVA_INPUT_WAV_REALTIME"),
    }
    os.environ["AVA_HARNESS"] = "1"
    os.environ["AVA_HARNESS_DIR"] = str(run_dir)
    os.environ["VALIDATION_MODE"] = "1"
    os.environ["DISABLE_AUTONOMY"] = "1"
    os.environ.pop("AVA_INPUT_WAV", None)
    os.environ.pop("AVA_INPUT_WAV_REALTIME", None)

    runner: StandaloneRealtimeAVA | None = None
    selected_state: dict[str, Any] = {}
    attempts: list[dict[str, Any]] = []
    error = ""

    try:
        runner = _make_runner()
        runner._harness_enabled = True
        runner._harness_dir = str(run_dir)
        runner._validation_mode = True
        runner._input_wav_path = ""
        runner._input_wav_realtime = False
        runner._loopback_probe_pcm_cache.clear()

        runner.cfg = dict(runner.cfg)
        aud_cfg = dict(runner.cfg.get("audio") or {})
        probe_cfg = dict(aud_cfg.get("loopback_probe") or {})
        probe_cfg.update(
            {
                "enabled": True,
                "validation_only": True,
                "input_only": True,
                "mode": "speech",
                "speech_text": resolved_expected_text,
                "require_speech_calibration": True,
            }
        )
        aud_cfg["loopback_probe"] = probe_cfg
        runner.cfg["audio"] = aud_cfg

        _install_probe_override(
            runner,
            probe_pcm=probe_pcm,
            probe_sample_rate=probe_sample_rate,
            expected_text=resolved_expected_text,
        )

        pa = runner.audio
        if pa is None:
            raise RuntimeError("PyAudio did not initialize in StandaloneRealtimeAVA")

        captured_states: list[dict[str, Any]] = []
        original_save = runner._save_voice_calibration_state

        def _capture_save(self, state: dict) -> None:
            snapshot = dict(state or {})
            if snapshot:
                captured_states.append(snapshot)
            if not no_save:
                original_save(snapshot)

        runner._save_voice_calibration_state = types.MethodType(_capture_save, runner)

        output_candidates = _enumerate_output_candidates(pa, runner, max_output_candidates)
        if not output_candidates:
            raise RuntimeError("No output devices available for calibration")

        config_rate = int((runner.cfg.get("audio") or {}).get("input_sample_rate") or 44100)
        rates_to_try = [config_rate, 48000, 44100, 16000]

        for order, output_candidate in enumerate(output_candidates, start=1):
            output_idx = int(output_candidate["idx"])
            output_label = str(output_candidate["label"])
            output_rate = int(output_candidate["rate"])

            runner.output_device_index = output_idx
            runner.playback_rate = output_rate
            runner.input_device_index = None
            runner.cfg["audio"]["output_device_name"] = output_label
            runner.cfg["audio"]["playback_rate"] = output_rate

            before = len(captured_states)
            stream = None
            selected_input_label = ""
            selected_input_idx = None
            selected_input_rate = None
            success = False
            attempt_error = ""
            try:
                stream, selected_input_idx, selected_input_rate, _ = runner._open_ranked_input_stream(
                    pa,
                    sample_format=pyaudio.paInt16,
                    channels=1,
                    rates_to_try=rates_to_try,
                    config_rate=config_rate,
                    mode_label="input",
                )
                success = stream is not None
                if selected_input_idx is not None:
                    try:
                        info = pa.get_device_info_by_index(int(selected_input_idx))
                        selected_input_label = _normalize_label(str(info.get("name") or ""))
                    except Exception:
                        selected_input_label = ""
            except Exception as exc:
                attempt_error = f"{type(exc).__name__}: {exc}"
            finally:
                if stream is not None:
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass

            state = dict(captured_states[-1]) if len(captured_states) > before else {}
            attempts.append(
                {
                    "attempt_index": order,
                    "output_device_index": output_idx,
                    "output_device_name": output_label,
                    "output_rate": output_rate,
                    "success": bool(success),
                    "selected_input_index": selected_input_idx,
                    "selected_input_name": selected_input_label,
                    "selected_input_rate": selected_input_rate,
                    "saved_state": state,
                    "error": attempt_error,
                }
            )
            if success:
                selected_state = state
                break
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        if runner is not None:
            try:
                if getattr(runner, "audio", None) is not None:
                    runner.audio.terminate()
            except Exception:
                pass
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    state_path = runner._voice_calibration_state_path() if runner is not None else (ROOT / "logs" / "voice_calibration.json").resolve()
    saved_on_disk: dict[str, Any] = {}
    if state_path.exists():
        try:
            saved_on_disk = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            saved_on_disk = {}

    summary = {
        "run_dir": str(run_dir),
        "summary_json": str(run_dir / "summary.json"),
        "input_wav_source": str(input_wav_source),
        "reference_probe_wav": str(reference_wav),
        "probe_expected_text": resolved_expected_text,
        "probe_expected_text_source": expected_text_source,
        "max_output_candidates": int(max_output_candidates or 0),
        "no_save": bool(no_save),
        "calibration_state_path": str(state_path),
        "saved": bool(selected_state) and not bool(no_save),
        "saved_state": saved_on_disk if saved_on_disk else selected_state,
        "attempts": attempts,
        "selected_output_name": "",
        "selected_input_name": "",
        "error": error,
    }
    if selected_state:
        summary["selected_output_name"] = str(selected_state.get("output_device_name") or "")
        summary["selected_input_name"] = str(selected_state.get("input_device_name") or "")

    summary_path = Path(summary["summary_json"])
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    print(f"RUN_DIR={run_dir}")
    print(f"REFERENCE_WAV={reference_wav}")
    print(f"INPUT_WAV_SOURCE={input_wav_source}")
    print(f"PROBE_EXPECTED_TEXT={resolved_expected_text}")
    print(f"PROBE_EXPECTED_TEXT_SOURCE={expected_text_source}")
    print(f"CALIBRATION_STATE_PATH={state_path}")
    for attempt in attempts:
        print(
            f"CALIBRATION_ATTEMPT={attempt['attempt_index']}\t"
            f"output={attempt['output_device_name']}\t"
            f"success={int(bool(attempt['success']))}\t"
            f"selected_input={attempt['selected_input_name']}\t"
            f"error={attempt['error']}"
        )
    print(f"CALIBRATION_SAVED={int(bool(summary['saved']))}")
    print(f"SELECTED_OUTPUT={summary['selected_output_name']}")
    print(f"SELECTED_INPUT={summary['selected_input_name']}")
    print(f"SUMMARY_JSON={summary_path}")

    exit_code = 0 if selected_state else 1
    return exit_code, run_dir, summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate AVa live mic/output pairs with a prerecorded or recorded wake sample")
    parser.add_argument("--list-input-devices", action="store_true", help="List usable input devices and exit")
    parser.add_argument("--input-wav", default="", help="Path to a prerecorded user wake sample WAV")
    parser.add_argument("--record-sample", action="store_true", help="Record a reference wake sample from a ranked or forced live mic before calibration")
    parser.add_argument(
        "--record-seconds",
        type=float,
        default=3.0,
        help="Duration of the direct mic recording when --record-sample is used",
    )
    parser.add_argument("--record-input-index", type=int, default=None, help="Force a specific input device index when recording a reference sample")
    parser.add_argument("--record-input-name", default="", help="Force a specific input device name substring when recording a reference sample")
    parser.add_argument("--preflight-only", action="store_true", help="Record and score the reference sample, then exit without sweeping outputs")
    parser.add_argument(
        "--expected-text",
        default="",
        help="Expected transcript for the sample; defaults to config speech_text for recording or local Whisper/config for WAV input",
    )
    parser.add_argument("--output-dir", default="", help="Optional directory for calibration artifacts and summary.json")
    parser.add_argument(
        "--max-output-candidates",
        type=int,
        default=0,
        help="Optional cap on output devices to sweep; 0 means all outputs",
    )
    parser.add_argument("--no-save", action="store_true", help="Dry run without writing logs/voice_calibration.json")
    args = parser.parse_args()

    if bool(args.list_input_devices):
        try:
            devices = _list_input_devices()
        except Exception as exc:
            print(f"ERROR={type(exc).__name__}: {exc}")
            return 1
        _print_input_devices(devices)
        if not devices:
            print("ERROR=No usable input devices found")
            return 1
        return 0

    if bool(args.record_sample) and str(args.input_wav or "").strip():
        parser.error("--record-sample cannot be combined with --input-wav")
    if args.record_input_index is not None and _normalize_label(str(args.record_input_name or "")):
        parser.error("--record-input-index cannot be combined with --record-input-name")
    if (args.record_input_index is not None or _normalize_label(str(args.record_input_name or ""))) and not bool(args.record_sample):
        parser.error("--record-input-index and --record-input-name require --record-sample")
    if bool(args.preflight_only) and not bool(args.record_sample):
        parser.error("--preflight-only requires --record-sample")
    if not bool(args.record_sample) and not str(args.input_wav or "").strip():
        parser.error("one of --input-wav or --record-sample is required")

    if bool(args.record_sample):
        run_dir = Path(args.output_dir).expanduser().resolve() if str(args.output_dir or "").strip() else (ROOT / f"tmp_voice_calibration_{_timestamp()}").resolve()
        run_dir.mkdir(parents=True, exist_ok=True)
        record_expected_text = _normalize_label(str(args.expected_text or "")) or _default_probe_text()
        try:
            recorded_wav, recording_meta = _record_reference_sample(
                run_dir=run_dir,
                expected_text=record_expected_text,
                record_seconds=float(args.record_seconds or 3.0),
                record_input_index=args.record_input_index,
                record_input_name=str(args.record_input_name or ""),
            )
        except Exception as exc:
            summary = _build_recording_summary(
                run_dir=run_dir,
                expected_text=record_expected_text,
                expected_text_source="record-default",
                max_output_candidates=int(args.max_output_candidates or 0),
                no_save=bool(args.no_save),
                error=f"{type(exc).__name__}: {exc}",
                preflight_only=bool(args.preflight_only),
            )
            summary_path = _write_summary(summary)
            print(f"SUMMARY_JSON={summary_path}")
            print(f"ERROR={summary['error']}")
            return 1

        if not bool(recording_meta.get("transcription_accepted")):
            summary = _build_recording_summary(
                run_dir=run_dir,
                expected_text=record_expected_text,
                expected_text_source="cli",
                max_output_candidates=int(args.max_output_candidates or 0),
                no_save=bool(args.no_save),
                input_wav_source=str(recorded_wav),
                reference_probe_wav=str(recorded_wav),
                recording=recording_meta,
                error=(
                    "Recorded reference sample did not match expected phrase strongly enough "
                    f"(score={float(recording_meta.get('transcription_score', 0.0)):.2f}, "
                    f"min={float(recording_meta.get('transcription_min_score', 0.0)):.2f})"
                ),
                preflight_only=bool(args.preflight_only),
            )
            summary_path = _write_summary(summary)
            print(f"SUMMARY_JSON={summary_path}")
            print(f"ERROR={summary['error']}")
            return 1

        if bool(args.preflight_only):
            summary = _build_recording_summary(
                run_dir=run_dir,
                expected_text=record_expected_text,
                expected_text_source="cli",
                max_output_candidates=int(args.max_output_candidates or 0),
                no_save=bool(args.no_save),
                input_wav_source=str(recorded_wav),
                reference_probe_wav=str(recorded_wav),
                recording=recording_meta,
                preflight_only=True,
            )
            summary_path = _write_summary(summary)
            print(f"SUMMARY_JSON={summary_path}")
            print(f"RECORDING_INPUT={recording_meta.get('input_device_name', '')}")
            print(f"RECORDING_REFERENCE_WAV={recording_meta.get('reference_wav', '')}")
            print("PREFLIGHT_ONLY=1")
            return 0

        exit_code, _, summary = run_calibration(
            input_wav=str(recorded_wav),
            expected_text=record_expected_text,
            output_dir=str(run_dir),
            max_output_candidates=int(args.max_output_candidates or 0),
            no_save=bool(args.no_save),
        )
        summary["recording"] = recording_meta
        summary["preflight_only"] = False
        summary_path = _write_summary(summary)
        print(f"RECORDING_INPUT={recording_meta.get('input_device_name', '')}")
        print(f"RECORDING_REFERENCE_WAV={recording_meta.get('reference_wav', '')}")
        print(f"SUMMARY_JSON={summary_path}")
        return exit_code

    exit_code, _, summary = run_calibration(
        input_wav=str(args.input_wav or "").strip(),
        expected_text=str(args.expected_text or "").strip(),
        output_dir=str(args.output_dir or "").strip(),
        max_output_candidates=int(args.max_output_candidates or 0),
        no_save=bool(args.no_save),
    )
    summary["preflight_only"] = False
    _write_summary(summary)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
