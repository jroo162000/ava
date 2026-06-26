from pathlib import Path
import wave
import audioop

import ava_local_voice


def test_minimal_runner_is_parallel_to_monolith_and_half_duplex():
    runner_path = Path(__file__).parent.parent / "ava_local_voice.py"
    src = runner_path.read_text(encoding="utf-8")

    assert runner_path.exists()
    assert "from ava_standalone_realtime" not in src
    assert "LocalHybridProvider" not in src
    assert "HybridASREngine" not in src
    assert "WhisperModel" in src
    assert "PiperBinTTS" in src
    assert "LISTENING -> FINALIZING -> RESPONDING -> SPEAKING -> COOLDOWN -> LISTENING" in src
    assert "self.tts.speak(text, on_chunk, frame_ms=100)" in src
    assert "ignored_no_wake" in src
    assert "_local_fact_reply" in src
    assert 'default_blocklist = ["webcam", "c920e"]' in src
    assert "configured_input_blocked" in src
    assert "candidate_hot_rejected" in src
    assert "host_api_name" in src
    assert '"wasapi" in host_low' in src
    assert "penalty -= 200" in src
    assert "AVA_LOCAL_INPUT_HOT_RMS" in src
    assert "SOFT_WAKE_PHRASES" in src
    assert '"aba"' in src
    assert '"able"' in src
    assert "followup_until" in src
    assert "followup_open_sec" in src
    assert "ignored_followup_low_confidence" in src
    assert "_is_conversational_command" in src
    assert "if _is_conversational_command(text):" in src
    assert '"tell", "answer", "explain", "describe"' not in src
    assert "max(10.0" in src
    assert "AVA_LOCAL_VAD_START_CONFIRM_FRAMES" in src
    assert '"local_start_confirm_frames", 2' in src
    assert "CapturedUtterance" in src
    assert "ignored_vad_low_confidence" in src
    assert "ignored_vad_flat_capture" in src
    assert "ignored_asr_filler" in src
    assert "wake_gate=vosk" in src
    assert "AVA_LOCAL_WAKE_GATE_AFTER" in src
    assert 'os.getenv("AVA_LOCAL_WAKE_GATE_AFTER", "0")' in src
    assert "ignored_wake_gate_no_wake" in src
    assert "wake_gate_short_bypass" in src
    assert "_wake_gate_partial_wake_hint" in src
    assert "_wake_gate_query_hint" in src
    assert "wake_gate_query_bypass" in src
    assert "wake_gate_whisper_rescue" in src
    assert "wake_gate_vosk_local_fallback" in src
    assert "source=vosk_local_fallback" in src
    assert "AVA_LOCAL_WAKE_GATE_RESCUE_AFTER_BLOCKS" in src
    assert "AVA_LOCAL_WAKE_GATE_RESCUE_MAX_SEC" in src
    assert 'wakeish = {"hey", "ava", "aba", "eva", "able", "abel", "aber"}' in src
    assert 'phonetic_single_wake = {"offer", "over", "other", "evil"}' in src
    assert "end_silence = max(" in src
    assert "0.75" in src
    assert "AVA_LOCAL_VOICE_TRACE_EMPTY" in src
    assert "ignored_empty_transcript" in src
    assert "whisper_retry_no_vad" in src
    assert "vad_filter=False" in src
    assert "debug_wav reason=" in src
    assert '"wake_gate_block"' in src
    assert "AVA_ASR_TRACE_DIR" in src
    assert '_log("tts=piper")' in src
    assert "AVA_LOCAL_VAD_MIN_START_RMS" in src
    assert '"local_start_rms", 250' in src
    assert '"local_start_noise_mult", 3.0' in src
    assert "AVA_LOCAL_VAD_MIN_PEAK_RMS" in src
    assert '"local_min_peak_rms", 650' in src
    assert "AVA_LOCAL_NOISE_PERCENTILE" in src
    assert '"local_noise_percentile", 20.0' in src
    assert "AVA_LOCAL_VAD_MEDIAN_START_MULT" in src
    assert '"local_start_median_mult", 2.0' in src
    assert "AVA_LOCAL_VAD_BUILTIN_START_RMS" in src
    assert '"local_builtin_start_rms", 650' in src
    assert "AVA_LOCAL_VAD_REALTEK_START_RMS" in src
    assert '"local_realtek_start_rms", 5000' in src
    assert "--input-wav" in src
    assert "--live-input-wav" in src
    assert "AVA_LOCAL_INPUT_WAV" in src
    assert "AVA_LOCAL_LIVE_INPUT_WAV" in src
    assert "run_input_wav" in src
    assert "run_live_input_wav" in src
    assert "synthetic_live_input=" in src
    assert "Synthetic Live WAV Input" in src
    assert "deterministic_summary=" in src
    assert "AVA_LOCAL_VAD_BUILTIN_MAX_START_RMS" in src
    assert '"local_builtin_max_start_rms", 850' in src
    assert "vad_start_ceiling_ignored" in src
    assert "vad_stop_ceiling_ignored" in src
    assert "AVA_LOCAL_NOISE_HIGH_PERCENTILE" in src
    assert "AVA_LOCAL_VAD_HIGH_NOISE_HEADROOM_RMS" in src
    assert "AVA_LOCAL_VAD_HIGH_NOISE_FLOOR_MULT" in src
    assert "AVA_LOCAL_VAD_HIGH_NOISE_MAX_START_RMS" in src
    assert '"local_high_noise_max_start_rms"' in src
    assert "7000" in src
    assert "vad_start_dynamic_cap" in src
    assert "AVA_LOCAL_VAD_REALTEK_START_CONFIRM_FRAMES" in src
    assert "vad_start_confirm_frames=" in src
    assert "near_start_frames=" in src
    assert "near_start_peak=" in src


