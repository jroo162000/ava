import importlib.util
import json
import subprocess
import sys
import types
import wave
from pathlib import Path


ROOT = Path(__file__).parent.parent
UI_PATH = ROOT / "ava_realtime_ui.py"


def load_ui():
    spec = importlib.util.spec_from_file_location("ava_realtime_ui_for_checks", UI_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_local_checks_report_deterministic_voice_pipeline(monkeypatch):
    ui = load_ui()

    class FakePyAudio:
        def get_device_count(self):
            return 2

        def get_device_info_by_index(self, idx):
            if idx == 0:
                return {"maxInputChannels": 1, "maxOutputChannels": 0}
            return {"maxInputChannels": 0, "maxOutputChannels": 2}

        def terminate(self):
            pass

    monkeypatch.setitem(sys.modules, "pyaudio", types.SimpleNamespace(PyAudio=FakePyAudio))
    monkeypatch.setattr(ui.BRAIN, "status", lambda _config: {"up": True, "url": "http://127.0.0.1:5051/respond", "error": ""})

    def fake_run(cmd, cwd, capture_output, text, timeout):
        if str(ui.LOCAL_INPUT_ACCEPTANCE_RUNNER) in [str(part) for part in cmd]:
            out_dir = Path(cmd[cmd.index("--output-dir") + 1])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "ok": True,
                        "process": {
                            "runner_summary": {
                                "accepted": True,
                                "command": "what time is it",
                                "reply": "It's 1:21 AM.",
                            }
                        },
                        "score": {"failed_checks": []},
                    }
                ),
                encoding="utf-8",
            )
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui.LocalChecks().run()
    check = next(item for item in result["checks"] if item["name"] == "Deterministic local voice pipeline")
    names = {item["name"] for item in result["checks"]}

    assert "Local voice runner exists" in names
    assert "Legacy realtime runner exists" in names
    assert check["state"] == "ok"
    assert "accepted=True" in check["detail"]
    assert "what time is it" in check["detail"]
    assert "16_local_input_wav_acceptance.py" in check["command"]
    assert "live_input_defaults.py" in check["command"] or any(
        item["name"] == "Python compile" and "live_input_defaults.py" in item.get("command", "")
        for item in result["checks"]
    )


def test_local_checks_warn_when_active_selected_mic_is_not_hearing_speech(monkeypatch, tmp_path):
    ui = load_ui()
    log_path = tmp_path / "stdout.log"
    log_path.write_text(
        "\n".join(
            [
                "[local-voice] input=Microphone idx=2",
                "[local-voice] loading_whisper=tiny.en",
                "[local-voice] tts=piper",
                "[local-voice] ready",
                "[local-voice] state=LISTENING",
                "[local-voice] mic_idle frames=334 rms=99 peak=440 vad_start=5000",
            ]
        ),
        encoding="utf-8",
    )

    class FakePyAudio:
        def get_device_count(self):
            return 2

        def get_device_info_by_index(self, idx):
            if idx == 0:
                return {"maxInputChannels": 1, "maxOutputChannels": 0}
            return {"maxInputChannels": 0, "maxOutputChannels": 2}

        def terminate(self):
            pass

    class FakeController:
        def status(self):
            return {"running": True, "stdout_path": str(log_path)}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        if str(ui.LOCAL_INPUT_ACCEPTANCE_RUNNER) in [str(part) for part in cmd]:
            out_dir = Path(cmd[cmd.index("--output-dir") + 1])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "ok": True,
                        "process": {
                            "runner_summary": {
                                "accepted": True,
                                "command": "what time is it",
                                "reply": "It's 1:21 AM.",
                            }
                        },
                        "score": {"failed_checks": []},
                    }
                ),
                encoding="utf-8",
            )
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setitem(sys.modules, "pyaudio", types.SimpleNamespace(PyAudio=FakePyAudio))
    monkeypatch.setattr(ui.BRAIN, "status", lambda _config: {"up": True, "url": "http://127.0.0.1:5051/respond", "error": ""})
    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui.LocalChecks().run()
    check = next(item for item in result["checks"] if item["name"] == "Live selected mic health")

    assert result["state"] == "warn"
    assert check["state"] == "warn"
    assert "not hearing usable speech" in check["detail"]


