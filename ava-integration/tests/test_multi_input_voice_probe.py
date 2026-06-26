import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
PROBE_PATH = ROOT / "tools" / "voice_lab" / "15_multi_input_voice_probe.py"


def load_probe():
    spec = importlib.util.spec_from_file_location("multi_input_voice_probe", PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_webcam_style_device_names_are_blocked_by_default():
    probe = load_probe()

    assert probe._is_blocked_input_name("Microphone (Logi Webcam C920e)")
    assert probe._is_blocked_input_name("HD Camera Microphone")
    assert probe._is_blocked_input_name("Logitech BRIO")
    assert not probe._is_blocked_input_name("Microphone (Realtek High Definition Audio)")


def test_candidate_rates_preserve_default_and_remove_duplicates():
    probe = load_probe()

    assert probe._candidate_rates(48000.0, [48000, 44100, 16000]) == [48000, 44100, 16000]
    assert probe._candidate_rates(44100.0, [48000, 44100, 16000]) == [44100, 48000, 16000]


def test_text_score_rewards_expected_command_overlap():
    probe = load_probe()

    assert probe._text_score("Ava, what time is it?", "ava what time is it") == 1.0
    assert probe._text_score("bye bye", "ava what time is it") == 0.0
    assert probe._text_score("what time", "ava what time is it") >= 0.4


def test_score_result_prefers_transcribed_command_over_loud_noise():
    probe = load_probe()
    quiet_command = {
        "ok": True,
        "device": 14,
        "metrics": {"rms_p95": 1200, "rms_peak": 3000, "max_consecutive_stop_ms": 600, "above_start_frames": 0},
        "vosk": {"text": "ava what time is it"},
        "whisper": {"text": ""},
    }
    loud_noise = {
        "ok": True,
        "device": 8,
        "metrics": {"rms_p95": 7000, "rms_peak": 18000, "max_consecutive_stop_ms": 2200, "above_start_frames": 20},
        "vosk": {"text": ""},
        "whisper": {"text": "bye bye"},
    }

    scored_command = probe.score_result(quiet_command, "ava what time is it")
    scored_noise = probe.score_result(loud_noise, "ava what time is it")

    assert scored_command["viable"]
    assert not scored_noise["viable"]
    assert scored_command["score"] > scored_noise["score"]


def test_probe_defaults_keep_candidate_count_parallel_safe():
    src = PROBE_PATH.read_text(encoding="utf-8")

    assert 'parser.add_argument("--max-candidates", type=int, default=8)' in src
    assert "active_candidates = candidates[:max_workers]" in src
    assert '"skipped_candidates": skipped_candidates' in src


def test_probe_uses_child_processes_to_isolate_audio_driver_crashes():
    src = PROBE_PATH.read_text(encoding="utf-8")

    assert "--child-record" in src
    assert "subprocess.Popen" in src
    assert "run_child_record(args)" in src
    assert "returncode" in src


def test_probe_can_drive_speaker_to_mic_capture():
    src = PROBE_PATH.read_text(encoding="utf-8")

    assert "--speaker-text" in src
    assert "speaker_probe_" in src
    assert "_synthesize_piper_wav" in src
    assert "_play_wav(" in src
    assert '"speaker_probe": speaker_probe' in src
    assert "--speaker-gain" in src
    assert "_gain_pcm16" in src