def test_minimal_runner_launcher_uses_new_entrypoint():
    root = Path(__file__).parent.parent
    launcher = (root / "start_local_voice.bat").read_text(encoding="utf-8")

    assert "python ava_local_voice.py" in launcher
    assert "ava_standalone_realtime.py" not in launcher
    assert "AVA_TTS_CHUNKING=0" in launcher
    assert "AVA_TTS_SEGMENTING=0" in launcher

    ui_launcher = (root / "start_ava_realtime_ui.bat").read_text(encoding="utf-8")
    assert "http://127.0.0.1:8765/api/status" in ui_launcher
    assert 'start "" "http://127.0.0.1:8765/"' in ui_launcher


def test_dashboard_can_launch_local_voice_without_defaulting_to_legacy():
    root = Path(__file__).parent.parent
    ui_src = (root / "ava_realtime_ui.py").read_text(encoding="utf-8")

    assert 'LOCAL_RUNNER = APP_DIR / "ava_local_voice.py"' in ui_src
    assert 'PUSH_TO_TALK_RUNNER = APP_DIR / "tools" / "voice_lab" / "13_push_to_talk_once.py"' in ui_src
    assert 'MIC_CALIBRATION_RUNNER = APP_DIR / "tools" / "voice_lab" / "14_mic_voice_calibration.py"' in ui_src
    assert 'runner_mode = str(options.get("runner_mode") or "local")' in ui_src
    assert 'opts.runner_mode = "local"' in ui_src
    assert 'opts.runner_mode = "legacy"' in ui_src
    assert 'id="startLegacyBtn"' in ui_src
    assert r"\[local-voice\] ready" in ui_src
    assert r"\[local-voice\] asr_final=" in ui_src
    assert "AVA_RUNNER_MODE" in ui_src
    assert 'status.get("runner_mode") == "local"' in ui_src
    assert "Whisper final" in ui_src
    assert "Vosk wake gate" in ui_src
    assert r"\[local-voice\] wake_gate=vosk" in ui_src
    assert "Live acceptance" in ui_src
    assert '"acceptance": acceptance' in ui_src
    assert "def _acceptance_status" in ui_src
    assert "session_acceptance_analyzer" in ui_src
    assert r"\[local-voice\] tts=" in ui_src
    assert 'id="pttBtn"' in ui_src
    assert 'id="pttResult"' in ui_src
    assert '"/api/push-to-talk"' in ui_src
    assert "def _push_to_talk_once" in ui_src
    assert "renderPushToTalk" in ui_src
    assert '"--start-delay"' in ui_src
    assert 'id="micCalBtn"' in ui_src
    assert 'id="micCalResult"' in ui_src
    assert '"/api/mic-calibration"' in ui_src
    assert "def _mic_calibration_once" in ui_src
    assert "renderMicCalibration" in ui_src
    assert '"--audible-cues"' in ui_src
    assert "audible_cues: true" in ui_src
    assert "sustained_voice_ms" in ui_src
    assert "first_voice_ms" in ui_src


