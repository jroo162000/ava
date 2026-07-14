"""Deterministic acceptance harness for AVA's local voice turn logic.

This does not replace the live mic/speaker gate. It proves the local runner's
turn decision path with deterministic transcripts so we can catch regressions
before asking for another room test.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ava_local_voice  # noqa: E402


@dataclass
class HarnessEvent:
    transcript: str
    spoken_before: int
    spoken_after: int
    server_before: int
    server_after: int


@dataclass
class HarnessResult:
    ok: bool
    spoken: list[str] = field(default_factory=list)
    server_commands: list[str] = field(default_factory=list)
    events: list[HarnessEvent] = field(default_factory=list)
    failed_checks: list[str] = field(default_factory=list)
    passed_checks: list[str] = field(default_factory=list)


def _build_runner(spoken: list[str]) -> ava_local_voice.LocalVoiceRunner:
    runner = ava_local_voice.LocalVoiceRunner.__new__(ava_local_voice.LocalVoiceRunner)
    runner.config = {
        "validation_mode": {"followup_window_sec": 10.0},
        "streaming": {"enabled": False},
    }
    runner.followup_until = 0.0
    runner.no_wake_streak = 0
    runner.wake_gate_after_no_wake = 1

    def speak(text: str) -> None:
        spoken.append(text)

    runner._speak = speak  # type: ignore[method-assign]
    return runner


def _run_script(transcripts: list[str], server_reply: str) -> HarnessResult:
    spoken: list[str] = []
    server_commands: list[str] = []
    runner = _build_runner(spoken)

    def fake_server_respond(text: str, _config: dict) -> str:
        server_commands.append(text)
        return server_reply

    original_server_respond: Callable[[str, dict], str] = ava_local_voice._server_respond
    ava_local_voice._server_respond = fake_server_respond
    events: list[HarnessEvent] = []
    try:
        for transcript in transcripts:
            spoken_before = len(spoken)
            server_before = len(server_commands)
            runner._handle_transcript(transcript)
            events.append(
                HarnessEvent(
                    transcript=transcript,
                    spoken_before=spoken_before,
                    spoken_after=len(spoken),
                    server_before=server_before,
                    server_after=len(server_commands),
                )
            )
    finally:
        ava_local_voice._server_respond = original_server_respond

    result = HarnessResult(ok=False, spoken=spoken, server_commands=server_commands, events=events)
    _score(result)
    return result


def _score(result: HarnessResult) -> None:
    def check(name: str, ok: bool) -> None:
        (result.passed_checks if ok else result.failed_checks).append(name)

    expected_commands = [
        "what time is it",
        "what is today",
        "what time is it",
        "who are you",
        "why is the sky blue",
    ]
    check("wake_only_acknowledged", any(text == "I'm listening." for text in result.spoken))
    check("all_accepted_commands_routed_to_server", result.server_commands == expected_commands)
    check("one_spoken_reply_per_accepted_command", len(result.spoken) == len(expected_commands) + 1)
    check("server_reply_spoken", any("blue light scatters" in text.lower() for text in result.spoken))
    check("silence_does_not_reply", any(e.transcript == "" and e.spoken_after == e.spoken_before for e in result.events))
    check("followup_without_wake_allowed_after_wake_only", any(
        e.transcript == "what time is it" and e.spoken_after > e.spoken_before for e in result.events
    ))
    result.ok = not result.failed_checks


def default_transcripts() -> list[str]:
    return [
        "Ava",
        "what time is it",
        "Hey Ava, what is today?",
        "Ava, what time is it?",
        "Ava, who are you?",
        "Ava, why is the sky blue?",
        "",
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic AVA local voice turn acceptance")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument(
        "--server-reply",
        default="Blue light scatters more in the atmosphere, so the sky looks blue.",
    )
    args = parser.parse_args()

    result = _run_script(default_transcripts(), args.server_reply)
    payload = asdict(result)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"AVA local voice deterministic turn harness: {'PASS' if result.ok else 'FAIL'}")
        if result.spoken:
            print("spoken:")
            for text in result.spoken:
                print(f"  - {text}")
        if result.server_commands:
            print("server commands:")
            for text in result.server_commands:
                print(f"  - {text}")
        if result.failed_checks:
            print("failed checks:")
            for name in result.failed_checks:
                print(f"  - {name}")
    return 0 if result.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
