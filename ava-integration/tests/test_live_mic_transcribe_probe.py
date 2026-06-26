import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
PROBE_PATH = ROOT / "tools" / "voice_lab" / "12_live_mic_transcribe_probe.py"


def load_probe():
    spec = importlib.util.spec_from_file_location("live_mic_transcribe_probe", PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_rms_metrics_detects_confirmed_speech_like_frames():
    probe = load_probe()
    pcm = b"".join(
        [
            probe._pcm_level(100, samples=480),
            probe._pcm_level(7200, samples=480),
            probe._pcm_level(7600, samples=480),
            probe._pcm_level(7800, samples=480),
            probe._pcm_level(200, samples=480),
        ]
    )

    metrics = probe._rms_metrics(
        pcm,
        rate=16000,
        frame_ms=30,
        vad_start=6500,
        vad_stop=2500,
        confirm_frames=3,
    )

    assert metrics["speech_like"]
    assert metrics["above_start_frames"] == 3
    assert metrics["max_consecutive_start_ms"] == 90
    assert metrics["max_consecutive_stop_ms"] == 90
    assert metrics["first_above_stop_ms"] == 30
    assert metrics["last_above_stop_ms"] == 90
    assert metrics["rms_peak"] == 7800


def test_rms_metrics_rejects_short_spike():
    probe = load_probe()
    pcm = b"".join(
        [
            probe._pcm_level(100, samples=480),
            probe._pcm_level(7600, samples=480),
            probe._pcm_level(200, samples=480),
        ]
    )

    metrics = probe._rms_metrics(
        pcm,
        rate=16000,
        frame_ms=30,
        vad_start=6500,
        vad_stop=2500,
        confirm_frames=3,
    )

    assert not metrics["speech_like"]
    assert metrics["above_start_frames"] == 1


def test_transcribe_probe_cli_defaults_to_configured_live_input():
    src = PROBE_PATH.read_text(encoding="utf-8")

    assert "apply_configured_live_input(args)" in src
    assert 'parser.add_argument("--device", type=int, default=None' in src
    assert 'parser.add_argument("--rate", type=int, default=None' in src
    assert "required=True" not in src
