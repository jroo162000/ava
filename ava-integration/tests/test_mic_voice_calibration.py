import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
CAL_PATH = ROOT / "tools" / "voice_lab" / "14_mic_voice_calibration.py"


def load_calibration():
    spec = importlib.util.spec_from_file_location("mic_voice_calibration", CAL_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_score_text_rewards_local_time_hint():
    cal = load_calibration()

    assert cal.score_text("time", "ava what time is it") >= 0.7
    assert cal.score_text("background television", "ava what time is it") < 0.3


def test_evaluate_calibration_marks_good_energy_and_asr_viable():
    cal = load_calibration()

    result = cal.evaluate_calibration(
        background={"rms_p95": 500, "rms_peak": 900},
        voice={"rms_p95": 4200, "rms_peak": 7600},
        vosk_text="time",
        whisper_text="",
        command="what time is it",
        expected_text="ava what time is it",
    )

    assert result["viable"]
    assert result["energy_ok"]
    assert result["asr_ok"]
    assert result["verdict"] == "viable"


def test_evaluate_calibration_rejects_voice_that_does_not_beat_background():
    cal = load_calibration()

    result = cal.evaluate_calibration(
        background={"rms_p95": 2400, "rms_peak": 3900},
        voice={"rms_p95": 2700, "rms_peak": 4100},
        vosk_text="time",
        whisper_text="",
        command="what time is it",
        expected_text="ava what time is it",
    )

    assert not result["viable"]
    assert not result["energy_ok"]
    assert result["verdict"] == "bad_energy"


def test_evaluate_calibration_detects_missing_voice_window():
    cal = load_calibration()

    result = cal.evaluate_calibration(
        background={"rms_p95": 1521, "rms_peak": 2889},
        voice={"rms_p95": 814, "rms_peak": 1440},
        vosk_text="",
        whisper_text="",
        command="",
        expected_text="ava what time is it",
    )

    assert not result["viable"]
    assert result["verdict"] == "no_voice_detected"
    assert result["no_voice_detected"]
    assert result["voice_weaker_than_background"]


def test_evaluate_calibration_rejects_unrecognized_asr_despite_energy():
    cal = load_calibration()

    result = cal.evaluate_calibration(
        background={"rms_p95": 300, "rms_peak": 500},
        voice={"rms_p95": 5000, "rms_peak": 9000},
        vosk_text="random background words",
        whisper_text="never testified to the court",
        command="",
        expected_text="ava what time is it",
    )

    assert not result["viable"]
    assert result["energy_ok"]
    assert not result["asr_ok"]
    assert result["verdict"] == "bad_asr"


def test_evaluate_calibration_detects_short_voice_window():
    cal = load_calibration()

    result = cal.evaluate_calibration(
        background={"rms_p95": 856, "rms_peak": 960},
        voice={
            "rms_p95": 1791,
            "rms_peak": 3237,
            "max_consecutive_stop_ms": 300,
            "first_above_stop_ms": 3500,
            "last_above_stop_ms": 4300,
        },
        vosk_text="",
        whisper_text="",
        command="",
        expected_text="ava what time is it",
    )

    assert not result["viable"]
    assert result["verdict"] == "short_voice_window"
    assert result["short_voice_window"]
    assert result["sustained_voice_ms"] == 300


def test_mic_calibration_cli_exposes_audible_cues():
    src = CAL_PATH.read_text(encoding="utf-8")

    assert "--audible-cues" in src
    assert "winsound.Beep" in src
    assert 'phase == "voice"' in src
    assert 'parser.add_argument("--voice-sec", type=float, default=8.0)' in src
    assert "apply_configured_live_input(args)" in src
    assert 'parser.add_argument("--device", type=int, default=None' in src
    assert 'parser.add_argument("--rate", type=int, default=None' in src


def test_dashboard_mic_calibration_uses_extended_voice_window():
    src = (ROOT / "ava_realtime_ui.py").read_text(encoding="utf-8")

    assert 'voice_sec = _num("voice_sec", 8.0, 2.0, 10.0)' in src
    assert "voice_sec: 8" in src
    assert "repeat \"Ava, what time is it?\" clearly until the 8-second capture ends" in src
