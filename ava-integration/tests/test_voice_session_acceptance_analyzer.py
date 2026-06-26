import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
ANALYZER_PATH = ROOT / "tools" / "voice_lab" / "session_acceptance_analyzer.py"


def load_analyzer():
    spec = importlib.util.spec_from_file_location("voice_session_acceptance_analyzer", ANALYZER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_acceptance_analyzer_passes_clean_local_voice_gate():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone (Realtek High Defini idx=2 rate=44100 fpb=1323",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] state=LISTENING",
        "[local-voice] asr_final='Hey Ava, what is today?'",
        "[local-voice] state=SPEAKING text='Today is Saturday, June 13, 2026.'",
        "[local-voice] state=COOLDOWN",
        "[local-voice] asr_final='Ava, what time is it?'",
        "[local-voice] state=SPEAKING text=\"It's 10:44 PM.\"",
        "[local-voice] state=COOLDOWN",
        "[local-voice] asr_final='Ava, who are you?'",
        "[local-voice] state=SPEAKING text=\"I'm AVA, your local voice assistant.\"",
        "[local-voice] state=COOLDOWN",
        "[local-voice] asr_final='Ava, why is the sky blue?'",
        "[local-voice] state=RESPONDING command='why is the sky blue'",
        "[local-voice] state=SPEAKING text='Sunlight scatters in the atmosphere, and blue wavelengths scatter more.'",
        "[local-voice] state=COOLDOWN",
        "[local-voice] ignored_asr_filler='Okay.'",
        "[local-voice] ignored_wake_gate_no_wake='background program audio' streak=4",
        "[local-voice] wake_gate_query_bypass='hey other what time is it'",
        "[local-voice] asr_final='Ava, what time is it?'",
        "[local-voice] state=SPEAKING text=\"It's 10:45 PM.\"",
        "[local-voice] state=COOLDOWN",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert analysis.ok
    assert not analysis.failed_checks
    assert len(analysis.spoken_replies) == 5
    assert "general_server_question_handled" in analysis.passed_checks
    assert "local_facts_not_server_routed" in analysis.passed_checks
    assert "Filtered ASR filler transcripts: 1" in analysis.warnings
    assert "Wake-gated no-wake utterances before Whisper: 1" in analysis.warnings
    assert "Wake-gate query bypasses to Whisper: 1" in analysis.warnings


def test_acceptance_analyzer_fails_when_tts_never_cools_down():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone idx=2 rate=44100",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] state=LISTENING",
        "[local-voice] asr_final='Ava, what time is it?'",
        "[local-voice] state=SPEAKING text=\"It's 10:44 PM.\"",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert not analysis.ok
    assert "one_cooldown_per_spoken_reply" in analysis.failed_checks
    assert any("TTS started without a later cooldown marker" in event for event in analysis.critical_events)


def test_acceptance_analyzer_explains_no_vad_speech_on_selected_input():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone (Realtek High Defini idx=2 rate=44100 fpb=1323",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] noise_rms=3 noise_p50=246 noise_pct=20 vad_start=650 vad_stop=300",
        "[local-voice] state=LISTENING",
        "[local-voice] mic_idle frames=334 rms=15 peak=23 vad_start=650",
        "[local-voice] mic_idle frames=334 rms=16 peak=128 vad_start=650",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert not analysis.ok
    assert analysis.speech_starts == 0
    assert analysis.mic_idle_count == 2
    assert analysis.mic_idle_peak_max == 128
    assert analysis.vad_start == 650
    assert any("No VAD speech_start events" in warning for warning in analysis.warnings)
    assert analysis.capture_quality["state"] == "no_speech"
    assert "Selected mic is not hearing usable speech" == analysis.capture_quality["title"]


def test_acceptance_analyzer_explains_brief_peaks_without_sustained_speech():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone idx=14 host=Windows WASAPI rate=48000",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] noise_rms=233 noise_p50=265 noise_pct=20 vad_start=699 vad_stop=466",
        "[local-voice] state=LISTENING",
        "[local-voice] mic_idle frames=334 rms=40 peak=1334 vad_start=699",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert not analysis.ok
    assert analysis.speech_starts == 0
    assert analysis.mic_idle_peak_max == 1334
    assert any("Only brief mic peaks crossed VAD threshold" in warning for warning in analysis.warnings)
    assert analysis.capture_quality["state"] == "brief_peaks"
    assert "transient spikes" in analysis.capture_quality["title"]


def test_acceptance_analyzer_explains_empty_whisper_results_after_capture():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone idx=14 host=Windows WASAPI rate=48000",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] state=LISTENING",
        "[local-voice] state=LISTENING speech_start rms=1695",
        "[local-voice] state=FINALIZING speech_end dur_ms=1650 voiced_ms=600 peak=2904 mean=662",
        "[local-voice] wake_gate_whisper_rescue=reason:low_info streak:1 dur_ms:1650 voiced_ms:600 peak:2904 text:''",
        "[local-voice] whisper_start=dur_ms:1650 voiced_ms:600 rms:240 max:1600",
        "[local-voice] whisper_retry_no_vad=rms:240 max:1600",
        "[local-voice] ignored_empty_transcript=rms:240 max:1600",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert not analysis.ok
    assert analysis.speech_starts == 1
    assert analysis.finalizing_captures == 1
    assert analysis.whisper_retry_no_vad == 1
    assert analysis.ignored_empty_transcript == 1
    assert any("Whisper no-VAD retries: 1" in warning for warning in analysis.warnings)
    assert any("Whisper returned empty transcripts: 1" in warning for warning in analysis.warnings)
    assert analysis.capture_quality["state"] == "captured_no_artifact"
    assert "trace artifacts" in analysis.capture_quality["recommendation"]


def test_acceptance_analyzer_surfaces_failed_turn_debug_wavs():
    analyzer = load_analyzer()
    wav_path = r"C:\Users\USER 1\ava\ava-integration\logs\session\local_123_wake_gate_block_44100hz.wav"
    lines = [
        "[local-voice] input=Microphone idx=2 rate=44100",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] state=LISTENING",
        "[local-voice] state=LISTENING speech_start rms=5779",
        "[local-voice] state=FINALIZING speech_end dur_ms=2370 voiced_ms=270 peak=5667 mean=812",
        "[local-voice] ignored_wake_gate_no_wake='' streak=1",
        f"[local-voice] debug_wav reason='wake_gate_block' path={wav_path!r}",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert analysis.debug_wavs == [{"reason": "wake_gate_block", "path": wav_path, "line": "9"}]
    assert any("Failed-turn debug WAV artifacts saved: 1" in warning for warning in analysis.warnings)
    assert analysis.capture_quality["state"] == "captured_unaccepted"
    assert "Inspect the failed-turn WAV" in analysis.capture_quality["recommendation"]


def test_acceptance_analyzer_explains_captured_no_wake_audio():
    analyzer = load_analyzer()
    lines = [
        "[local-voice] input=Microphone idx=2 rate=44100",
        "[local-voice] loading_whisper=tiny.en",
        "[local-voice] tts=piper",
        "[local-voice] ready",
        "[local-voice] state=LISTENING",
        "[local-voice] asr_final='Thank you very much.'",
        "[local-voice] ignored_no_wake='Thank you very much.'",
        "[local-voice] ignored_wake_gate_no_wake='' streak=1",
    ]

    analysis = analyzer.analyze_lines(lines)

    assert analysis.capture_quality["state"] == "captured_no_wake"
    assert analysis.capture_quality["title"] == "Captured audio is not wake-qualified"
    assert "wake phrase" in analysis.capture_quality["recommendation"]