def test_diagnostics_promotes_no_vad_acceptance_warning():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": [
                "No VAD speech_start events were observed on the selected input (max idle peak 4585 vs vad_start 5000)"
            ],
        }
    )

    assert issues == [
        {
            "level": "warn",
            "title": "No live speech crossed VAD",
            "detail": "No VAD speech_start events were observed on the selected input (max idle peak 4585 vs vad_start 5000)",
            "source": "live acceptance analyzer",
        }
    ]


def test_diagnostics_promotes_vad_to_asr_failure_warning():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": [
                "VAD captured speech-like audio 1 time(s), but nothing reached an accepted Whisper final"
            ],
        }
    )

    assert issues[0]["title"] == "VAD captured audio but ASR did not accept it"


def test_diagnostics_promotes_no_wake_no_reply_failure():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": ["Ignored no-wake transcripts: 4"],
            "spoken_count": 0,
            "final_count": 4,
            "ignored_no_wake": 4,
            "ignored_wake_gate_no_wake": 14,
        }
    )

    assert issues[0]["title"] == "No wake-qualified command reached AVA"
    assert "Ignored no-wake transcripts: 4" in issues[0]["detail"]


def test_diagnostics_promotes_no_wake_counts_without_warning_text():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": [],
            "spoken_count": 0,
            "final_count": 3,
            "ignored_no_wake": 2,
            "ignored_wake_gate_no_wake": 1,
        }
    )

    assert issues == [
        {
            "level": "warn",
            "title": "No wake-qualified command reached AVA",
            "detail": "Captured 3 Whisper final transcript(s), ignored_no_wake=2, wake_gate_blocks=1, spoken_replies=0.",
            "source": "live acceptance analyzer",
        }
    ]


def test_diagnostics_surfaces_failed_turn_debug_wavs():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())
    wav_path = r"C:\Users\USER 1\ava\ava-integration\logs\session\local_123_wake_gate_block_44100hz.wav"

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": ["Failed-turn debug WAV artifacts saved: 1"],
            "spoken_count": 0,
            "final_count": 0,
            "ignored_no_wake": 0,
            "ignored_wake_gate_no_wake": 1,
            "debug_wavs": [
                {
                    "reason": "wake_gate_block",
                    "path": wav_path,
                    "line": "9",
                    "metrics": {"exists": True, "seconds": 1.59, "rms": 3057, "peak": 23095},
                }
            ],
        }
    )

    artifact_issue = next(item for item in issues if item["title"] == "Failed-turn WAV artifacts available")
    assert artifact_issue["level"] == "info"
    assert "wake_gate_block" in artifact_issue["detail"]
    assert wav_path in artifact_issue["detail"]
    assert "rms=3057" in artifact_issue["detail"]
    assert "peak=23095" in artifact_issue["detail"]


def test_diagnostics_surfaces_capture_quality_recommendation():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    issues = diagnostics._acceptance_runtime_issues(
        {
            "available": True,
            "ok": False,
            "warnings": [],
            "spoken_count": 0,
            "final_count": 0,
            "ignored_no_wake": 0,
            "ignored_wake_gate_no_wake": 0,
            "capture_quality": {
                "state": "brief_peaks",
                "title": "Mic is hearing transient spikes, not sustained speech",
                "detail": "Only brief mic peaks crossed VAD threshold.",
                "recommendation": "Move closer or switch to a better mic.",
            },
        }
    )

    assert issues == [
        {
            "level": "warn",
            "title": "Mic is hearing transient spikes, not sustained speech",
            "detail": "Only brief mic peaks crossed VAD threshold.\nRecommendation: Move closer or switch to a better mic.",
            "source": "capture quality verdict",
        }
    ]