def test_local_vad_ignores_builtin_ceiling_when_calibration_is_louder(monkeypatch):
    class FakeStream:
        def __init__(self) -> None:
            self.values = [3098] * 7 + [6483] * 17 + [8200] * 11
            self.index = 0

        def read(self, samples, exception_on_overflow=False):
            value = self.values[min(self.index, len(self.values) - 1)]
            self.index += 1
            return int(value).to_bytes(2, "little", signed=True) * samples

    clock = {"now": 0.0}

    def fake_time():
        clock["now"] += 0.03
        return clock["now"]

    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.running = True
    runner.config = {"local_vad": {}}
    runner.input_stream = ava_local_voice.InputStream(
        stream=FakeStream(),
        rate=48000,
        frames_per_buffer=1440,
        device_index=14,
        device_name="Microphone (Realtek High Definition Audio)",
    )

    monkeypatch.setattr(ava_local_voice.time, "time", fake_time)

    start_rms, stop_rms = runner._calibrate_noise(seconds=1.0)

    assert 6500 <= start_rms <= 7000
    assert 4500 <= stop_rms <= 5000
    assert start_rms != 850
    assert stop_rms != 500


def test_wake_strip_cleans_repeated_wake_phrases_from_command():
    has_wake, command = ava_local_voice._strip_wake("Ava, what time is it? Ava, what time is it?")

    assert has_wake is True
    assert command == "what time is it"

    has_wake, command = ava_local_voice._strip_wake("Hey Abel, what time is it? Hey Abel, what time is it?")

    assert has_wake is True
    assert command == "what time is it"


def test_wake_gate_keeps_loud_short_wake_hints_recoverable(monkeypatch):
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.vosk_model = object()
    runner.no_wake_streak = 8
    runner.wake_gate_after_no_wake = 0
    runner.followup_until = 0.0
    runner.last_wake_gate_rescue_at = 0.0
    monkeypatch.setattr(ava_local_voice, "KaldiRecognizer", object)

    utterance = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 3200,
        src_rate=16000,
        duration_sec=1.0,
        voiced_sec=0.8,
        peak_rms=5200,
        mean_rms=2400,
        start_rms=1800,
        stop_rms=900,
    )

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "hey over what time is it")
    assert runner._wake_gate_allows_whisper(utterance)

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "offer")
    assert runner._wake_gate_allows_whisper(utterance)

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "they other what time is it")
    assert runner._wake_gate_allows_whisper(utterance)

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "over open notepad")
    assert runner._wake_gate_allows_whisper(utterance)

    monkeypatch.setattr(ava_local_voice.time, "time", lambda: 100.0)
    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "")
    assert runner._wake_gate_allows_whisper(utterance)

    runner.last_wake_gate_rescue_at = 0.0
    monkeypatch.setattr(ava_local_voice.time, "time", lambda: 150.0)
    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "")
    measured_realtek_utterance = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 6400,
        src_rate=44100,
        duration_sec=1.86,
        voiced_sec=0.72,
        peak_rms=6243,
        mean_rms=2296,
        start_rms=5000,
        stop_rms=1800,
    )
    assert runner._wake_gate_allows_whisper(measured_realtek_utterance)

    runner.no_wake_streak = 0
    runner.last_wake_gate_rescue_at = 0.0
    monkeypatch.setattr(ava_local_voice.time, "time", lambda: 175.0)
    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "")
    measured_speaker_to_mic_block = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 9600,
        src_rate=44100,
        duration_sec=2.88,
        voiced_sec=0.57,
        peak_rms=5948,
        mean_rms=1111,
        start_rms=5000,
        stop_rms=1800,
    )
    assert runner._wake_gate_allows_whisper(measured_speaker_to_mic_block)

    runner.no_wake_streak = 3
    runner.last_wake_gate_rescue_at = 0.0
    monkeypatch.setattr(ava_local_voice.time, "time", lambda: 200.0)
    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "she can do it")
    long_utterance = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 6400,
        src_rate=16000,
        duration_sec=2.0,
        voiced_sec=1.1,
        peak_rms=5200,
        mean_rms=2400,
        start_rms=1800,
        stop_rms=900,
    )
    assert runner._wake_gate_allows_whisper(long_utterance)

    runner.no_wake_streak = 3
    runner.last_wake_gate_rescue_at = 0.0
    monkeypatch.setattr(ava_local_voice.time, "time", lambda: 300.0)
    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "yeah")
    ambient_long_utterance = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 19200,
        src_rate=16000,
        duration_sec=6.0,
        voiced_sec=5.4,
        peak_rms=5200,
        mean_rms=2400,
        start_rms=1800,
        stop_rms=900,
    )
    assert not runner._wake_gate_allows_whisper(ambient_long_utterance)

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "time the most important information")
    assert not runner._wake_gate_allows_whisper(utterance)

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "what is supposed to be")
    assert not runner._wake_gate_allows_whisper(utterance)


