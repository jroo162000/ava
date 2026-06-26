"""Deterministic acceptance gate for the minimal local voice runner.

This validates the current local runner without live mic or speaker acoustics:
- use an existing clean WAV or synthesize one with Piper
- run ava_local_voice.py --input-wav
- capture stdout/stderr and the runner summary JSON
- fail if ASR, wake handling, command cleanup, local response, or TTS synthesis
  did not complete
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
LOCAL_RUNNER = ROOT / "ava_local_voice.py"
DEFAULT_PROMPT = "Hey Able, what time is it? Hey Able, what time is it?"
DEFAULT_EXPECTED_COMMAND = "what time is it"


def _timestamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(text or "").lower()).strip()


def _load_voice_config() -> dict[str, Any]:
    cfg_path = ROOT / "ava_voice_config.json"
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _wav_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as wf:
            return wf.getnframes() / float(max(1, wf.getframerate()))
    except Exception:
        return 0.0


def _command_matches(command: str, expected: str) -> bool:
    got = _normalize(command)
    want = _normalize(expected)
    if not want:
        return bool(got)
    if not got:
        return False
    if got == want:
        return True
    return want in got or got in want


def _prepare_input_wav(run_dir: Path, input_wav: str) -> Path:
    source = Path(str(input_wav or "")).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(f"Input WAV not found: {source}")
    if source.suffix.lower() != ".wav":
        raise ValueError(f"Input must be a WAV file: {source}")
    target = run_dir / "input.wav"
    if source != target:
        shutil.copy2(source, target)
    return target


def _build_prompt_wav(run_dir: Path, prompt_text: str) -> Path:
    from voice.tts.piper_bin import PiperBinTTS

    cfg = _load_voice_config()
    piper_cfg = ((cfg.get("local_fallback") or {}).get("piper") or {})
    exe = str(piper_cfg.get("exe") or (ROOT / "vendor" / "piper" / "piper.exe"))
    model = str(piper_cfg.get("model") or (ROOT / "vendor" / "piper" / "models" / "en_US-lessac-medium.onnx"))
    tts = PiperBinTTS(exe_path=exe, model_path=model)
    try:
        if not tts.warmup(timeout=8.0):
            raise RuntimeError("Piper warmup failed")
        pcm = bytearray()
        tts.speak(prompt_text, lambda chunk: pcm.extend(chunk), frame_ms=100)
        rate = int(getattr(tts, "current_sample_rate", 22050) or 22050)
        wav_path = run_dir / "input.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(bytes(pcm))
        return wav_path
    finally:
        try:
            tts.stop()
        except Exception:
            pass


def _parse_json_from_stdout(stdout: str) -> dict[str, Any]:
    for line in reversed(str(stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            return json.loads(line)
        except Exception:
            continue
    return {}


def _read_runner_summary(path: Path, stdout: str) -> dict[str, Any]:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return _parse_json_from_stdout(stdout)


def _run_local_voice_process(
    input_wav: Path,
    run_dir: Path,
    timeout_sec: float,
    playback: bool,
    *,
    live_loop: bool = False,
) -> dict[str, Any]:
    stdout_path = run_dir / "runner_stdout.log"
    stderr_path = run_dir / "runner_stderr.log"
    runner_summary_path = run_dir / "runner_summary.json"
    cmd = [
        sys.executable,
        str(LOCAL_RUNNER),
        "--live-input-wav" if live_loop else "--input-wav",
        str(input_wav),
        "--summary-json",
        str(runner_summary_path),
    ]
    if not playback:
        cmd.append("--no-playback")

    env = os.environ.copy()
    env.update(
        {
            "DISABLE_AUTONOMY": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=max(10.0, float(timeout_sec or 0.0)),
    )
    stdout_path.write_text(proc.stdout or "", encoding="utf-8")
    stderr_path.write_text(proc.stderr or "", encoding="utf-8")
    runner_summary = _read_runner_summary(runner_summary_path, proc.stdout or "")
    return {
        "cmd": cmd,
        "returncode": int(proc.returncode),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "runner_summary_path": str(runner_summary_path),
        "runner_summary": runner_summary,
    }


def score_acceptance(
    process_result: dict[str, Any],
    *,
    expected_command: str = DEFAULT_EXPECTED_COMMAND,
    expected_reply_contains: str = "",
) -> dict[str, Any]:
    runner_summary = dict(process_result.get("runner_summary") or {})
    reply = str(runner_summary.get("reply") or "")
    checks = {
        "process_exit_zero": int(process_result.get("returncode", -1)) == 0,
        "runner_accepted": bool(runner_summary.get("accepted")),
        "transcript_present": bool(str(runner_summary.get("transcript") or "").strip()),
        "command_matches_expected": _command_matches(str(runner_summary.get("command") or ""), expected_command),
        "reply_present": bool(reply.strip()),
        "tts_attempted": bool(runner_summary.get("tts_attempted")),
    }
    if expected_reply_contains:
        checks["reply_contains_expected"] = _normalize(expected_reply_contains) in _normalize(reply)
    failed = [name for name, ok in checks.items() if not ok]
    return {
        "ok": not failed,
        "checks": checks,
        "failed_checks": failed,
    }


def run_acceptance(
    *,
    prompt_text: str = DEFAULT_PROMPT,
    input_wav: str = "",
    expected_command: str = DEFAULT_EXPECTED_COMMAND,
    expected_reply_contains: str = "",
    output_dir: str = "",
    timeout_sec: float = 120.0,
    playback: bool = False,
    live_loop: bool = False,
) -> tuple[int, Path, dict[str, Any]]:
    run_dir = Path(output_dir).expanduser().resolve() if output_dir else (ROOT / f"tmp_local_input_wav_acceptance_{_timestamp()}").resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    if str(input_wav or "").strip():
        wav_path = _prepare_input_wav(run_dir, input_wav)
        input_source = str(Path(input_wav).expanduser().resolve())
    else:
        wav_path = _build_prompt_wav(run_dir, prompt_text)
        input_source = "piper_generated"

    process_result = _run_local_voice_process(wav_path, run_dir, timeout_sec, playback, live_loop=live_loop)
    score = score_acceptance(
        process_result,
        expected_command=expected_command,
        expected_reply_contains=expected_reply_contains,
    )
    summary = {
        "ok": bool(score["ok"]),
        "run_dir": str(run_dir),
        "input_wav": str(wav_path),
        "input_source": input_source,
        "input_seconds": _wav_seconds(wav_path),
        "prompt_text": prompt_text,
        "expected_command": expected_command,
        "expected_reply_contains": expected_reply_contains,
        "playback": bool(playback),
        "live_loop": bool(live_loop),
        "process": process_result,
        "score": score,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return (0 if score["ok"] else 2), run_dir, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run deterministic acceptance for ava_local_voice.py WAV input modes.")
    parser.add_argument("--prompt-text", default=DEFAULT_PROMPT)
    parser.add_argument("--input-wav", default="")
    parser.add_argument("--expected-command", default=DEFAULT_EXPECTED_COMMAND)
    parser.add_argument("--expected-reply-contains", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--playback", action="store_true", help="Allow actual speaker playback during the runner response.")
    parser.add_argument("--live-loop", action="store_true", help="Feed the WAV through the runner's live capture/VAD loop.")
    args = parser.parse_args(argv)

    code, _run_dir, summary = run_acceptance(
        prompt_text=args.prompt_text,
        input_wav=args.input_wav,
        expected_command=args.expected_command,
        expected_reply_contains=args.expected_reply_contains,
        output_dir=args.output_dir,
        timeout_sec=args.timeout,
        playback=bool(args.playback),
        live_loop=bool(args.live_loop),
    )
    print(json.dumps(summary, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