def test_cards_warn_when_selected_mic_is_not_hearing_speech():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())

    cards = diagnostics._cards(
        {"running": True, "runner_mode": "local", "runner_name": "ava_local_voice.py", "pid": 123},
        {
            "server_up": False,
            "tts": "piper",
            "input": "Microphone idx=2",
            "output": "default",
            "asr_vosk": True,
            "asr_whisper": True,
            "wake_gate": "vosk",
            "mic_loop": True,
            "session_active": True,
            "last_final": None,
            "last_tts": None,
        },
        {"up": True, "url": "http://127.0.0.1:5051/health", "pid": None},
        {"running": False},
        {
            "available": True,
            "ready": True,
            "listening_seen": True,
            "tts": "piper",
            "asr": "tiny.en",
            "ok": False,
            "warnings": ["No VAD speech_start events were observed on the selected input"],
            "capture_quality": {
                "state": "no_speech",
                "title": "Selected mic is not hearing usable speech",
            },
        },
    )

    voice_card = next(item for item in cards if item["name"] == "Voice session")

    assert voice_card["state"] == "warn"
    assert "not hearing usable speech" in voice_card["detail"]


def test_diagnostics_merges_acceptance_status_for_long_log_tails():
    ui = load_ui()
    diagnostics = ui.Diagnostics(controller=object())
    parsed = {
        "server_up": False,
        "tts": None,
        "input": None,
        "output": None,
        "asr_vosk": False,
        "asr_whisper": False,
        "wake_gate": None,
        "mic_loop": False,
        "session_active": False,
        "last_final": None,
        "last_tts": None,
    }

    merged = diagnostics._merge_acceptance_into_parsed(
        parsed,
        {
            "available": True,
            "ready": True,
            "listening_seen": True,
            "input": "Microphone idx=2",
            "tts": "piper",
            "asr": "tiny.en",
            "final_transcripts": ["Thank you very much."],
        },
    )
    issues = diagnostics._runtime_state_issues(
        {"running": True, "elapsed_seconds": 15040},
        ["[local-voice] mic_idle frames=334 rms=15 peak=21 vad_start=5000"],
        merged,
    )

    assert merged["mic_loop"] is True
    assert merged["session_active"] is True
    assert merged["input"] == "Microphone idx=2"
    assert merged["tts"] == "piper"
    assert merged["asr_whisper"] is True
    assert merged["last_final"] == "Thank you very much."
    assert issues == []


def test_debug_wav_metric_enrichment_reads_pcm16_wav(tmp_path):
    ui = load_ui()
    wav_path = tmp_path / "failed.wav"
    pcm = b"".join(int(v).to_bytes(2, "little", signed=True) for v in (1000, -1000, 2000, -2000))
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(4)
        wf.writeframes(pcm)

    result = ui._enrich_debug_wavs([{"reason": "wake_gate_block", "path": str(wav_path), "line": "12"}])

    assert result[0]["metrics"]["exists"] is True
    assert result[0]["metrics"]["seconds"] == 1.0
    assert result[0]["metrics"]["rms"] == 1581
    assert result[0]["metrics"]["peak"] == 2000


