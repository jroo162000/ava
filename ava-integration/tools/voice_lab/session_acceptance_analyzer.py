"""Analyze AVA local voice session logs against the live acceptance gate.

This tool intentionally works from plain stdout/stderr logs. It gives us a
repeatable pass/fail readout after live tests instead of relying on memory of
what sounded like it happened in the room.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable


TIME_RE = re.compile(r"\b(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:AM|PM)\b", re.IGNORECASE)
CRITICAL_PATTERNS = (
    "Traceback",
    "Segmentation fault",
    "access violation",
    "0xC0000005",
    "0xC0000409",
    "Failed to process waveform",
    "I could not reach my local brain",
)


@dataclass
class AcceptanceAnalysis:
    path: str
    ready: bool = False
    input: str | None = None
    tts: str | None = None
    asr: str | None = None
    listening_seen: bool = False
    final_transcripts: list[str] = field(default_factory=list)
    spoken_replies: list[str] = field(default_factory=list)
    server_commands: list[str] = field(default_factory=list)
    followup_commands: list[str] = field(default_factory=list)
    ignored_no_wake: int = 0
    ignored_asr_filler: int = 0
    ignored_wake_gate_no_wake: int = 0
    wake_gate_query_bypass: int = 0
    ignored_vad_low_confidence: int = 0
    ignored_vad_flat_capture: int = 0
    ignored_empty_transcript: int = 0
    ignored_resampled_low_energy: int = 0
    ignored_resampled_too_short: int = 0
    whisper_retry_no_vad: int = 0
    speech_starts: int = 0
    finalizing_captures: int = 0
    mic_idle_count: int = 0
    mic_idle_peak_max: int = 0
    mic_idle_rms_last: int | None = None
    noise_rms: int | None = None
    noise_p50: int | None = None
    vad_start: int | None = None
    vad_stop: int | None = None
    cooldowns: int = 0
    debug_wavs: list[dict[str, str]] = field(default_factory=list)
    capture_quality: dict[str, str] = field(default_factory=dict)
    critical_events: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    passed_checks: list[str] = field(default_factory=list)
    failed_checks: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failed_checks and not self.critical_events


def _extract_repr_after(line: str, marker: str) -> str:
    raw = line.split(marker, 1)[1].strip()
    try:
        value = ast.literal_eval(raw)
    except Exception:
        return raw.strip("\"'")
    return str(value)


def _append_unique_issue(items: list[str], issue: str) -> None:
    if issue not in items:
        items.append(issue)


def _extract_int_key(line: str, key: str) -> int | None:
    match = re.search(rf"\b{re.escape(key)}=(\d+)", line)
    return int(match.group(1)) if match else None


def _extract_debug_wav(line: str, line_no: int) -> dict[str, str] | None:
    if "debug_wav reason=" not in line or " path=" not in line:
        return None
    try:
        raw_reason = line.split("debug_wav reason=", 1)[1].split(" path=", 1)[0].strip()
        raw_path = line.split(" path=", 1)[1].strip()
        reason = str(ast.literal_eval(raw_reason))
        path = str(ast.literal_eval(raw_path))
    except Exception:
        return None
    return {"reason": reason, "path": path, "line": str(line_no)}


def _resolve_log_path(path: Path) -> Path:
    if path.is_dir():
        stdout = path / "stdout.log"
        if stdout.exists():
            return stdout
    return path


def _is_date_reply(text: str) -> bool:
    return text.startswith("Today is ")


def _is_time_reply(text: str) -> bool:
    return bool(TIME_RE.search(text))


def _is_identity_reply(text: str) -> bool:
    normalized = text.lower()
    return "i'm ava" in normalized or "local voice assistant" in normalized


def _is_local_fact_command(text: str) -> bool:
    normalized = text.lower()
    return any(
        marker in normalized
        for marker in (
            "what time",
            "time is it",
            "current time",
            "what is today",
            "what's today",
            "what day",
            "what date",
            "date today",
            "date is it",
        )
    )


def analyze_lines(lines: Iterable[str], path: str = "<memory>") -> AcceptanceAnalysis:
    analysis = AcceptanceAnalysis(path=path)
    speaking_open = False
    speaking_open_line = 0

    for line_no, line in enumerate(lines, start=1):
        line = line.rstrip("\n")
        for pattern in CRITICAL_PATTERNS:
            if pattern.lower() in line.lower():
                _append_unique_issue(analysis.critical_events, f"line {line_no}: {line.strip()}")

        if "[local-voice] input=" in line:
            analysis.input = line.split("[local-voice] input=", 1)[1].strip()
        elif "[local-voice] loading_whisper=" in line:
            analysis.asr = line.split("[local-voice] loading_whisper=", 1)[1].strip()
        elif "[local-voice] tts=" in line:
            analysis.tts = line.split("[local-voice] tts=", 1)[1].strip()
        elif "[local-voice] ready" in line:
            analysis.ready = True
        elif "[local-voice] state=LISTENING" in line:
            analysis.listening_seen = True
            if "speech_start" in line:
                analysis.speech_starts += 1
        if "[local-voice] state=FINALIZING" in line:
            analysis.finalizing_captures += 1
        if "[local-voice] noise_rms=" in line:
            analysis.noise_rms = _extract_int_key(line, "noise_rms")
            analysis.noise_p50 = _extract_int_key(line, "noise_p50")
            analysis.vad_start = _extract_int_key(line, "vad_start")
            analysis.vad_stop = _extract_int_key(line, "vad_stop")
        if "[local-voice] mic_idle" in line:
            analysis.mic_idle_count += 1
            peak = _extract_int_key(line, "peak")
            rms = _extract_int_key(line, "rms")
            if peak is not None:
                analysis.mic_idle_peak_max = max(analysis.mic_idle_peak_max, peak)
            if rms is not None:
                analysis.mic_idle_rms_last = rms

        if "asr_final=" in line:
            analysis.final_transcripts.append(_extract_repr_after(line, "asr_final="))
        elif "state=RESPONDING command=" in line:
            analysis.server_commands.append(_extract_repr_after(line, "state=RESPONDING command="))
        elif "followup_command=" in line:
            analysis.followup_commands.append(_extract_repr_after(line, "followup_command="))
        elif "ignored_no_wake=" in line:
            analysis.ignored_no_wake += 1
        elif "ignored_asr_filler=" in line:
            analysis.ignored_asr_filler += 1
        elif "ignored_wake_gate_no_wake=" in line:
            analysis.ignored_wake_gate_no_wake += 1
        elif "wake_gate_query_bypass=" in line:
            analysis.wake_gate_query_bypass += 1
        elif "ignored_vad_low_confidence=" in line:
            analysis.ignored_vad_low_confidence += 1
        elif "ignored_vad_flat_capture=" in line:
            analysis.ignored_vad_flat_capture += 1
        elif "ignored_empty_transcript=" in line:
            analysis.ignored_empty_transcript += 1
        elif "ignored_resampled_low_energy=" in line:
            analysis.ignored_resampled_low_energy += 1
        elif "ignored_resampled_too_short=" in line:
            analysis.ignored_resampled_too_short += 1
        elif "whisper_retry_no_vad=" in line:
            analysis.whisper_retry_no_vad += 1
        elif "debug_wav reason=" in line:
            item = _extract_debug_wav(line, line_no)
            if item:
                analysis.debug_wavs.append(item)
        elif "state=SPEAKING text=" in line:
            if speaking_open:
                _append_unique_issue(
                    analysis.critical_events,
                    f"line {line_no}: new TTS started before previous cooldown from line {speaking_open_line}",
                )
            speaking_open = True
            speaking_open_line = line_no
            analysis.spoken_replies.append(_extract_repr_after(line, "state=SPEAKING text="))
        elif "state=COOLDOWN" in line:
            if speaking_open:
                speaking_open = False
            analysis.cooldowns += 1

    if speaking_open:
        _append_unique_issue(
            analysis.critical_events,
            f"line {speaking_open_line}: TTS started without a later cooldown marker",
        )

    _score_acceptance(analysis)
    return analysis


def _score_acceptance(analysis: AcceptanceAnalysis) -> None:
    def check(name: str, ok: bool) -> None:
        target = analysis.passed_checks if ok else analysis.failed_checks
        target.append(name)

    def capture_quality(state: str, title: str, detail: str, recommendation: str) -> None:
        analysis.capture_quality = {
            "state": state,
            "title": title,
            "detail": detail,
            "recommendation": recommendation,
        }

    date_replies = [text for text in analysis.spoken_replies if _is_date_reply(text)]
    time_replies = [text for text in analysis.spoken_replies if _is_time_reply(text)]
    identity_replies = [text for text in analysis.spoken_replies if _is_identity_reply(text)]
    local_fact_server_commands = [
        command for command in analysis.server_commands if _is_local_fact_command(command)
    ]

    check("runner_ready", analysis.ready and analysis.listening_seen)
    check("local_input_selected", bool(analysis.input))
    check("whisper_loaded", bool(analysis.asr))
    check("piper_loaded", analysis.tts == "piper")
    check("date_answered", len(date_replies) >= 1)
    check("time_answered_twice", len(time_replies) >= 2)
    check("identity_answered", len(identity_replies) >= 1)
    check("general_server_question_handled", len(analysis.server_commands) >= 1)
    check("local_facts_not_server_routed", not local_fact_server_commands)
    check("at_least_five_spoken_acceptance_replies", len(analysis.spoken_replies) >= 5)
    check("one_cooldown_per_spoken_reply", analysis.cooldowns >= len(analysis.spoken_replies))
    check("no_critical_runtime_events", not analysis.critical_events)

    if len(analysis.spoken_replies) > 6:
        analysis.warnings.append(
            f"More spoken replies than the six-step gate usually needs: {len(analysis.spoken_replies)}"
        )
    if analysis.ignored_no_wake:
        analysis.warnings.append(f"Ignored no-wake transcripts: {analysis.ignored_no_wake}")
    if analysis.ignored_asr_filler:
        analysis.warnings.append(f"Filtered ASR filler transcripts: {analysis.ignored_asr_filler}")
    if analysis.ignored_wake_gate_no_wake:
        analysis.warnings.append(f"Wake-gated no-wake utterances before Whisper: {analysis.ignored_wake_gate_no_wake}")
    if analysis.wake_gate_query_bypass:
        analysis.warnings.append(f"Wake-gate query bypasses to Whisper: {analysis.wake_gate_query_bypass}")
    ignored_vad = analysis.ignored_vad_low_confidence + analysis.ignored_vad_flat_capture
    if ignored_vad:
        analysis.warnings.append(f"Filtered low-confidence VAD captures: {ignored_vad}")
    if analysis.ignored_resampled_low_energy:
        analysis.warnings.append(f"Dropped post-resample low-energy captures: {analysis.ignored_resampled_low_energy}")
    if analysis.ignored_resampled_too_short:
        analysis.warnings.append(f"Dropped post-resample too-short captures: {analysis.ignored_resampled_too_short}")
    if analysis.ignored_empty_transcript:
        analysis.warnings.append(f"Whisper returned empty transcripts: {analysis.ignored_empty_transcript}")
    if analysis.whisper_retry_no_vad:
        analysis.warnings.append(f"Whisper no-VAD retries: {analysis.whisper_retry_no_vad}")
    if analysis.debug_wavs:
        analysis.warnings.append(f"Failed-turn debug WAV artifacts saved: {len(analysis.debug_wavs)}")
    if (
        not analysis.spoken_replies
        and not analysis.capture_quality
        and (analysis.final_transcripts or analysis.ignored_no_wake or analysis.ignored_wake_gate_no_wake)
    ):
        capture_quality(
            "captured_no_wake",
            "Captured audio is not wake-qualified",
            (
                f"Captured {len(analysis.final_transcripts)} final transcript(s), "
                f"ignored_no_wake={analysis.ignored_no_wake}, "
                f"wake_gate_blocks={analysis.ignored_wake_gate_no_wake}, spoken_replies=0."
            ),
            "If you were addressing AVA, say the wake phrase closer and more clearly or use push-to-talk. If this was room/audio bleed, AVA is correctly refusing to answer.",
        )
    if (
        analysis.ready
        and analysis.listening_seen
        and not analysis.final_transcripts
        and not analysis.spoken_replies
        and analysis.speech_starts == 0
    ):
        if analysis.mic_idle_count and analysis.vad_start is not None:
            if analysis.mic_idle_peak_max >= analysis.vad_start:
                detail = (
                    "Only brief mic peaks crossed VAD threshold; no sustained speech_start was observed "
                    f"(max idle peak {analysis.mic_idle_peak_max} vs vad_start {analysis.vad_start})"
                )
                capture_quality(
                    "brief_peaks",
                    "Mic is hearing transient spikes, not sustained speech",
                    detail,
                    "If you were speaking, move closer or switch to a better mic, then run Mic Calibration or Push-to-talk. If nobody spoke, this is background/transient noise and AVA is correctly staying silent.",
                )
            else:
                detail = (
                    "No VAD speech_start events were observed on the selected input "
                    f"(max idle peak {analysis.mic_idle_peak_max} vs vad_start {analysis.vad_start})"
                )
                capture_quality(
                    "no_speech",
                    "Selected mic is not hearing usable speech",
                    detail,
                    "Check the selected input, Windows mic permissions/mute, mic distance, or run Mic Calibration before changing ASR or wake-gate code.",
                )
        else:
            detail = "No VAD speech_start events were observed on the selected input"
            capture_quality(
                "no_activity",
                "No live mic activity reached VAD",
                detail,
                "Confirm the mic is enabled and selected before tuning ASR, wake words, or TTS.",
            )
        analysis.warnings.append(detail)
    elif analysis.speech_starts and not analysis.final_transcripts and not analysis.spoken_replies:
        if analysis.debug_wavs:
            capture_quality(
                "captured_unaccepted",
                "Captured audio did not become an accepted command",
                f"VAD captured {analysis.speech_starts} utterance(s); {len(analysis.debug_wavs)} failed-turn WAV artifact(s) were saved.",
                "Inspect the failed-turn WAV metrics/audio first. If they are intelligible, tune wake/ASR; if not, fix mic placement/device/noise.",
            )
        else:
            capture_quality(
                "captured_no_artifact",
                "Captured audio did not reach an accepted final transcript",
                f"VAD captured speech-like audio {analysis.speech_starts} time(s), but no ASR final was accepted.",
                "Repeat the test with trace artifacts enabled or use the live acceptance window so the failed capture can be audited.",
            )
        analysis.warnings.append(
            f"VAD captured speech-like audio {analysis.speech_starts} time(s), but nothing reached an accepted Whisper final"
        )


def analyze_path(path: Path) -> AcceptanceAnalysis:
    log_path = _resolve_log_path(path)
    lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    return analyze_lines(lines, str(log_path))


def _format_text(analysis: AcceptanceAnalysis) -> str:
    status = "PASS" if analysis.ok else "FAIL"
    lines = [
        f"AVA local voice acceptance: {status}",
        f"log: {analysis.path}",
        f"input: {analysis.input or 'unknown'}",
        f"asr: {analysis.asr or 'unknown'}",
        f"tts: {analysis.tts or 'unknown'}",
        f"spoken replies: {len(analysis.spoken_replies)}",
        f"final transcripts: {len(analysis.final_transcripts)}",
        f"speech starts: {analysis.speech_starts}",
    ]
    if analysis.spoken_replies:
        lines.append("replies:")
        lines.extend(f"  - {reply}" for reply in analysis.spoken_replies)
    if analysis.failed_checks:
        lines.append("failed checks:")
        lines.extend(f"  - {item}" for item in analysis.failed_checks)
    if analysis.critical_events:
        lines.append("critical events:")
        lines.extend(f"  - {item}" for item in analysis.critical_events)
    if analysis.warnings:
        lines.append("warnings:")
        lines.extend(f"  - {item}" for item in analysis.warnings)
    if analysis.capture_quality:
        lines.append("capture quality:")
        lines.append(f"  - {analysis.capture_quality.get('title', 'unknown')}: {analysis.capture_quality.get('detail', '')}")
        lines.append(f"  - recommendation: {analysis.capture_quality.get('recommendation', '')}")
    if analysis.debug_wavs:
        lines.append("debug wavs:")
        lines.extend(f"  - {item['reason']}: {item['path']}" for item in analysis.debug_wavs)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze an AVA local voice session log")
    parser.add_argument("path", type=Path, help="Path to stdout.log or a session directory")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()

    analysis = analyze_path(args.path)
    if args.json:
        print(json.dumps(asdict(analysis) | {"ok": analysis.ok}, indent=2))
    else:
        print(_format_text(analysis))
    return 0 if analysis.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