def test_vad_rejects_write_debug_wavs(monkeypatch):
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.config = {"asr": {"utterance": {"min_speech_ms": 250}}, "local_vad": {}}
    written = []
    monkeypatch.setattr(runner, "_write_debug_wav", lambda _utterance, reason: written.append(reason))

    low_confidence = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 3200,
        src_rate=44100,
        duration_sec=1.2,
        voiced_sec=0.06,
        peak_rms=1200,
        mean_rms=200,
        start_rms=5000,
        stop_rms=1800,
    )
    assert runner._should_transcribe(low_confidence) is False

    flat_capture = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 3200,
        src_rate=44100,
        duration_sec=0.5,
        voiced_sec=0.3,
        peak_rms=1250,
        mean_rms=100,
        start_rms=650,
        stop_rms=300,
    )
    assert runner._should_transcribe(flat_capture) is False

    assert written == ["vad_low_confidence", "vad_flat_capture"]


def test_deterministic_wav_loader_builds_captured_utterance(tmp_path):
    wav_path = tmp_path / "wake.wav"
    pcm = (1200).to_bytes(2, "little", signed=True) * 16000
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm)

    utterance = ava_local_voice._captured_utterance_from_wav(wav_path, start_rms=500, stop_rms=220)

    assert 0.99 <= utterance.duration_sec <= 1.01
    assert utterance.src_rate == 16000
    assert utterance.peak_rms >= 1100
    assert utterance.mean_rms >= 1100
    assert utterance.voiced_sec >= 0.9


def test_deterministic_input_wav_routes_through_same_handler(monkeypatch, tmp_path):
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.config = {}
    runner.followup_until = 0.0
    runner.no_wake_streak = 0
    runner.wake_gate_after_no_wake = 0
    runner.last_wake_gate_rescue_at = 0.0
    runner.wake_gate_fallback_transcript = ""
    runner.last_spoken_text = ""

    initialized = {}

    def fake_initialize(*, input_enabled=True, playback_enabled=True):
        initialized["input_enabled"] = input_enabled
        initialized["playback_enabled"] = playback_enabled

    monkeypatch.setattr(runner, "initialize", fake_initialize)
    monkeypatch.setattr(
        runner,
        "_utterance_from_wav",
        lambda _path: ava_local_voice.CapturedUtterance(
            pcm=b"\0" * 3200,
            src_rate=16000,
            duration_sec=1.0,
            voiced_sec=0.8,
            peak_rms=5200,
            mean_rms=2400,
            start_rms=500,
            stop_rms=220,
        ),
    )
    monkeypatch.setattr(runner, "_transcribe", lambda _utterance: "hey ava what time is it")
    monkeypatch.setattr(runner, "_speak", lambda text: setattr(runner, "last_spoken_text", text))

    summary = runner.run_input_wav(tmp_path / "synthetic.wav", playback_enabled=False)

    assert initialized == {"input_enabled": False, "playback_enabled": False}
    assert summary["accepted"] is True
    assert summary["transcript"] == "hey ava what time is it"
    assert summary["command"] == "what time is it"
    assert summary["reply"].startswith("It's ")
    assert summary["tts_attempted"] is True


