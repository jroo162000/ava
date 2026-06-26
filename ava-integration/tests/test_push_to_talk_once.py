import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
PTT_PATH = ROOT / "tools" / "voice_lab" / "13_push_to_talk_once.py"


def load_ptt():
    spec = importlib.util.spec_from_file_location("push_to_talk_once", PTT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_resolve_command_prefers_vosk_local_time_hint_over_whisper_hallucination():
    ptt = load_ptt()

    command, source = ptt.resolve_command(
        "time",
        "I'm going to tell you this one. I'm going to tell you this.",
        {"speech_like": True},
    )

    assert command == "what time is it"
    assert source == "vosk_local_hint"


def test_resolve_command_uses_whisper_when_vosk_has_no_hint():
    ptt = load_ptt()

    command, source = ptt.resolve_command(
        "",
        "Ava who are you",
        {"speech_like": True},
    )

    assert command == "who are you"
    assert source == "whisper"


def test_resolve_command_rejects_non_speech_vosk_hint():
    ptt = load_ptt()

    command, source = ptt.resolve_command(
        "time",
        "",
        {"speech_like": False},
    )

    assert command == ""
    assert source == "none"


def test_push_to_talk_cli_exposes_start_delay_and_prompt():
    src = PTT_PATH.read_text(encoding="utf-8")

    assert "--start-delay" in src
    assert "--prompt" in src
    assert "Recording starts in" in src
    assert "apply_configured_live_input(args)" in src
    assert 'parser.add_argument("--device", type=int, default=None' in src
    assert 'parser.add_argument("--rate", type=int, default=None' in src
    assert "default=14" not in src
    assert "default=48000" not in src
