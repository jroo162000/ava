import importlib.util
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
TOOL_PATH = ROOT / "tools" / "voice_lab" / "16_local_input_wav_acceptance.py"


def load_tool():
    spec = importlib.util.spec_from_file_location("local_input_wav_acceptance", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_score_acceptance_requires_clean_command_and_tts_attempt():
    tool = load_tool()
    process_result = {
        "returncode": 0,
        "runner_summary": {
            "accepted": True,
            "transcript": "Ava, what time is it? Ava, what time is it?",
            "command": "what time is it",
            "reply": "It's 1:05 AM.",
            "tts_attempted": True,
        },
    }

    score = tool.score_acceptance(
        process_result,
        expected_command="what time is it",
        expected_reply_contains="It's",
    )

    assert score["ok"]
    assert not score["failed_checks"]


def test_acceptance_tool_adds_repo_root_for_absolute_script_execution():
    src = TOOL_PATH.read_text(encoding="utf-8")

    assert "if str(ROOT) not in sys.path" in src
    assert "sys.path.insert(0, str(ROOT))" in src
    assert 'DEFAULT_PROMPT = "Hey Able, what time is it? Hey Able, what time is it?"' in src


def test_score_acceptance_fails_when_runner_ignores_wake():
    tool = load_tool()
    process_result = {
        "returncode": 2,
        "runner_summary": {
            "accepted": False,
            "transcript": "Oh, what time is it?",
            "command": "",
            "reply": "",
            "ignored_reason": "no_wake",
            "tts_attempted": False,
        },
    }

    score = tool.score_acceptance(process_result, expected_command="what time is it")

    assert not score["ok"]
    assert "process_exit_zero" in score["failed_checks"]
    assert "runner_accepted" in score["failed_checks"]
    assert "command_matches_expected" in score["failed_checks"]


def test_run_local_voice_process_writes_logs_and_loads_summary(monkeypatch, tmp_path):
    tool = load_tool()
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"RIFFfake")

    def fake_run(cmd, cwd, env, capture_output, text, timeout):
        summary_path = Path(cmd[cmd.index("--summary-json") + 1])
        summary_path.write_text(
            '{"accepted": true, "transcript": "Ava", "command": "what time is it", "reply": "It is 1:05 AM.", "tts_attempted": true}',
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(cmd, 0, stdout='{"accepted": true}\n', stderr="")

    monkeypatch.setattr(tool.subprocess, "run", fake_run)

    result = tool._run_local_voice_process(input_wav, tmp_path, timeout_sec=10.0, playback=False)

    assert result["returncode"] == 0
    assert result["runner_summary"]["accepted"] is True
    assert (tmp_path / "runner_stdout.log").exists()
    assert "--no-playback" in result["cmd"]


def test_run_local_voice_process_can_use_live_loop_mode(monkeypatch, tmp_path):
    tool = load_tool()
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"RIFFfake")

    def fake_run(cmd, cwd, env, capture_output, text, timeout):
        summary_path = Path(cmd[cmd.index("--summary-json") + 1])
        summary_path.write_text(
            '{"mode": "live_input_wav", "accepted": true, "transcript": "Ava", "command": "what time is it", "reply": "It is 1:05 AM.", "tts_attempted": true}',
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(cmd, 0, stdout='{"accepted": true}\n', stderr="")

    monkeypatch.setattr(tool.subprocess, "run", fake_run)

    result = tool._run_local_voice_process(input_wav, tmp_path, timeout_sec=10.0, playback=False, live_loop=True)

    assert "--live-input-wav" in result["cmd"]
    assert "--input-wav" not in result["cmd"]
    assert result["runner_summary"]["mode"] == "live_input_wav"
