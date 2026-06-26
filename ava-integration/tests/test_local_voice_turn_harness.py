import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
HARNESS_PATH = ROOT / "tools" / "voice_lab" / "10_local_voice_turn_harness.py"


def load_harness():
    spec = importlib.util.spec_from_file_location("local_voice_turn_harness", HARNESS_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_deterministic_local_voice_turn_harness_passes_acceptance_script():
    harness = load_harness()

    result = harness._run_script(
        harness.default_transcripts(),
        "Blue light scatters more in the atmosphere, so the sky looks blue.",
    )

    assert result.ok
    assert result.server_commands == ["why is the sky blue"]
    assert any(text == "I'm listening." for text in result.spoken)
    assert any(text.startswith("Today is ") for text in result.spoken)
    assert sum(1 for text in result.spoken if text.startswith("It's ") and ":" in text) >= 2


def test_deterministic_local_voice_turn_harness_fails_missing_server_reply():
    harness = load_harness()

    result = harness._run_script(harness.default_transcripts(), "")

    assert not result.ok
    assert "server_reply_spoken" in result.failed_checks
    assert "general_question_routed_to_server" in result.passed_checks