def test_live_input_wav_routes_through_capture_loop(monkeypatch, tmp_path):
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.config = {}
    runner.followup_until = 0.0
    runner.no_wake_streak = 0
    runner.wake_gate_after_no_wake = 0
    runner.last_wake_gate_rescue_at = 0.0
    runner.wake_gate_fallback_transcript = ""
    runner.last_spoken_text = ""
    runner.input_stream = None

    calls = []

    def fake_initialize(*, input_enabled=True, playback_enabled=True):
        calls.append(("initialize", input_enabled, playback_enabled))

    fake_stream = ava_local_voice.InputStream(
        stream=object(),
        rate=16000,
        frames_per_buffer=480,
        device_index=None,
        device_name="Synthetic Live WAV Input",
    )

    monkeypatch.setattr(runner, "initialize", fake_initialize)
    monkeypatch.setattr(runner, "_input_stream_from_wav", lambda _path: fake_stream)
    monkeypatch.setattr(runner, "_calibrate_noise", lambda: calls.append(("calibrate",)) or (500, 220))

    def fake_capture(start_rms, stop_rms):
        calls.append(("capture", start_rms, stop_rms, runner.input_stream.device_name))
        return ava_local_voice.CapturedUtterance(
            pcm=b"\0" * 3200,
            src_rate=16000,
            duration_sec=1.0,
            voiced_sec=0.8,
            peak_rms=5200,
            mean_rms=2400,
            start_rms=start_rms,
            stop_rms=stop_rms,
        )

    monkeypatch.setattr(runner, "_capture_utterance", fake_capture)
    monkeypatch.setattr(runner, "_transcribe", lambda _utterance: calls.append(("transcribe",)) or "hey ava what time is it")
    monkeypatch.setattr(runner, "_speak", lambda text: setattr(runner, "last_spoken_text", text))

    summary = runner.run_live_input_wav(tmp_path / "synthetic.wav", playback_enabled=False)

    assert calls[:4] == [
        ("initialize", False, False),
        ("calibrate",),
        ("capture", 500, 220, "Synthetic Live WAV Input"),
        ("transcribe",),
    ]
    assert summary["mode"] == "live_input_wav"
    assert summary["accepted"] is True
    assert summary["command"] == "what time is it"
    assert summary["reply"].startswith("It's ")
    assert summary["vad_start"] == 500
    assert summary["captured_peak_rms"] == 5200
    assert summary["tts_attempted"] is True


def test_synthetic_wav_input_stream_prepends_calibration_silence(tmp_path):
    wav_path = tmp_path / "wake.wav"
    pcm = (1600).to_bytes(2, "little", signed=True) * 1600
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm)

    stream = ava_local_voice.SyntheticWavInputStream(
        wav_path,
        calibration_silence_sec=0.03,
        post_silence_sec=0.03,
    )

    first = stream.read(480)
    second = stream.read(480)

    assert audioop.rms(first, 2) == 0
    assert audioop.rms(second, 2) > 1000


def test_wake_gate_can_fallback_to_local_time_when_vosk_hears_only_time(monkeypatch):
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.vosk_model = object()
    runner.no_wake_streak = 0
    runner.wake_gate_after_no_wake = 0
    runner.followup_until = 0.0
    runner.last_wake_gate_rescue_at = 0.0
    runner.wake_gate_fallback_transcript = ""
    monkeypatch.setattr(ava_local_voice, "KaldiRecognizer", object)

    utterance = ava_local_voice.CapturedUtterance(
        pcm=b"\0" * 9600,
        src_rate=48000,
        duration_sec=3.0,
        voiced_sec=1.2,
        peak_rms=8200,
        mean_rms=3100,
        start_rms=6500,
        stop_rms=2500,
    )

    monkeypatch.setattr(runner, "_wake_gate_text", lambda _utterance: "time")

    assert not runner._wake_gate_allows_whisper(utterance)
    assert runner.wake_gate_fallback_transcript == "ava what time is it"