def test_failed_turn_wav_analyzer_replays_recent_artifacts(monkeypatch, tmp_path):
    ui = load_ui()
    monkeypatch.setattr(ui, "LOG_ROOT", tmp_path / "logs")
    wav_path = tmp_path / "empty_whisper.wav"
    pcm = b"".join(int(v).to_bytes(2, "little", signed=True) for v in (900, -900, 1400, -1400) * 800)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm)
    log_path = tmp_path / "stdout.log"
    log_path.write_text(
        f"[local-voice] debug_wav reason={'empty_whisper'!r} path={str(wav_path)!r}\n",
        encoding="utf-8",
    )

    class FakeController:
        def status(self):
            return {"running": True, "stdout_path": str(log_path)}

    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        captured["cmd"] = [str(part) for part in cmd]
        captured["timeout"] = timeout
        return subprocess.CompletedProcess(
            cmd,
            2,
            stdout=json.dumps(
                {
                    "ok": False,
                    "process": {
                        "runner_summary": {
                            "transcript": "",
                            "accepted": False,
                            "command": "",
                            "reply": "",
                            "ignored_reason": "empty_transcript",
                        }
                    },
                    "score": {"failed_checks": ["transcript_present"]},
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._analyze_failed_turn_wavs({"limit": 1, "timeout": 25})

    assert result["ok"] is False
    assert result["state"] == "empty_artifacts"
    assert result["results"][0]["intelligibility"] == "empty_or_unintelligible"
    assert result["results"][0]["ignored_reason"] == "empty_transcript"
    assert captured["cmd"][captured["cmd"].index("--input-wav") + 1] == str(wav_path)
    assert captured["timeout"] == 55.0


def test_input_failover_probe_applies_viable_non_webcam_candidate(monkeypatch, tmp_path):
    ui = load_ui()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps(
            {
                "audio": {
                    "input_device": 2,
                    "input_sample_rate": 44100,
                    "input_device_name": "Realtek",
                    "input_device_blocklist": ["webcam", "c920e"],
                    "input_device_avoid": ["microsoft sound mapper"],
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(ui, "CONFIG_PATH", config_path)
    monkeypatch.setattr(ui, "LOG_ROOT", tmp_path / "logs")

    class FakeController:
        def status(self):
            return {"running": False, "runner_mode": "local"}

        def start(self, payload):
            return {"ok": True, "payload": payload, "status": self.status()}

    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        captured["cmd"] = [str(part) for part in cmd]
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "best": {
                        "viable": True,
                        "device": 14,
                        "name": "USB Headset Microphone",
                        "host_api_name": "WASAPI",
                        "rate": 48000,
                        "metrics": {"speech_like": True, "rms_peak": 6200, "rms_p95": 2800},
                        "whisper": {"text": "hey ava what time is it"},
                        "vosk": {"text": "hey ava what time is it"},
                    },
                    "candidates": [],
                    "blocked": [],
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._input_failover_probe({"duration": 3, "start_delay": 0, "apply": True, "restart": False})
    updated = json.loads(config_path.read_text(encoding="utf-8"))

    assert result["ok"] is True
    assert result["state"] == "applied"
    assert result["applied"] is True
    assert "--allow-webcam" not in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--max-candidates") + 1] == "8"
    assert updated["audio"]["input_device"] == 14
    assert updated["audio"]["input_sample_rate"] == 48000
    assert updated["audio"]["input_device_name"] == "USB Headset Microphone"
    assert updated["audio"]["input_backend"] == "wasapi"
    assert "webcam" in updated["audio"]["input_device_blocklist"]
    assert "c920e" in updated["audio"]["input_device_avoid"]
    assert result["persisted"]["backup_path"]


def test_input_failover_probe_refuses_blocked_webcam_candidate(monkeypatch, tmp_path):
    ui = load_ui()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(json.dumps({"audio": {"input_device": 2, "input_sample_rate": 44100}}), encoding="utf-8")
    monkeypatch.setattr(ui, "CONFIG_PATH", config_path)
    monkeypatch.setattr(ui, "LOG_ROOT", tmp_path / "logs")

    class FakeController:
        def status(self):
            return {"running": False, "runner_mode": "local"}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "best": {
                        "viable": True,
                        "device": 1,
                        "name": "Microphone (Logi Webcam C920e)",
                        "host_api_name": "MME",
                        "rate": 48000,
                        "metrics": {"speech_like": True},
                    },
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._input_failover_probe({"duration": 3, "start_delay": 0, "apply": True, "restart": False})
    updated = json.loads(config_path.read_text(encoding="utf-8"))

    assert result["ok"] is False
    assert result["state"] == "blocked_candidate"
    assert result["block_reason"] in {"webcam", "c920e"}
    assert result["applied"] is False
    assert updated["audio"]["input_device"] == 2


def test_push_to_talk_defaults_to_configured_live_input(monkeypatch, tmp_path):
    ui = load_ui()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps({"audio": {"input_device": 2, "input_sample_rate": 44100, "input_device_name": "Realtek"}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(ui, "CONFIG_PATH", config_path)

    class FakeController:
        def status(self):
            return {"running": False, "runner_mode": "local"}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        captured["cmd"] = [str(part) for part in cmd]
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps({"ok": True, "reply": "It's 10:21 AM.", "command": "what time is it"}),
            stderr="",
        )

    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._push_to_talk_once({"duration": 1, "start_delay": 0, "no_speak": True})

    assert result["ok"] is True
    assert captured["cmd"][captured["cmd"].index("--device") + 1] == "2"
    assert captured["cmd"][captured["cmd"].index("--rate") + 1] == "44100"
    assert captured["cmd"][captured["cmd"].index("--start-delay") + 1] == "0"
    assert result["input_defaults"]["source"] == "ava_voice_config.json"


def test_mic_calibration_defaults_to_configured_live_input(monkeypatch, tmp_path):
    ui = load_ui()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps({"audio": {"input_device": 2, "input_sample_rate": 44100, "input_device_name": "Realtek"}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(ui, "CONFIG_PATH", config_path)

    class FakeController:
        def status(self):
            return {"running": False, "runner_mode": "local"}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        captured["cmd"] = [str(part) for part in cmd]
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "evaluation": {"recommendation": "viable"},
                    "device": 2,
                    "rate": 44100,
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._mic_calibration_once(
        {
            "background_sec": 1,
            "voice_sec": 2,
            "start_delay": 0,
            "between_delay": 0,
            "audible_cues": False,
        }
    )

    assert result["ok"] is True
    assert captured["cmd"][captured["cmd"].index("--device") + 1] == "2"
    assert captured["cmd"][captured["cmd"].index("--rate") + 1] == "44100"
    assert result["input_defaults"]["device_name"] == "Realtek"


def test_live_acceptance_window_marks_current_log_offset(monkeypatch, tmp_path):
    ui = load_ui()
    log_path = tmp_path / "stdout.log"
    log_path.write_text("[local-voice] ready\n", encoding="utf-8")

    class FakeController:
        def status(self):
            return {"running": True, "stdout_path": str(log_path)}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())

    result = ui._live_acceptance_window({})

    assert result["ok"] is True
    assert result["state"] == "marked"
    assert result["marker"]["offset"] == log_path.stat().st_size
    assert result["marker"]["path"] == str(log_path)


def test_live_acceptance_window_reports_spoken_reply(monkeypatch, tmp_path):
    ui = load_ui()
    log_path = tmp_path / "stdout.log"
    prefix = "[local-voice] ready\n[local-voice] state=LISTENING\n"
    offset = len(prefix.encode("utf-8"))
    log_path.write_text(
        prefix
        + "[local-voice] state=LISTENING speech_start rms=6200\n"
        + "[local-voice] asr_final='Hey Ava what time is it'\n"
        + "[local-voice] state=SPEAKING text=\"It's 10:21 AM.\"\n"
        + "[local-voice] state=COOLDOWN\n",
        encoding="utf-8",
    )

    class FakeController:
        def status(self):
            return {"running": True, "stdout_path": str(log_path)}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())

    result = ui._live_acceptance_window({"offset": offset})

    assert result["ok"] is True
    assert result["state"] == "pass"
    assert result["analysis"]["spoken_count"] == 1
    assert "10:21 AM" in result["message"]


def test_live_acceptance_window_reports_no_wake(monkeypatch, tmp_path):
    ui = load_ui()
    log_path = tmp_path / "stdout.log"
    prefix = "[local-voice] ready\n"
    offset = len(prefix.encode("utf-8"))
    log_path.write_text(
        prefix
        + "[local-voice] state=LISTENING speech_start rms=6200\n"
        + "[local-voice] ignored_wake_gate_no_wake='background words' streak=1\n",
        encoding="utf-8",
    )

    class FakeController:
        def status(self):
            return {"running": True, "stdout_path": str(log_path)}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())

    result = ui._live_acceptance_window({"offset": offset})

    assert result["ok"] is False
    assert result["state"] == "no_wake"
    assert "wake-qualified" in result["message"]
    assert result["analysis"]["ignored_wake_gate_no_wake"] == 1


def test_dashboard_exposes_live_window_and_speaker_mic_controls():
    ui = load_ui()

    assert "liveWindowMarkBtn" in ui.HTML
    assert "liveWindowAnalyzeBtn" in ui.HTML
    assert "directLocalBtn" in ui.HTML
    assert "failedWavsBtn" in ui.HTML
    assert "inputFailoverBtn" in ui.HTML
    assert "applyInputFailoverBtn" in ui.HTML
    assert "speakerMicBtn" in ui.HTML
    assert "/api/live-acceptance-window" in ui.HTML
    assert "/api/direct-local-voice-selftest" in ui.HTML
    assert "/api/analyze-failed-turn-wavs" in ui.HTML
    assert "/api/input-failover-probe" in ui.HTML
    assert "/api/speaker-to-mic-selftest" in ui.HTML


def test_direct_local_voice_selftest_runs_clean_acceptance_gate(monkeypatch, tmp_path):
    ui = load_ui()
    monkeypatch.setattr(ui, "LOG_ROOT", tmp_path / "logs")
    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        parts = [str(part) for part in cmd]
        captured["cmd"] = parts
        captured["timeout"] = timeout
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "run_dir": str(tmp_path / "logs" / "direct"),
                    "process": {
                        "runner_summary": {
                            "transcript": "Hey Able, what time is it?",
                            "accepted": True,
                            "command": "what time is it",
                            "reply": "It's 2:31 AM.",
                            "tts_attempted": True,
                        }
                    },
                    "score": {"failed_checks": []},
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._direct_local_voice_selftest({"timeout": 33})

    assert result["ok"] is True
    assert result["state"] == "pass"
    assert "local capture loop" in result["recommendation"]
    assert "--live-loop" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--expected-command") + 1] == "what time is it"
    assert captured["cmd"][captured["cmd"].index("--expected-reply-contains") + 1] == "It's"
    assert "--playback" not in captured["cmd"]
    assert captured["timeout"] == 68.0
    assert result["runner_summary"]["reply"] == "It's 2:31 AM."


def test_speaker_to_mic_selftest_uses_configured_input_and_labels_acoustic_failure(monkeypatch, tmp_path):
    ui = load_ui()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps(
            {
                "audio": {
                    "input_device": 2,
                    "input_sample_rate": 44100,
                    "input_device_name": "Realtek",
                    "playback_rate": 44100,
                }
            }
        ),
        encoding="utf-8",
    )
    capture_wav = tmp_path / "capture.wav"
    capture_wav.write_bytes(b"RIFF")
    monkeypatch.setattr(ui, "CONFIG_PATH", config_path)
    monkeypatch.setattr(ui, "LOG_ROOT", tmp_path / "logs")

    class FakeController:
        def status(self):
            return {"running": False, "runner_mode": "local"}

    monkeypatch.setattr(ui, "CONTROLLER", FakeController())
    captured = {}

    def fake_run(cmd, cwd, capture_output, text, timeout):
        parts = [str(part) for part in cmd]
        if str(ui.SPEAKER_MIC_PROBE_RUNNER) in parts:
            captured["probe_cmd"] = parts
            return subprocess.CompletedProcess(
                cmd,
                1,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "best": {
                            "viable": False,
                            "wav_path": str(capture_wav),
                            "metrics": {
                                "rms_peak": 2764,
                                "rms_p95": 799,
                                "above_start_frames": 0,
                                "speech_like": False,
                            },
                            "whisper": {"text": "Oh."},
                            "vosk": {"text": "oh"},
                        },
                    }
                ),
                stderr="",
            )
        if str(ui.LOCAL_INPUT_ACCEPTANCE_RUNNER) in parts:
            captured["acceptance_cmd"] = parts
            return subprocess.CompletedProcess(
                cmd,
                2,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "process": {
                            "runner_summary": {
                                "transcript": "",
                                "accepted": False,
                                "ignored_reason": "empty_transcript",
                            }
                        },
                    }
                ),
                stderr="",
            )
        raise AssertionError(f"unexpected command: {parts}")

    monkeypatch.setattr(ui.subprocess, "run", fake_run)

    result = ui._speaker_to_mic_selftest({"duration": 3, "start_delay": 0, "speaker_gain": 3})

    assert result["ok"] is False
    assert result["state"] == "acoustic_pickup_failed"
    assert "Do not lower VAD" in result["recommendation"]
    assert captured["probe_cmd"][captured["probe_cmd"].index("--devices") + 1] == "2"
    assert captured["probe_cmd"][captured["probe_cmd"].index("--rates") + 1] == "44100"
    assert captured["probe_cmd"][captured["probe_cmd"].index("--speaker-gain") + 1] == "3"
    assert captured["acceptance_cmd"][captured["acceptance_cmd"].index("--input-wav") + 1] == str(capture_wav)
    assert result["acceptance"]["process"]["runner_summary"]["ignored_reason"] == "empty_transcript"
