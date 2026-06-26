from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from tools.voice_lab.session_acceptance_analyzer import (
        analyze_lines as _analyze_acceptance_lines,
        analyze_path as _analyze_acceptance_path,
    )
except Exception:
    _analyze_acceptance_lines = None
    _analyze_acceptance_path = None


APP_DIR = Path(__file__).resolve().parent
RUNNER = APP_DIR / "ava_standalone_realtime.py"
LOCAL_RUNNER = APP_DIR / "ava_local_voice.py"
PUSH_TO_TALK_RUNNER = APP_DIR / "tools" / "voice_lab" / "13_push_to_talk_once.py"
MIC_CALIBRATION_RUNNER = APP_DIR / "tools" / "voice_lab" / "14_mic_voice_calibration.py"
SPEAKER_MIC_PROBE_RUNNER = APP_DIR / "tools" / "voice_lab" / "15_multi_input_voice_probe.py"
LOCAL_INPUT_ACCEPTANCE_RUNNER = APP_DIR / "tools" / "voice_lab" / "16_local_input_wav_acceptance.py"
CONFIG_PATH = APP_DIR / "ava_voice_config.json"
SERVER_DIR = APP_DIR.parent / "ava-server"
SERVER_ENTRY = SERVER_DIR / "src" / "server.js"
LOG_ROOT = APP_DIR / "logs" / "realtime_ui"
STATE_PATH = LOG_ROOT / "state.json"
AVA_STARTUP_SCRIPT = APP_DIR / "ava_tray.pyw"

VOICE_TEST_PRESETS = {
    "normal": {
        "label": "Normal runtime",
        "prompt": "Start AVA normally.",
        "expect": "Use this when you are not running a focused voice test.",
    },
    "listen": {
        "label": "Listen-only mic test",
        "prompt": "Speak naturally without the wake word for 10 seconds.",
        "expect": "Expect mic debug frames, Vosk partials, and overheard/ignored text, but no AVA reply.",
    },
    "wake": {
        "label": "Wake-word test",
        "prompt": "Say: Hey Ava, are you listening? Then pause.",
        "expect": "Expect a final transcript containing the wake word and an audible reply.",
    },
    "tts": {
        "label": "TTS playback test",
        "prompt": "Say: Hey Ava, what time is it?",
        "expect": "Expect final transcript, brain/local intent response, tts-in, playback chunk, and audible speech.",
    },
    "roundtrip": {
        "label": "Full roundtrip test",
        "prompt": "Say: Hey Ava, tell me one sentence about your audio status.",
        "expect": "Expect ASR final, /respond brain call, TTS synthesis, playback, mic mute, and clean return to IDLE.",
    },
}


def _voice_test_preset(value: Any) -> str:
    key = str(value or "normal").strip().lower()
    return key if key in VOICE_TEST_PRESETS else "normal"


def _now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _parse_iso(value: str | None) -> _dt.datetime | None:
    if not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value)
    except Exception:
        return None


def _stamp() -> str:
    return _dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def _json_safe(obj: Any) -> Any:
    if isinstance(obj, Path):
        return str(obj)
    return obj


def _read_text(path: Path, max_bytes: int = 200_000) -> str:
    try:
        with path.open("rb") as f:
            if path.stat().st_size > max_bytes:
                f.seek(-max_bytes, os.SEEK_END)
            data = f.read()
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _tail_lines(path: Path, max_lines: int = 240, max_bytes: int = 300_000) -> list[str]:
    text = _read_text(path, max_bytes=max_bytes)
    return text.splitlines()[-max_lines:]


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _configured_input_defaults(config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config if isinstance(config, dict) else _load_json(CONFIG_PATH)
    audio = config.get("audio") if isinstance(config, dict) else {}
    audio = audio if isinstance(audio, dict) else {}
    device_value = audio.get("input_device")
    rate_value = audio.get("input_sample_rate")
    return {
        "device": _coerce_int(device_value, 14),
        "rate": _coerce_int(rate_value, 48000),
        "source": "ava_voice_config.json" if device_value is not None or rate_value is not None else "fallback",
        "device_name": str(audio.get("input_device_name") or ""),
    }


def _parse_json_stdout(stdout: str) -> dict[str, Any]:
    text = (stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except Exception:
            pass
    return {"ok": False, "raw_stdout": text[-4000:]}


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value or "").strip())
    return slug.strip("._")[:80] or "artifact"


def _debug_wav_metrics(path_value: Any) -> dict[str, Any]:
    path = Path(str(path_value or ""))
    if not path.exists():
        return {"exists": False, "error": "missing"}
    try:
        import wave
        from array import array

        with wave.open(str(path), "rb") as wf:
            channels = wf.getnchannels()
            rate = wf.getframerate()
            width = wf.getsampwidth()
            frames = wf.getnframes()
            data = wf.readframes(frames)
        metrics: dict[str, Any] = {
            "exists": True,
            "channels": channels,
            "rate": rate,
            "sample_width": width,
            "frames": frames,
            "seconds": round(frames / rate, 3) if rate else 0,
            "bytes": len(data),
        }
        if width == 2 and data:
            samples = array("h")
            samples.frombytes(data)
            if sys.byteorder != "little":
                samples.byteswap()
            if samples:
                metrics["rms"] = int((sum(int(v) * int(v) for v in samples) / len(samples)) ** 0.5)
                metrics["peak"] = max(abs(int(v)) for v in samples)
        return metrics
    except Exception as exc:
        return {"exists": True, "error": str(exc)}


def _enrich_debug_wavs(items: Any, limit: int = 12) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    enriched: list[dict[str, Any]] = []
    for item in items[-limit:]:
        if not isinstance(item, dict):
            continue
        copy = dict(item)
        copy["metrics"] = _debug_wav_metrics(copy.get("path"))
        enriched.append(copy)
    return enriched


def _format_debug_wav_issue(item: dict[str, Any]) -> str:
    metrics = item.get("metrics") if isinstance(item, dict) else {}
    metrics = metrics if isinstance(metrics, dict) else {}
    metric_bits = []
    if metrics.get("exists") is False:
        metric_bits.append("missing")
    elif metrics.get("seconds") is not None:
        metric_bits.append(f"{metrics.get('seconds')}s")
        if metrics.get("rms") is not None:
            metric_bits.append(f"rms={metrics.get('rms')}")
        if metrics.get("peak") is not None:
            metric_bits.append(f"peak={metrics.get('peak')}")
    suffix = f" ({', '.join(metric_bits)})" if metric_bits else ""
    return f"{item.get('reason', 'unknown')}: {item.get('path', '')}{suffix}"


def _http_get_json(url: str, timeout: float = 1.5) -> tuple[bool, Any, str]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ava-realtime-ui/1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(200_000).decode("utf-8", errors="replace")
            try:
                return True, json.loads(raw), ""
            except Exception:
                return True, raw[:500], ""
    except Exception as exc:
        return False, None, str(exc)


def _coerce_pid(value: Any) -> int | None:
    try:
        pid = int(value)
    except Exception:
        return None
    return pid if pid > 0 else None


def _pid_is_alive(pid: int | None) -> bool:
    pid = _coerce_pid(pid)
    if not pid:
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            process_query_limited_information = 0x1000
            synchronize = 0x00100000
            wait_timeout = 0x00000102
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            handle = kernel32.OpenProcess(
                process_query_limited_information | synchronize,
                False,
                pid,
            )
            if not handle:
                return False
            try:
                return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False
    return True


def _terminate_pid(pid: int, force: bool = False, timeout: float = 5.0) -> None:
    pid = int(pid)
    if os.name == "nt":
        cmd = ["taskkill", "/PID", str(pid), "/T"]
        if force:
            cmd.append("/F")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0 and _pid_is_alive(pid):
            message = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(message or f"taskkill failed for PID {pid}")
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    os.kill(pid, sig)


class RealtimeController:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.restored_pid: int | None = None
        self.discovery_attempted = False
        self.active_preset = "normal"
        self.session_dir: Path | None = None
        self.stdout_path: Path | None = None
        self.stderr_path: Path | None = None
        self.started_at: str | None = None
        self.stop_requested_at: str | None = None
        self.last_exit_code: int | None = None
        self.last_error: str | None = None
        self.launch_env: dict[str, str] = {}
        self.runner_mode = "local"
        LOG_ROOT.mkdir(parents=True, exist_ok=True)
        self._restore_state()

    def _restore_state(self) -> None:
        state = _load_json(STATE_PATH)
        if not state:
            return
        self.session_dir = Path(state["session_dir"]) if state.get("session_dir") else None
        self.stdout_path = Path(state["stdout_path"]) if state.get("stdout_path") else None
        self.stderr_path = Path(state["stderr_path"]) if state.get("stderr_path") else None
        self.started_at = state.get("started_at")
        self.last_exit_code = state.get("last_exit_code")
        self.last_error = state.get("last_error")
        self.launch_env = dict(state.get("launch_env") or {})
        self.runner_mode = str(state.get("runner_mode") or "local")
        pid = _coerce_pid(state.get("pid"))
        self.restored_pid = pid if pid and _pid_is_alive(pid) else None

    def _persist_state(self) -> None:
        LOG_ROOT.mkdir(parents=True, exist_ok=True)
        state = {
            "pid": self._current_pid(refresh=False),
            "session_dir": self.session_dir,
            "stdout_path": self.stdout_path,
            "stderr_path": self.stderr_path,
            "started_at": self.started_at,
            "stop_requested_at": self.stop_requested_at,
            "last_exit_code": self.last_exit_code,
            "last_error": self.last_error,
            "launch_env": self.launch_env,
            "runner_mode": self.runner_mode,
            "updated_at": _now_iso(),
        }
        STATE_PATH.write_text(json.dumps(state, indent=2, default=_json_safe), encoding="utf-8")

    def _runner_path(self, mode: str | None = None) -> Path:
        return LOCAL_RUNNER if (mode or self.runner_mode) == "local" else RUNNER

    def _discover_runner_pid(self) -> int | None:
        if os.name != "nt":
            return None
        runner_name = self._runner_path().name.lower()
        script = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.CommandLine -match 'ava_(local_voice|standalone_realtime)\\.py' } | "
            "Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress"
        )
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True,
                text=True,
                timeout=12.0,
            )
            if result.returncode != 0 or not result.stdout.strip():
                return None
            payload = json.loads(result.stdout)
        except Exception:
            return None
        rows = payload if isinstance(payload, list) else [payload]
        matches: list[tuple[str, int]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            pid = _coerce_pid(row.get("ProcessId"))
            command_line = str(row.get("CommandLine") or "").lower()
            if not pid or runner_name not in command_line:
                continue
            if _pid_is_alive(pid):
                matches.append((str(row.get("CreationDate") or ""), pid))
        if not matches:
            return None
        matches.sort(reverse=True)
        return matches[0][1]

    def _restored_or_discovered_pid(self, value: Any = None) -> int | None:
        pid = _coerce_pid(value)
        if pid and _pid_is_alive(pid):
            return pid
        self.discovery_attempted = True
        return self._discover_runner_pid()

    def _current_pid(self, refresh: bool = True) -> int | None:
        if self.proc and self.proc.poll() is None:
            return self.proc.pid
        if self.proc and self.proc.poll() is not None:
            self.last_exit_code = self.proc.poll()
            self.proc = None
        if self.restored_pid and _pid_is_alive(self.restored_pid):
            return self.restored_pid
        self.restored_pid = None
        if refresh and not self.discovery_attempted:
            self.discovery_attempted = True
            self.restored_pid = self._discover_runner_pid()
        return self.restored_pid

    def is_running(self) -> bool:
        with self._lock:
            return bool(self._current_pid())

    def start(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        options = options or {}
        preset_key = _voice_test_preset(options.get("test_preset"))
        runner_mode = str(options.get("runner_mode") or "local").strip().lower()
        if runner_mode not in {"local", "legacy"}:
            runner_mode = "local"
        runner_path = LOCAL_RUNNER if runner_mode == "local" else RUNNER
        runner_label = "Local Voice" if runner_mode == "local" else "Legacy Realtime"
        with self._lock:
            if self._current_pid():
                return {"ok": False, "message": "Realtime AVA is already running.", "status": self.status()}

            if not runner_path.exists():
                return {"ok": False, "message": f"Missing runner: {runner_path}"}

            session_dir = LOG_ROOT / f"session_{_stamp()}"
            session_dir.mkdir(parents=True, exist_ok=True)
            stdout_path = session_dir / "stdout.log"
            stderr_path = session_dir / "stderr.log"

            env = os.environ.copy()
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["DISABLE_AUTONOMY"] = "1"
            env["AVA_UI_TEST_PRESET"] = preset_key
            env["AVA_UI_TEST_LABEL"] = VOICE_TEST_PRESETS[preset_key]["label"]
            env["AVA_RUNNER_MODE"] = runner_mode
            env.setdefault("AVA_PLAYBACK_FRAME_MS", "100")
            env.setdefault("AVA_ASR_TRACE_THROTTLE_SEC", "0.75")
            env.setdefault("AVA_ASR_PREWAKE_RESCUE", "0")
            env.setdefault("AVA_TTS_CHUNKING", "0")
            env.setdefault("AVA_TTS_SEGMENTING", "0")
            self.active_preset = preset_key
            self.runner_mode = runner_mode
            if options.get("validation_mode"):
                env["VALIDATION_MODE"] = "1"
            if options.get("trace_asr", True):
                env["AVA_ASR_TRACE"] = "1"
                env["AVA_ASR_TRACE_DIR"] = str(session_dir)
            if options.get("disable_loopback_probe", True):
                env["AVA_LOOPBACK_PROBE"] = "0"
            for name in (
                "AVA_INPUT_DEVICE",
                "AVA_INPUT_DEVICE_NAME",
                "AVA_INPUT_SAMPLE_RATE",
                "AVA_OUTPUT_DEVICE",
                "AVA_OUTPUT_DEVICE_NAME",
                "AVA_PLAYBACK_RATE",
                "AVA_INPUT_WAV",
            ):
                if name in env and not options.get("preserve_device_env"):
                    env.pop(name, None)

            creationflags = 0
            if os.name == "nt":
                creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

            stdout_file = stdout_path.open("w", encoding="utf-8", errors="replace", buffering=1)
            stderr_file = stderr_path.open("w", encoding="utf-8", errors="replace", buffering=1)
            try:
                python_exe = os.environ.get("AVA_REALTIME_PYTHON")
                if not python_exe:
                    python_exe = "python" if os.name == "nt" else sys.executable
                self.proc = subprocess.Popen(
                    [python_exe, "-u", runner_path.name],
                    cwd=str(APP_DIR),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    text=True,
                    creationflags=creationflags,
                )
            except Exception as exc:
                stdout_file.close()
                stderr_file.close()
                self.last_error = str(exc)
                self._persist_state()
                return {"ok": False, "message": f"Failed to start {runner_label}: {exc}"}

            self.session_dir = session_dir
            self.stdout_path = stdout_path
            self.stderr_path = stderr_path
            self.started_at = _now_iso()
            self.stop_requested_at = None
            self.last_exit_code = None
            self.last_error = None
            self.restored_pid = None
            self.launch_env = {
                "DISABLE_AUTONOMY": env.get("DISABLE_AUTONOMY", ""),
                "VALIDATION_MODE": env.get("VALIDATION_MODE", ""),
                "PYTHONIOENCODING": env.get("PYTHONIOENCODING", ""),
                "AVA_ASR_TRACE": env.get("AVA_ASR_TRACE", ""),
                "AVA_ASR_TRACE_DIR": env.get("AVA_ASR_TRACE_DIR", ""),
                "AVA_ASR_TRACE_THROTTLE_SEC": env.get("AVA_ASR_TRACE_THROTTLE_SEC", ""),
                "AVA_ASR_PREWAKE_RESCUE": env.get("AVA_ASR_PREWAKE_RESCUE", ""),
                "AVA_LOOPBACK_PROBE": env.get("AVA_LOOPBACK_PROBE", ""),
                "AVA_PLAYBACK_FRAME_MS": env.get("AVA_PLAYBACK_FRAME_MS", ""),
                "AVA_TTS_CHUNKING": env.get("AVA_TTS_CHUNKING", ""),
                "AVA_TTS_SEGMENTING": env.get("AVA_TTS_SEGMENTING", ""),
                "AVA_RUNNER_MODE": env.get("AVA_RUNNER_MODE", ""),
                "AVA_REALTIME_PYTHON": python_exe,
            }
            self._persist_state()
            return {"ok": True, "message": f"{runner_label} started.", "status": self.status()}

    def stop(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            pid = self._current_pid()
            if not pid:
                self._persist_state()
                return {"ok": True, "message": "Realtime AVA is not running.", "status": self.status()}

            self.stop_requested_at = _now_iso()
            try:
                if self.proc and self.proc.poll() is None:
                    if force:
                        self.proc.kill()
                    else:
                        if os.name == "nt":
                            self.proc.terminate()
                        else:
                            self.proc.send_signal(signal.SIGTERM)
                    try:
                        self.last_exit_code = self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                        self.last_exit_code = self.proc.wait(timeout=5)
                else:
                    _terminate_pid(pid, force=force)
                    deadline = time.time() + 5.0
                    while _pid_is_alive(pid) and time.time() < deadline:
                        time.sleep(0.1)
                    if _pid_is_alive(pid):
                        _terminate_pid(pid, force=True)
                    self.last_exit_code = None
                self.proc = None
                self.restored_pid = None
                self._persist_state()
                return {"ok": True, "message": f"Realtime AVA stopped (PID {pid}).", "status": self.status()}
            except Exception as exc:
                self.last_error = str(exc)
                self._persist_state()
                return {"ok": False, "message": f"Failed to stop realtime AVA: {exc}", "status": self.status()}

    def restart(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        stopped = self.stop(force=bool((options or {}).get("force")))
        if not stopped.get("ok"):
            return stopped
        return self.start(options=options)

    def status(self) -> dict[str, Any]:
        with self._lock:
            pid = self._current_pid()
            running = bool(pid)
            started = _parse_iso(self.started_at)
            elapsed_seconds = None
            if running and started:
                elapsed_seconds = max(0, int((_dt.datetime.now().astimezone() - started).total_seconds()))
            return {
                "running": running,
                "runner_mode": self.runner_mode,
                "runner_name": LOCAL_RUNNER.name if self.runner_mode == "local" else RUNNER.name,
                "test_preset": self.active_preset,
                "test_preset_label": VOICE_TEST_PRESETS.get(self.active_preset, VOICE_TEST_PRESETS["normal"])["label"],
                "pid": pid,
                "started_at": self.started_at,
                "elapsed_seconds": elapsed_seconds,
                "stop_requested_at": self.stop_requested_at,
                "last_exit_code": self.last_exit_code,
                "last_error": self.last_error,
                "session_dir": str(self.session_dir) if self.session_dir else None,
                "stdout_path": str(self.stdout_path) if self.stdout_path else None,
                "stderr_path": str(self.stderr_path) if self.stderr_path else None,
                "launch_env": self.launch_env,
            }

    def log_snapshot(self, max_lines: int = 260) -> dict[str, Any]:
        with self._lock:
            stdout_path = self.stdout_path
            stderr_path = self.stderr_path
        stdout_lines = _tail_lines(stdout_path, max_lines=max_lines) if stdout_path else []
        stderr_lines = _tail_lines(stderr_path, max_lines=max_lines // 3) if stderr_path else []
        return {
            "stdout": stdout_lines,
            "stderr": stderr_lines,
            "stdout_path": str(stdout_path) if stdout_path else None,
            "stderr_path": str(stderr_path) if stderr_path else None,
        }


class BrainServerController:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.started_at: str | None = None
        self.stdout_path: Path | None = None
        self.stderr_path: Path | None = None
        self.last_error: str | None = None

    def _health_url(self, config: dict[str, Any] | None = None) -> str:
        url = "http://127.0.0.1:5051/health"
        if isinstance(config, dict):
            route = str(config.get("server_url", "") or "")
            if route:
                base = route.rsplit("/", 1)[0] if route.endswith(("/respond", "/chat")) else route
                url = base.rstrip("/") + "/health"
        return url

    def status(self, config: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            ui_running = bool(self.proc and self.proc.poll() is None)
            pid = self.proc.pid if self.proc else None
            exit_code = self.proc.poll() if self.proc else None
        url = self._health_url(config)
        up, payload, error = _http_get_json(url, timeout=1.0)
        return {
            "up": up,
            "url": url,
            "payload": payload,
            "error": error,
            "managed_by_ui": bool(ui_running),
            "pid": pid,
            "exit_code": exit_code,
            "started_at": self.started_at,
            "stdout_path": str(self.stdout_path) if self.stdout_path else None,
            "stderr_path": str(self.stderr_path) if self.stderr_path else None,
            "last_error": self.last_error,
            "server_dir": str(SERVER_DIR),
            "server_entry": str(SERVER_ENTRY),
        }

    def start(self) -> dict[str, Any]:
        config = _load_json(CONFIG_PATH)
        current = self.status(config)
        if current["up"] and not current["managed_by_ui"]:
            return {"ok": True, "message": "Brain server is already running outside the dashboard.", "status": current}
        with self._lock:
            if self.proc and self.proc.poll() is None:
                return {"ok": True, "message": "Brain server is already managed by the dashboard.", "status": self.status(config)}
            if not SERVER_ENTRY.exists():
                return {"ok": False, "message": f"Missing brain server entry: {SERVER_ENTRY}", "status": self.status(config)}

            session_dir = LOG_ROOT / f"brain_{_stamp()}"
            session_dir.mkdir(parents=True, exist_ok=True)
            stdout_path = session_dir / "stdout.log"
            stderr_path = session_dir / "stderr.log"
            stdout_file = stdout_path.open("w", encoding="utf-8", errors="replace", buffering=1)
            stderr_file = stderr_path.open("w", encoding="utf-8", errors="replace", buffering=1)
            env = os.environ.copy()
            env.setdefault("DISABLE_AUTONOMY", "1")
            creationflags = 0
            if os.name == "nt":
                creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            try:
                self.proc = subprocess.Popen(
                    ["node", "src/server.js"],
                    cwd=str(SERVER_DIR),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    text=True,
                    creationflags=creationflags,
                )
                self.started_at = _now_iso()
                self.stdout_path = stdout_path
                self.stderr_path = stderr_path
                self.last_error = None
            except Exception as exc:
                stdout_file.close()
                stderr_file.close()
                self.last_error = str(exc)
                return {"ok": False, "message": f"Failed to start brain server: {exc}", "status": self.status(config)}

        deadline = time.time() + 10.0
        final_status = self.status(config)
        while time.time() < deadline:
            final_status = self.status(config)
            if final_status["up"]:
                break
            time.sleep(0.35)
        return {"ok": final_status["up"], "message": "Brain server started." if final_status["up"] else "Brain server launched but did not answer /health yet.", "status": final_status}

    def stop(self) -> dict[str, Any]:
        config = _load_json(CONFIG_PATH)
        with self._lock:
            if not self.proc or self.proc.poll() is not None:
                return {"ok": True, "message": "No dashboard-managed brain server is running.", "status": self.status(config)}
            pid = self.proc.pid
            try:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
                return {"ok": True, "message": f"Dashboard-managed brain server stopped (PID {pid}).", "status": self.status(config)}
            except Exception as exc:
                self.last_error = str(exc)
                return {"ok": False, "message": f"Failed to stop brain server: {exc}", "status": self.status(config)}

    def log_snapshot(self, max_lines: int = 120) -> dict[str, Any]:
        with self._lock:
            stdout_path = self.stdout_path
            stderr_path = self.stderr_path
        return {
            "stdout": _tail_lines(stdout_path, max_lines=max_lines) if stdout_path else [],
            "stderr": _tail_lines(stderr_path, max_lines=max_lines // 2) if stderr_path else [],
            "stdout_path": str(stdout_path) if stdout_path else None,
            "stderr_path": str(stderr_path) if stderr_path else None,
        }


class LocalChecks:
    def run(self) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        started = time.time()

        def add(name: str, state: str, detail: str, command: str = "") -> None:
            checks.append({"name": name, "state": state, "detail": detail, "command": command})

        add("Local voice runner exists", "ok" if LOCAL_RUNNER.exists() else "bad", str(LOCAL_RUNNER))
        add("Legacy realtime runner exists", "ok" if RUNNER.exists() else "warn", str(RUNNER))
        add("Voice config exists", "ok" if CONFIG_PATH.exists() else "bad", str(CONFIG_PATH))
        config = _load_json(CONFIG_PATH)
        add("Voice config JSON", "ok" if config else "bad", "parsed" if config else "invalid or empty")

        files = [
            "ava_realtime_ui.py",
            "ava_local_voice.py",
            "ava_standalone_realtime.py",
            "ava_hybrid_asr.py",
            str(Path("tools") / "voice_lab" / "live_input_defaults.py"),
            str(Path("tools") / "voice_lab" / "16_local_input_wav_acceptance.py"),
            str(Path("voice") / "providers" / "local_hybrid.py"),
            str(Path("voice") / "tts" / "piper_bin.py"),
        ]
        cmd = [sys.executable, "-m", "py_compile", *files]
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(APP_DIR),
                capture_output=True,
                text=True,
                timeout=45,
            )
            add(
                "Python compile",
                "ok" if proc.returncode == 0 else "bad",
                (proc.stderr or proc.stdout or "compiled successfully").strip()[-1000:],
                " ".join(cmd),
            )
        except Exception as exc:
            add("Python compile", "bad", str(exc), " ".join(cmd))

        audio = config.get("audio", {}) if isinstance(config, dict) else {}
        fallback = config.get("local_fallback", {}) if isinstance(config, dict) else {}
        piper = fallback.get("piper", {}) if isinstance(fallback, dict) else {}
        piper_exe = Path(str(piper.get("exe") or ""))
        piper_model = Path(str(piper.get("model") or ""))
        add("Piper executable", "ok" if piper_exe.exists() else "warn", str(piper_exe) if str(piper_exe) != "." else "not configured")
        add("Piper model", "ok" if piper_model.exists() else "warn", str(piper_model) if str(piper_model) != "." else "not configured")

        vosk_root = APP_DIR / "vosk-models"
        vosk_models = [p for p in vosk_root.iterdir() if p.is_dir()] if vosk_root.exists() else []
        add("Vosk model directory", "ok" if vosk_models else "warn", f"{len(vosk_models)} model folder(s) under {vosk_root}")

        avoids = " ".join(str(x).lower() for x in audio.get("input_device_avoid", [])) if isinstance(audio, dict) else ""
        block = " ".join(str(x).lower() for x in audio.get("input_device_blocklist", [])) if isinstance(audio, dict) else ""
        add("Webcam mic avoidance", "ok" if ("webcam" in avoids + block or "c920e" in avoids + block) else "warn", "webcam/C920e avoided" if ("webcam" in avoids + block or "c920e" in avoids + block) else "webcam/C920e not explicitly avoided")

        brain = BRAIN.status(config)
        add("Brain server health", "ok" if brain["up"] else "warn", brain["url"] if brain["up"] else (brain["error"] or brain["url"]))

        try:
            import pyaudio  # type: ignore
            p = pyaudio.PyAudio()
            try:
                inputs = 0
                outputs = 0
                for idx in range(p.get_device_count()):
                    info = p.get_device_info_by_index(idx)
                    if int(info.get("maxInputChannels") or 0) > 0:
                        inputs += 1
                    if int(info.get("maxOutputChannels") or 0) > 0:
                        outputs += 1
                add("PyAudio devices", "ok" if inputs and outputs else "warn", f"{inputs} input(s), {outputs} output(s)")
            finally:
                p.terminate()
        except Exception as exc:
            add("PyAudio devices", "bad", str(exc))

        if LOCAL_INPUT_ACCEPTANCE_RUNNER.exists():
            acceptance_dir = LOG_ROOT / "checks" / f"local_input_wav_{time.strftime('%Y%m%d_%H%M%S')}"
            acceptance_cmd = [
                sys.executable,
                str(LOCAL_INPUT_ACCEPTANCE_RUNNER),
                "--expected-command",
                "what time is it",
                "--expected-reply-contains",
                "It's",
                "--output-dir",
                str(acceptance_dir),
                "--timeout",
                "140",
            ]
            try:
                proc = subprocess.run(
                    acceptance_cmd,
                    cwd=str(APP_DIR),
                    capture_output=True,
                    text=True,
                    timeout=170,
                )
                summary_path = acceptance_dir / "summary.json"
                summary = _load_json(summary_path)
                runner_summary = (((summary.get("process") or {}).get("runner_summary")) or {}) if isinstance(summary, dict) else {}
                score = (summary.get("score") or {}) if isinstance(summary, dict) else {}
                failed = score.get("failed_checks") or []
                accepted = bool(runner_summary.get("accepted"))
                command = str(runner_summary.get("command") or "")
                reply = str(runner_summary.get("reply") or "")
                detail = (
                    f"accepted={accepted} command={command!r} reply={reply!r} "
                    f"failed={len(failed)} artifact={summary_path}"
                )
                if proc.returncode != 0 and not failed:
                    detail = (proc.stderr or proc.stdout or detail).strip()[-1000:]
                add(
                    "Deterministic local voice pipeline",
                    "ok" if proc.returncode == 0 and bool(summary.get("ok")) else "bad",
                    detail,
                    " ".join(acceptance_cmd),
                )
            except Exception as exc:
                add("Deterministic local voice pipeline", "bad", str(exc), " ".join(acceptance_cmd))
        else:
            add("Deterministic local voice pipeline", "bad", f"missing: {LOCAL_INPUT_ACCEPTANCE_RUNNER}")

        try:
            live_status = CONTROLLER.status()
            stdout_path = live_status.get("stdout_path")
            if not live_status.get("running"):
                add("Live selected mic health", "warn", "not evaluated: realtime AVA is not running")
            elif _analyze_acceptance_path is None:
                add("Live selected mic health", "warn", "not evaluated: live acceptance analyzer is unavailable")
            elif not stdout_path or not Path(str(stdout_path)).exists():
                add("Live selected mic health", "warn", "not evaluated: active realtime stdout log is not available")
            else:
                analysis = _analyze_acceptance_path(Path(str(stdout_path)))
                acceptance = _acceptance_payload(analysis)
                warnings = [str(item) for item in (acceptance.get("warnings") or [])]
                capture_quality = acceptance.get("capture_quality") or {}
                capture_quality = capture_quality if isinstance(capture_quality, dict) else {}
                capture_state = str(capture_quality.get("state") or "")
                title = str(capture_quality.get("title") or "")
                detail = str(capture_quality.get("detail") or "")
                recommendation = str(capture_quality.get("recommendation") or "")
                if acceptance.get("ok") or int(acceptance.get("spoken_count") or 0) > 0:
                    add("Live selected mic health", "ok", "live spoken acceptance has produced an AVA reply")
                elif any("no vad speech_start" in warning.lower() for warning in warnings):
                    warning = next(w for w in warnings if "no vad speech_start" in w.lower())
                    add(
                        "Live selected mic health",
                        "warn",
                        (
                            "Selected mic is not hearing usable speech: "
                            f"{warning} Recommendation: run Mic Calibration or Probe Non-Webcam Inputs before changing ASR."
                        ),
                    )
                elif capture_state in {"no_speech", "brief_peaks", "captured_unaccepted", "captured_no_wake"}:
                    message = f"{title}: {detail}".strip(": ")
                    if recommendation:
                        message = f"{message} Recommendation: {recommendation}"
                    add("Live selected mic health", "warn", message or f"capture_quality={capture_state}")
                else:
                    add(
                        "Live selected mic health",
                        "warn",
                        "live spoken acceptance has not passed yet; use Mic Calibration or Probe Non-Webcam Inputs",
                    )
        except Exception as exc:
            add("Live selected mic health", "warn", f"not evaluated: {exc}")

        elapsed_ms = int((time.time() - started) * 1000)
        worst = "ok"
        if any(c["state"] == "bad" for c in checks):
            worst = "bad"
        elif any(c["state"] == "warn" for c in checks):
            worst = "warn"
        counts = {
            "ok": sum(1 for c in checks if c["state"] == "ok"),
            "warn": sum(1 for c in checks if c["state"] == "warn"),
            "bad": sum(1 for c in checks if c["state"] == "bad"),
            "total": len(checks),
        }
        return {
            "ok": worst == "ok",
            "state": worst,
            "elapsed_ms": elapsed_ms,
            "summary": counts,
            "checks": checks,
        }


class Diagnostics:
    ISSUE_PATTERNS = [
        ("critical", re.compile(r"Traceback|Fatal Python error|KeyboardInterrupt", re.I), "Python runtime error"),
        ("critical", re.compile(r"No suitable input device found|Mic open failed|no suitable input", re.I), "Microphone unavailable"),
        ("critical", re.compile(r"Failed to start provider|Unified voice session failed", re.I), "Voice provider failed"),
        ("warn", re.compile(r"Brain server isn't reachable|server.*not.*reachable|status=down", re.I), "Brain server unreachable"),
        ("warn", re.compile(r"Whisper timeout|whisper_timeout", re.I), "Whisper finalization timeout"),
        ("warn", re.compile(r"VOSK.*ERROR|Failed to process waveform", re.I), "Vosk recognition error"),
        ("warn", re.compile(r"Rejecting hot input|too noisy", re.I), "Noisy input rejected"),
        ("warn", re.compile(r"Calibration failed", re.I), "Audio calibration failed"),
        ("info", re.compile(r"Ignoring short transcript without wake word|overheard", re.I), "Wake gate ignored audio"),
    ]

    STATUS_MARKERS = {
        "server_up": re.compile(r"\[server\] Up|brain=.*status=up", re.I),
        "tts": re.compile(r"\[voice-unified\] TTS engine: (?P<value>.+)|\[local-voice\] tts=(?P<local_value>.+)|\[local-voice\] state=SPEAKING", re.I),
        "input": re.compile(r"\[audio\] Selected input: (?P<value>.+)|\[local-voice\] input=(?P<local_value>.+)", re.I),
        "output": re.compile(r"\[audio\] Using output device: (?P<value>.+)|\[local-voice\] output_rate=(?P<local_value>.+)", re.I),
        "asr_vosk": re.compile(r"\[hybrid-asr\].*VOSK loaded|VOSK loaded|\[local-voice\] wake_gate=vosk", re.I),
        "asr_whisper": re.compile(r"\[hybrid-asr\].*Whisper loaded|Whisper loaded|\[local-voice\] loading_whisper=", re.I),
        "wake_gate": re.compile(r"\[local-voice\] wake_gate=(?P<local_value>[^\s]+)", re.I),
        "mic_loop": re.compile(r"\[voice-unified\] Mic loop started|\[local-voice\] state=LISTENING", re.I),
        "session_active": re.compile(r"Unified voice session active|\[local-voice\] ready", re.I),
        "final": re.compile(r"\[FINAL -> DECIDE\] (?P<value>.+)|\[local-voice\] asr_final=(?P<local_value>.+)", re.I),
        "tts_in": re.compile(r"\[tts-in\].*preview='(?P<value>.*?)'|\[local-voice\] state=SPEAKING text=(?P<local_value>.+)", re.I),
    }

    def __init__(self, controller: RealtimeController) -> None:
        self.controller = controller
        self._ava_startup_cache: dict[str, Any] | None = None
        self._ava_startup_cache_at = 0.0

    def run(self) -> dict[str, Any]:
        status = self.controller.status()
        logs = self.controller.log_snapshot(max_lines=420)
        config = _load_json(CONFIG_PATH)
        all_lines = logs["stdout"] + logs["stderr"]
        parsed = self._parse_logs(all_lines)
        acceptance = self._acceptance_status(status)
        parsed = self._merge_acceptance_into_parsed(parsed, acceptance)
        issues = self._issues_from_logs(all_lines)
        issues.extend(self._runtime_state_issues(status, all_lines, parsed))
        issues.extend(self._acceptance_runtime_issues(acceptance))
        issues.extend(self._static_issues(config))

        brain = BRAIN.status(config)
        if not brain["up"]:
            issues.append({
                "level": "warn",
                "title": "Brain server is not reachable",
                "detail": brain["error"] or "No response from /health.",
                "source": "http://127.0.0.1:5051/health",
            })

        ava_startup = self._ava_startup_status()
        if ava_startup["running"]:
            issues.append({
                "level": "warn",
                "title": "AVA Startup conflict is running",
                "detail": "Legacy tray AVA can compete for the microphone.",
                "source": "ava_tray.pyw",
            })

        cards = self._cards(status, parsed, brain, ava_startup, acceptance)
        return {
            "generated_at": _now_iso(),
            "status": status,
            "cards": cards,
            "issues": self._dedupe_issues(issues),
            "parsed": parsed,
            "acceptance": acceptance,
            "brain": brain,
            "brain_logs": BRAIN.log_snapshot(),
            "ava_startup": ava_startup,
            "config_summary": self._config_summary(config),
            "logs": logs,
        }

    def _acceptance_status(self, status: dict[str, Any]) -> dict[str, Any]:
        stdout_path = status.get("stdout_path")
        if not stdout_path:
            return {"ok": False, "available": False, "error": "No active stdout log path."}
        path = Path(str(stdout_path))
        if not path.exists():
            return {"ok": False, "available": False, "path": str(path), "error": "Session stdout log does not exist yet."}
        if _analyze_acceptance_path is None:
            return {"ok": False, "available": False, "path": str(path), "error": "Acceptance analyzer is not importable."}
        try:
            analysis = _analyze_acceptance_path(path)
            return _acceptance_payload(analysis)
        except Exception as exc:
            return {"ok": False, "available": False, "path": str(path), "error": str(exc)}

    def _parse_logs(self, lines: list[str]) -> dict[str, Any]:
        parsed: dict[str, Any] = {
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
        for line in lines:
            for key, pattern in self.STATUS_MARKERS.items():
                m = pattern.search(line)
                if not m:
                    continue
                if key in {"tts", "input", "output", "wake_gate"}:
                    value = m.groupdict().get("value") or m.groupdict().get("local_value") or "local"
                    parsed[key] = value.strip()
                elif key == "final":
                    value = m.groupdict().get("value") or m.groupdict().get("local_value") or ""
                    parsed["last_final"] = value.strip()
                elif key == "tts_in":
                    value = m.groupdict().get("value") or m.groupdict().get("local_value") or ""
                    parsed["last_tts"] = value.strip()
                else:
                    parsed[key] = True
        return parsed

    def _merge_acceptance_into_parsed(self, parsed: dict[str, Any], acceptance: dict[str, Any]) -> dict[str, Any]:
        merged = dict(parsed)
        if not acceptance.get("available"):
            return merged
        if acceptance.get("input") and not merged.get("input"):
            merged["input"] = acceptance.get("input")
        if acceptance.get("tts") and not merged.get("tts"):
            merged["tts"] = acceptance.get("tts")
        if acceptance.get("asr"):
            merged["asr_whisper"] = True
        if acceptance.get("ready"):
            merged["session_active"] = True
        if acceptance.get("listening_seen"):
            merged["mic_loop"] = True
        finals = acceptance.get("final_transcripts") or []
        if finals and not merged.get("last_final"):
            merged["last_final"] = finals[-1]
        return merged

    def _issues_from_logs(self, lines: list[str]) -> list[dict[str, str]]:
        issues: list[dict[str, str]] = []
        for line in lines[-300:]:
            for level, pattern, title in self.ISSUE_PATTERNS:
                if pattern.search(line):
                    issues.append({
                        "level": level,
                        "title": title,
                        "detail": line[-500:],
                        "source": "runtime log",
                    })
        return issues[-40:]

    def _runtime_state_issues(
        self,
        status: dict[str, Any],
        lines: list[str],
        parsed: dict[str, Any],
    ) -> list[dict[str, str]]:
        issues: list[dict[str, str]] = []
        if not status.get("running"):
            return issues
        elapsed = int(status.get("elapsed_seconds") or 0)
        line_count = len(lines)
        if elapsed >= 35 and line_count <= 3 and not parsed.get("mic_loop"):
            last_line = lines[-1] if lines else "No stdout/stderr has been captured yet."
            issues.append({
                "level": "warn",
                "title": "Realtime startup appears stalled",
                "detail": (
                    f"Process has been running for {elapsed}s but only emitted {line_count} log line(s). "
                    f"Last line: {last_line}"
                ),
                "source": "dashboard process monitor",
            })
        elif elapsed >= 70 and not parsed.get("mic_loop") and not parsed.get("session_active"):
            issues.append({
                "level": "warn",
                "title": "Realtime startup has not reached mic loop",
                "detail": f"Process has been running for {elapsed}s without a mic-loop/session-active marker.",
                "source": "runtime log markers",
            })
        return issues

    def _acceptance_runtime_issues(self, acceptance: dict[str, Any]) -> list[dict[str, str]]:
        if not acceptance.get("available") or acceptance.get("ok"):
            return []
        warnings = [str(item) for item in (acceptance.get("warnings") or [])]
        issues: list[dict[str, str]] = []
        capture_quality = acceptance.get("capture_quality") or {}
        has_capture_quality = isinstance(capture_quality, dict) and bool(capture_quality)
        for warning in warnings:
            lower = warning.lower()
            if "no vad speech_start" in lower:
                issues.append({
                    "level": "warn",
                    "title": "No live speech crossed VAD",
                    "detail": warning,
                    "source": "live acceptance analyzer",
                })
            elif "only brief mic peaks crossed vad" in lower:
                issues.append({
                    "level": "warn",
                    "title": "Mic peaks are too brief for VAD",
                    "detail": warning,
                    "source": "live acceptance analyzer",
                })
            elif (
                not has_capture_quality
                and ("ignored no-wake transcripts" in lower or "wake-gated no-wake utterances" in lower)
            ):
                issues.append({
                    "level": "warn",
                    "title": "No wake-qualified command reached AVA",
                    "detail": warning,
                    "source": "live acceptance analyzer",
                })
            elif "vad captured speech-like audio" in lower:
                issues.append({
                    "level": "warn",
                    "title": "VAD captured audio but ASR did not accept it",
                    "detail": warning,
                    "source": "live acceptance analyzer",
                })
            elif "whisper returned empty transcripts" in lower:
                issues.append({
                    "level": "warn",
                    "title": "Whisper returned empty transcripts",
                    "detail": warning,
                    "source": "live acceptance analyzer",
                })
        spoken = int(acceptance.get("spoken_count") or 0)
        final_count = int(acceptance.get("final_count") or 0)
        ignored_no_wake = int(acceptance.get("ignored_no_wake") or 0)
        ignored_wake_gate = int(acceptance.get("ignored_wake_gate_no_wake") or 0)
        if has_capture_quality:
            title = str(capture_quality.get("title") or "Capture quality verdict")
            detail = str(capture_quality.get("detail") or "")
            recommendation = str(capture_quality.get("recommendation") or "")
            if recommendation:
                detail = f"{detail}\nRecommendation: {recommendation}"
            if not any(issue.get("title") == title for issue in issues):
                issues.append({
                    "level": "warn",
                    "title": title,
                    "detail": detail,
                    "source": "capture quality verdict",
                })
        if not has_capture_quality and spoken == 0 and (final_count or ignored_no_wake or ignored_wake_gate):
            title = "No wake-qualified command reached AVA"
            if not any(issue.get("title") == title for issue in issues):
                issues.append({
                    "level": "warn",
                    "title": title,
                    "detail": (
                        f"Captured {final_count} Whisper final transcript(s), "
                        f"ignored_no_wake={ignored_no_wake}, "
                        f"wake_gate_blocks={ignored_wake_gate}, spoken_replies=0."
                    ),
                    "source": "live acceptance analyzer",
                })
        debug_wavs = acceptance.get("debug_wavs") or []
        if isinstance(debug_wavs, list) and debug_wavs:
            recent = [
                _format_debug_wav_issue(item)
                for item in debug_wavs[-4:]
                if isinstance(item, dict)
            ]
            issues.append({
                "level": "info",
                "title": "Failed-turn WAV artifacts available",
                "detail": "\n".join(recent),
                "source": "live acceptance analyzer",
            })
        return issues

    def _static_issues(self, config: dict[str, Any]) -> list[dict[str, str]]:
        issues: list[dict[str, str]] = []
        if not RUNNER.exists():
            issues.append({"level": "critical", "title": "Realtime runner missing", "detail": str(RUNNER), "source": "filesystem"})
        if not CONFIG_PATH.exists():
            issues.append({"level": "warn", "title": "Voice config missing", "detail": str(CONFIG_PATH), "source": "filesystem"})
        if CONFIG_PATH.exists() and not config:
            issues.append({"level": "critical", "title": "Voice config is not valid JSON", "detail": str(CONFIG_PATH), "source": "config"})

        audio = config.get("audio") if isinstance(config, dict) else {}
        if isinstance(audio, dict):
            avoids = " ".join(str(x).lower() for x in audio.get("input_device_avoid", []))
            block = " ".join(str(x).lower() for x in audio.get("input_device_blocklist", []))
            if "webcam" not in avoids + " " + block and "c920e" not in avoids + " " + block:
                issues.append({
                    "level": "warn",
                    "title": "Webcam mic is not explicitly avoided",
                    "detail": "Config should block or penalize webcam/C920e inputs for this setup.",
                    "source": "ava_voice_config.json",
                })
            if audio.get("loopback_probe", {}).get("enabled") is True:
                issues.append({
                    "level": "warn",
                    "title": "Loopback probe is enabled",
                    "detail": "The loopback probe previously blocked valid fallback input selection.",
                    "source": "ava_voice_config.json",
                })
        return issues

    def _brain_status(self, config: dict[str, Any]) -> dict[str, Any]:
        url = "http://127.0.0.1:5051/health"
        if isinstance(config, dict):
            route = str(config.get("server_url", "") or "")
            if route:
                base = route.rsplit("/", 1)[0] if route.endswith(("/respond", "/chat")) else route
                url = base.rstrip("/") + "/health"
        up, payload, error = _http_get_json(url, timeout=1.25)
        return {"up": up, "url": url, "payload": payload, "error": error}

    def _ava_startup_status(self) -> dict[str, Any]:
        now = time.time()
        if self._ava_startup_cache is not None and (now - self._ava_startup_cache_at) < 15.0:
            return self._ava_startup_cache
        if os.name != "nt":
            result = {"running": False, "matches": [], "error": ""}
            self._ava_startup_cache = result
            self._ava_startup_cache_at = now
            return result
        cmd = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.CommandLine -match 'ava_tray\\.pyw' } | "
            "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        )
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
                capture_output=True,
                text=True,
                timeout=1.25,
            )
            raw = (proc.stdout or "").strip()
            if not raw:
                result = {"running": False, "matches": [], "error": proc.stderr.strip()[:300]}
                self._ava_startup_cache = result
                self._ava_startup_cache_at = now
                return result
            data = json.loads(raw)
            matches = data if isinstance(data, list) else [data]
            result = {"running": bool(matches), "matches": matches, "error": ""}
            self._ava_startup_cache = result
            self._ava_startup_cache_at = now
            return result
        except Exception as exc:
            result = {"running": False, "matches": [], "error": str(exc)}
            self._ava_startup_cache = result
            self._ava_startup_cache_at = now
            return result

    def _config_summary(self, config: dict[str, Any]) -> dict[str, Any]:
        audio = config.get("audio", {}) if isinstance(config, dict) else {}
        validation = config.get("validation_mode", {}) if isinstance(config, dict) else {}
        fallback = config.get("local_fallback", {}) if isinstance(config, dict) else {}
        return {
            "voice_mode": config.get("voice_mode") if isinstance(config, dict) else None,
            "server_route": config.get("server_route") if isinstance(config, dict) else None,
            "input_device": audio.get("input_device"),
            "input_device_name": audio.get("input_device_name"),
            "input_sample_rate": audio.get("input_sample_rate"),
            "output_device_name": audio.get("output_device_name"),
            "playback_rate": audio.get("playback_rate"),
            "loopback_probe_enabled": (audio.get("loopback_probe") or {}).get("enabled") if isinstance(audio, dict) else None,
            "validation_enabled": validation.get("enabled"),
            "wake_words": validation.get("wake_words"),
            "tts_engine": fallback.get("tts_engine"),
            "whisper_model": fallback.get("whisper_model"),
        }

    def _cards(
        self,
        status: dict[str, Any],
        parsed: dict[str, Any],
        brain: dict[str, Any],
        ava_startup: dict[str, Any],
        acceptance: dict[str, Any],
    ) -> list[dict[str, str]]:
        def card(name: str, ok: bool, detail: str, warn: bool = False) -> dict[str, str]:
            return {
                "name": name,
                "state": "warn" if warn and not ok else "ok" if ok else "bad",
                "detail": detail,
            }

        common = [
            card("Realtime process", bool(status["running"]), f"{status.get('runner_name', 'runner')} | PID {status['pid']}" if status["running"] else "Stopped"),
            card("Log flow", bool(status["running"] and (parsed["mic_loop"] or parsed["session_active"] or parsed["input"] or parsed["output"])), f"{status.get('elapsed_seconds') or 0}s elapsed" if status["running"] else "No active child"),
            card("Brain server", bool(brain["up"]), f"{brain['url']} | PID {brain['pid']}" if brain.get("pid") else brain["url"]),
        ]
        if status.get("runner_mode") == "local":
            asr_detail = "Whisper final"
            if parsed.get("wake_gate") == "vosk":
                asr_detail += " + Vosk wake gate"
            elif parsed.get("wake_gate"):
                asr_detail += f" + wake gate {parsed['wake_gate']}"
            else:
                asr_detail += "-only"
            acceptance_ok = bool(acceptance.get("ok"))
            acceptance_ready = bool(acceptance.get("available") and acceptance.get("ready"))
            mic_loop_ready = bool(parsed["mic_loop"] or acceptance.get("listening_seen"))
            session_ready = bool(parsed["session_active"] or acceptance_ready or acceptance.get("listening_seen"))
            asr_ready = bool(parsed["asr_whisper"] or acceptance.get("asr"))
            tts_ready = bool(parsed["tts"] or acceptance.get("tts"))
            capture_quality = acceptance.get("capture_quality") if isinstance(acceptance, dict) else {}
            capture_quality = capture_quality if isinstance(capture_quality, dict) else {}
            capture_state = str(capture_quality.get("state") or "")
            input_health_states = {"no_speech", "brief_peaks"}
            voice_input_healthy = capture_state not in input_health_states
            voice_session_ok = bool(session_ready and voice_input_healthy)
            if capture_state == "no_speech":
                voice_session_detail = "Selected mic is not hearing usable speech"
            elif capture_state == "brief_peaks":
                voice_session_detail = "Selected mic hears only brief transient peaks"
            else:
                voice_session_detail = "Local voice runner ready" if session_ready else "No local ready marker"
            if asr_ready and acceptance.get("asr") and not parsed["asr_whisper"]:
                asr_detail = f"Whisper final ({acceptance['asr']})"
                if parsed.get("wake_gate"):
                    asr_detail += f" + {parsed['wake_gate']} wake gate"
            tts_detail = str(parsed["tts"] or acceptance.get("tts") or "Waiting for Piper marker")
            if acceptance_ok:
                acceptance_detail = "PASS"
            elif acceptance.get("available"):
                failed = len(acceptance.get("failed_checks") or [])
                spoken = int(acceptance.get("spoken_count") or 0)
                warnings = acceptance.get("warnings") or []
                if warnings and not spoken:
                    acceptance_detail = str(warnings[0])[:140]
                else:
                    acceptance_detail = f"Not passed yet | {failed} failed check(s), {spoken} spoken replies"
            else:
                acceptance_detail = str(acceptance.get("error") or "No analyzer result")
            return common + [
                card("Microphone loop", mic_loop_ready, "Local listen loop active" if mic_loop_ready else "Waiting for local listen loop"),
                card("Voice session", voice_session_ok, voice_session_detail, warn=bool(session_ready and not voice_input_healthy)),
                card("ASR", asr_ready, asr_detail if asr_ready else "Waiting for Whisper marker"),
                card("TTS", tts_ready, tts_detail),
                card("Live acceptance", acceptance_ok, acceptance_detail, warn=True),
                card("AVA Startup", not ava_startup["running"], "Legacy tray not running" if not ava_startup["running"] else "Legacy tray is running", warn=True),
            ]
        return common + [
            card("Microphone loop", bool(parsed["mic_loop"]), "Mic loop started" if parsed["mic_loop"] else "Waiting for mic loop"),
            card("Voice session", bool(parsed["session_active"]), "Hybrid ASR session active" if parsed["session_active"] else "No active session marker"),
            card("Vosk", bool(parsed["asr_vosk"]), "Loaded" if parsed["asr_vosk"] else "No loaded marker yet"),
            card("Whisper", bool(parsed["asr_whisper"]), "Loaded" if parsed["asr_whisper"] else "No loaded marker yet"),
            card("TTS", bool(parsed["tts"]), str(parsed["tts"] or "No TTS marker yet")),
            card("AVA Startup", not ava_startup["running"], "Legacy tray not running" if not ava_startup["running"] else "Legacy tray is running", warn=True),
        ]

    def _dedupe_issues(self, issues: list[dict[str, str]]) -> list[dict[str, str]]:
        seen: set[tuple[str, str, str]] = set()
        out: list[dict[str, str]] = []
        severity = {"critical": 0, "bad": 1, "warn": 2, "info": 3}
        for item in issues:
            key = (item.get("level", ""), item.get("title", ""), item.get("detail", ""))
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        out.sort(key=lambda x: severity.get(x.get("level", "info"), 9))
        return out[:60]

    def audio_devices(self) -> dict[str, Any]:
        try:
            import pyaudio  # type: ignore
        except Exception as exc:
            return {"ok": False, "error": f"PyAudio unavailable: {exc}", "devices": []}

        devices = []
        p = pyaudio.PyAudio()
        try:
            for idx in range(p.get_device_count()):
                info = p.get_device_info_by_index(idx)
                devices.append({
                    "index": idx,
                    "name": info.get("name"),
                    "host_api": info.get("hostApi"),
                    "max_input_channels": info.get("maxInputChannels"),
                    "max_output_channels": info.get("maxOutputChannels"),
                    "default_sample_rate": info.get("defaultSampleRate"),
                })
        finally:
            p.terminate()
        return {"ok": True, "error": "", "devices": devices}


CONTROLLER = RealtimeController()
BRAIN = BrainServerController()
CHECKS = LocalChecks()
DIAGNOSTICS = Diagnostics(CONTROLLER)


def _acceptance_payload(analysis: Any) -> dict[str, Any]:
    payload = asdict(analysis)
    payload["debug_wavs"] = _enrich_debug_wavs(payload.get("debug_wavs") or [])
    payload["ok"] = analysis.ok
    payload["available"] = True
    payload["spoken_count"] = len(analysis.spoken_replies)
    payload["final_count"] = len(analysis.final_transcripts)
    return payload


def _live_window_outcome(analysis: Any) -> tuple[str, str]:
    if analysis.spoken_replies:
        return "pass", f"Spoken reply observed: {analysis.spoken_replies[-1]}"
    if analysis.ignored_no_wake or analysis.ignored_wake_gate_no_wake:
        return (
            "no_wake",
            f"Captured speech did not contain a wake-qualified command: "
            f"ignored_no_wake={analysis.ignored_no_wake}, wake_gate_blocks={analysis.ignored_wake_gate_no_wake}",
        )
    if analysis.final_transcripts:
        return "no_reply", f"ASR final observed but no spoken reply: {analysis.final_transcripts[-1]}"
    if analysis.speech_starts:
        return "asr_missing", f"VAD captured speech-like audio {analysis.speech_starts} time(s), but no ASR final was accepted."
    if analysis.mic_idle_count:
        if analysis.vad_start is not None and analysis.mic_idle_peak_max >= analysis.vad_start:
            return (
                "brief_peaks",
                f"Only brief mic peaks crossed VAD: max idle peak {analysis.mic_idle_peak_max} vs vad_start {analysis.vad_start}.",
            )
        if analysis.vad_start is not None:
            return (
                "no_speech",
                f"No live speech crossed VAD: max idle peak {analysis.mic_idle_peak_max} vs vad_start {analysis.vad_start}.",
            )
    return "no_activity", "No new live voice activity was observed in this log window."


def _live_acceptance_window(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    status = CONTROLLER.status()
    stdout_path = status.get("stdout_path")
    if not stdout_path:
        return {"ok": False, "state": "unavailable", "message": "No active stdout log path.", "status": status}
    path = Path(str(stdout_path))
    if not path.exists():
        return {"ok": False, "state": "unavailable", "message": "Session stdout log does not exist yet.", "path": str(path), "status": status}
    size = path.stat().st_size
    marker = {"path": str(path), "offset": size, "created_at": _now_iso()}
    if payload.get("offset") is None:
        return {
            "ok": True,
            "state": "marked",
            "message": "Live acceptance window marked. Speak now, then analyze with this offset.",
            "marker": marker,
            "status": status,
        }
    if _analyze_acceptance_lines is None:
        return {"ok": False, "state": "unavailable", "message": "Acceptance analyzer is not importable.", "marker": marker, "status": status}
    try:
        offset = max(0, min(int(payload.get("offset")), size))
    except Exception:
        offset = 0
    with path.open("rb") as handle:
        handle.seek(offset)
        data = handle.read()
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    analysis = _analyze_acceptance_lines(lines, f"{path}@{offset}:{size}")
    state, message = _live_window_outcome(analysis)
    return {
        "ok": state == "pass",
        "state": state,
        "message": message,
        "marker": marker,
        "start_offset": offset,
        "end_offset": size,
        "bytes_read": len(data),
        "line_count": len(lines),
        "analysis": _acceptance_payload(analysis),
        "status": status,
    }


def _direct_local_voice_selftest(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if not LOCAL_INPUT_ACCEPTANCE_RUNNER.exists():
        return {
            "ok": False,
            "state": "unavailable",
            "message": f"Missing deterministic local voice acceptance runner: {LOCAL_INPUT_ACCEPTANCE_RUNNER}",
        }

    prompt_text = str(payload.get("prompt_text") or "Hey Able, what time is it? Hey Able, what time is it?")
    expected_command = str(payload.get("expected_command") or "what time is it")
    expected_reply_contains = str(payload.get("expected_reply_contains") or "It's")
    try:
        timeout_sec = max(30.0, min(float(payload.get("timeout") or 140.0), 240.0))
    except Exception:
        timeout_sec = 140.0

    run_dir = LOG_ROOT / "direct_selftests" / f"local_input_wav_{time.strftime('%Y%m%d_%H%M%S')}"
    cmd = [
        sys.executable or "python",
        "-u",
        str(LOCAL_INPUT_ACCEPTANCE_RUNNER),
        "--live-loop",
        "--prompt-text",
        prompt_text,
        "--expected-command",
        expected_command,
        "--expected-reply-contains",
        expected_reply_contains,
        "--output-dir",
        str(run_dir),
        "--timeout",
        f"{timeout_sec:g}",
    ]
    if bool(payload.get("playback")):
        cmd.append("--playback")

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            timeout=timeout_sec + 35.0,
        )
        summary = _parse_json_stdout(proc.stdout)
        if not summary:
            summary = _load_json(run_dir / "summary.json")
        runner_summary = ((summary.get("process") or {}).get("runner_summary") or {}) if isinstance(summary, dict) else {}
        score = (summary.get("score") or {}) if isinstance(summary, dict) else {}
        failed = score.get("failed_checks") or []
        accepted = bool(runner_summary.get("accepted"))
        command = str(runner_summary.get("command") or "")
        reply = str(runner_summary.get("reply") or "")
        ok = proc.returncode == 0 and bool(summary.get("ok"))
        state = "pass" if ok else "fail"
        if ok:
            mode = str(runner_summary.get("mode") or "live_input_wav")
            message = f"Direct local voice path ({mode}) accepted {command!r} and replied {reply!r}."
            recommendation = (
                "The local capture loop, ASR, wake cleanup, response, and TTS synthesis path is healthy on clean WAV input. "
                "If live mic still fails, focus on capture hardware, acoustic quality, or wake qualification."
            )
        else:
            message = (
                f"Direct local voice path failed: accepted={accepted}, command={command!r}, "
                f"reply={reply!r}, failed_checks={failed}."
            )
            recommendation = "Fix the local runner/ASR/TTS path before spending more time on physical mic diagnostics."
        return {
            "ok": ok,
            "state": state,
            "message": message,
            "recommendation": recommendation,
            "returncode": proc.returncode,
            "summary": summary,
            "runner_summary": runner_summary,
            "score": score,
            "stderr": proc.stderr[-4000:],
            "command": cmd,
            "run_dir": str(run_dir),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "state": "timeout",
            "message": "Direct local voice self-test timed out.",
            "recommendation": "Check whether Piper, Whisper, or the local voice runner is hung before testing live audio again.",
            "stderr": str(exc),
            "command": cmd,
            "run_dir": str(run_dir),
        }
    except Exception as exc:
        return {
            "ok": False,
            "state": "error",
            "message": f"Direct local voice self-test failed to run: {exc}",
            "recommendation": "Fix the acceptance runner invocation before relying on live mic tests.",
            "command": cmd,
            "run_dir": str(run_dir),
        }


def _failed_wav_intelligibility(runner_summary: dict[str, Any]) -> str:
    if bool(runner_summary.get("accepted")):
        return "accepted_command"
    if str(runner_summary.get("transcript") or "").strip():
        return "heard_but_unaccepted"
    reason = str(runner_summary.get("ignored_reason") or "")
    if reason == "empty_transcript" or not str(runner_summary.get("transcript") or "").strip():
        return "empty_or_unintelligible"
    return "unaccepted"


def _analyze_failed_turn_wavs(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if _analyze_acceptance_path is None:
        return {"ok": False, "state": "unavailable", "message": "Acceptance analyzer is not importable."}
    if not LOCAL_INPUT_ACCEPTANCE_RUNNER.exists():
        return {
            "ok": False,
            "state": "unavailable",
            "message": f"Missing deterministic local voice acceptance runner: {LOCAL_INPUT_ACCEPTANCE_RUNNER}",
        }

    status = CONTROLLER.status()
    stdout_path = status.get("stdout_path")
    if not stdout_path:
        return {"ok": False, "state": "unavailable", "message": "No active stdout log path.", "status": status}
    path = Path(str(stdout_path))
    if not path.exists():
        return {"ok": False, "state": "unavailable", "message": "Session stdout log does not exist yet.", "path": str(path), "status": status}

    try:
        limit = max(1, min(int(payload.get("limit") or 3), 6))
    except Exception:
        limit = 3
    try:
        timeout_sec = max(25.0, min(float(payload.get("timeout") or 90.0), 180.0))
    except Exception:
        timeout_sec = 90.0
    expected_command = str(payload.get("expected_command") or "what time is it")
    expected_reply_contains = str(payload.get("expected_reply_contains") or "")

    analysis = _analyze_acceptance_path(path)
    acceptance = _acceptance_payload(analysis)
    debug_wavs = [item for item in (acceptance.get("debug_wavs") or []) if isinstance(item, dict)]
    selected = debug_wavs[-limit:]
    if not selected:
        return {
            "ok": False,
            "state": "no_artifacts",
            "message": "No failed-turn WAV artifacts were found in the current session log.",
            "status": status,
            "analysis": acceptance,
            "results": [],
        }

    run_root = LOG_ROOT / "failed_wav_analysis" / f"artifacts_{time.strftime('%Y%m%d_%H%M%S')}"
    results: list[dict[str, Any]] = []
    for idx, item in enumerate(selected, start=1):
        wav_path = Path(str(item.get("path") or ""))
        item_result: dict[str, Any] = {
            "reason": item.get("reason") or "unknown",
            "path": str(wav_path),
            "line": item.get("line"),
            "metrics": item.get("metrics") or _debug_wav_metrics(str(wav_path)),
        }
        if not wav_path.exists():
            item_result.update({"ok": False, "state": "missing", "message": "WAV artifact is missing on disk."})
            results.append(item_result)
            continue
        out_dir = run_root / f"{idx:02d}_{_safe_slug(str(item_result['reason']))}"
        cmd = [
            sys.executable or "python",
            "-u",
            str(LOCAL_INPUT_ACCEPTANCE_RUNNER),
            "--input-wav",
            str(wav_path),
            "--expected-command",
            expected_command,
            "--output-dir",
            str(out_dir),
            "--timeout",
            f"{timeout_sec:g}",
        ]
        if expected_reply_contains:
            cmd.extend(["--expected-reply-contains", expected_reply_contains])
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(APP_DIR),
                capture_output=True,
                text=True,
                timeout=timeout_sec + 30.0,
            )
            summary = _parse_json_stdout(proc.stdout)
            if not summary:
                summary = _load_json(out_dir / "summary.json")
            runner_summary = ((summary.get("process") or {}).get("runner_summary") or {}) if isinstance(summary, dict) else {}
            score = (summary.get("score") or {}) if isinstance(summary, dict) else {}
            intelligibility = _failed_wav_intelligibility(runner_summary)
            item_result.update(
                {
                    "ok": bool(summary.get("ok")) and proc.returncode == 0,
                    "state": "analyzed",
                    "returncode": proc.returncode,
                    "intelligibility": intelligibility,
                    "transcript": str(runner_summary.get("transcript") or ""),
                    "accepted": bool(runner_summary.get("accepted")),
                    "command_text": str(runner_summary.get("command") or ""),
                    "reply": str(runner_summary.get("reply") or ""),
                    "ignored_reason": str(runner_summary.get("ignored_reason") or ""),
                    "failed_checks": score.get("failed_checks") or [],
                    "summary": summary,
                    "stderr": proc.stderr[-2000:],
                    "command": cmd,
                    "run_dir": str(out_dir),
                }
            )
        except subprocess.TimeoutExpired as exc:
            item_result.update(
                {
                    "ok": False,
                    "state": "timeout",
                    "message": "Timed out while analyzing failed-turn WAV.",
                    "intelligibility": "unknown",
                    "stderr": str(exc),
                    "command": cmd,
                    "run_dir": str(out_dir),
                }
            )
        except Exception as exc:
            item_result.update(
                {
                    "ok": False,
                    "state": "error",
                    "message": str(exc),
                    "intelligibility": "unknown",
                    "command": cmd,
                    "run_dir": str(out_dir),
                }
            )
        results.append(item_result)

    accepted = [item for item in results if item.get("accepted")]
    transcribed = [item for item in results if str(item.get("transcript") or "").strip()]
    empty = [item for item in results if item.get("intelligibility") == "empty_or_unintelligible"]
    if accepted:
        state = "accepted_artifact"
        message = f"{len(accepted)} failed-turn artifact(s) replayed as accepted AVA commands."
    elif transcribed:
        state = "transcribed_unaccepted"
        message = f"{len(transcribed)} failed-turn artifact(s) were intelligible but not accepted."
    elif empty:
        state = "empty_artifacts"
        message = f"{len(empty)} failed-turn artifact(s) replayed with empty transcripts."
    else:
        state = "analysis_failed"
        message = "Failed-turn artifacts could not be analyzed."

    return {
        "ok": bool(accepted),
        "state": state,
        "message": message,
        "recommendation": (
            "If artifacts are empty/garbled here, fix mic placement/device/acoustics. "
            "If they transcribe but are unaccepted, tune wake-gate/ASR cleanup."
        ),
        "run_dir": str(run_root),
        "status": status,
        "analysis": acceptance,
        "results": results,
    }


def _input_block_reason(name: str, config: dict[str, Any]) -> str:
    audio = config.get("audio") if isinstance(config, dict) else {}
    audio = audio if isinstance(audio, dict) else {}
    terms = ["webcam", "c920e", "camera"]
    terms.extend(str(x).lower() for x in (audio.get("input_device_blocklist") or []))
    terms.extend(str(x).lower() for x in (audio.get("input_device_avoid") or []))
    lower = str(name or "").lower()
    for term in terms:
        if term and term in lower:
            return term
    return ""


def _persist_input_candidate(best: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        config = {}
    audio = config.get("audio")
    if not isinstance(audio, dict):
        audio = {}
        config["audio"] = audio
    backup_path = None
    if CONFIG_PATH.exists():
        backup_path = CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.bak_{time.strftime('%Y%m%d_%H%M%S')}")
        backup_path.write_text(CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    audio["input_device"] = int(best.get("device"))
    audio["input_sample_rate"] = int(best.get("rate"))
    audio["input_device_name"] = str(best.get("name") or "")
    if best.get("host_api_name"):
        audio["input_backend"] = str(best.get("host_api_name") or "").lower()
    for key in ("input_device_blocklist", "input_device_avoid"):
        values = audio.get(key)
        if not isinstance(values, list):
            values = []
        lowered = {str(v).lower() for v in values}
        for required in ("webcam", "c920e"):
            if required not in lowered:
                values.append(required)
                lowered.add(required)
        audio[key] = values
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return {"config_path": str(CONFIG_PATH), "backup_path": str(backup_path) if backup_path else None}


def _input_failover_probe(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if not SPEAKER_MIC_PROBE_RUNNER.exists():
        return {"ok": False, "state": "unavailable", "message": f"Missing multi-input probe: {SPEAKER_MIC_PROBE_RUNNER}"}

    status_before = CONTROLLER.status()
    was_running = bool(status_before.get("running"))
    previous_mode = str(status_before.get("runner_mode") or "local")
    stop_status: dict[str, Any] | None = None
    restart_status: dict[str, Any] | None = None
    apply_candidate = bool(payload.get("apply"))
    restart_after_apply = bool(payload.get("restart", True))

    if was_running:
        stop_status = CONTROLLER.stop(force=False)
        if not stop_status.get("ok"):
            return {
                "ok": False,
                "state": "stop_failed",
                "message": "Could not stop realtime runner for input failover probe.",
                "stop_status": stop_status,
                "status": status_before,
            }

    def _num(name: str, default: float, low: float, high: float) -> float:
        try:
            return max(low, min(float(payload.get(name) if payload.get(name) is not None else default), high))
        except Exception:
            return default

    duration = _num("duration", 8.0, 3.0, 20.0)
    start_delay = _num("start_delay", 1.0, 0.0, 5.0)
    max_candidates = int(_num("max_candidates", 8.0, 1.0, 16.0))
    max_parallel = int(_num("max_parallel", 6.0, 1.0, 12.0))
    expected_text = str(payload.get("expected_text") or "hey ava what time is it")
    rates = str(payload.get("rates") or "48000,44100,16000")
    run_dir = LOG_ROOT / "input_failover" / f"probe_{time.strftime('%Y%m%d_%H%M%S')}"
    cmd = [
        sys.executable or "python",
        "-u",
        str(SPEAKER_MIC_PROBE_RUNNER),
        "--duration",
        f"{duration:g}",
        "--rates",
        rates,
        "--max-candidates",
        str(max_candidates),
        "--max-parallel",
        str(max_parallel),
        "--start-delay",
        f"{start_delay:g}",
        "--expected-text",
        expected_text,
        "--output-dir",
        str(run_dir),
    ]
    if str(payload.get("devices") or "").strip():
        cmd.extend(["--devices", str(payload.get("devices"))])
    if str(payload.get("speaker_text") or "").strip():
        cmd.extend(["--speaker-text", str(payload.get("speaker_text"))])
        cmd.extend(["--speaker-gain", f"{_num('speaker_gain', 3.0, 0.1, 8.0):g}"])

    result: dict[str, Any]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            timeout=max(90.0, duration + 140.0),
        )
        probe = _parse_json_stdout(proc.stdout)
        best = probe.get("best") if isinstance(probe, dict) else {}
        best = best if isinstance(best, dict) else {}
        config = _load_json(CONFIG_PATH)
        block_reason = _input_block_reason(str(best.get("name") or ""), config) if best else ""
        viable = bool(best.get("viable")) and not block_reason
        persisted: dict[str, Any] | None = None
        state = "candidate_found" if viable else "no_viable_input"
        message = "Found a viable non-webcam input candidate." if viable else "No viable non-webcam input candidate was found."
        if best and block_reason:
            state = "blocked_candidate"
            message = f"Best candidate is blocked by input policy: {block_reason}."
        if viable and apply_candidate:
            persisted = _persist_input_candidate(best, config)
            state = "applied"
            message = (
                f"Applied input device {best.get('device')} @ {best.get('rate')} Hz: "
                f"{best.get('name') or 'unknown'}."
            )
        result = {
            "ok": viable,
            "state": state,
            "message": message,
            "recommendation": (
                "If no viable candidate appears, use a headset/USB mic or improve mic placement. "
                "Webcam/C920e inputs remain blocked."
            ),
            "returncode": proc.returncode,
            "probe": probe,
            "best": best,
            "block_reason": block_reason,
            "persisted": persisted,
            "applied": bool(persisted),
            "stderr": proc.stderr[-4000:],
            "command": cmd,
            "run_dir": str(run_dir),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
        }
    except subprocess.TimeoutExpired as exc:
        result = {
            "ok": False,
            "state": "timeout",
            "message": "Input failover probe timed out.",
            "recommendation": "Retry after confirming no process is holding the audio devices.",
            "stderr": str(exc),
            "command": cmd,
            "run_dir": str(run_dir),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
        }
    except Exception as exc:
        result = {
            "ok": False,
            "state": "error",
            "message": f"Input failover probe failed: {exc}",
            "command": cmd,
            "run_dir": str(run_dir),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
        }
    finally:
        if was_running or (apply_candidate and restart_after_apply):
            restart_status = CONTROLLER.start(
                {
                    "runner_mode": previous_mode if previous_mode in {"local", "legacy"} else "local",
                    "trace_asr": True,
                    "disable_loopback_probe": True,
                    "validation_mode": False,
                    "force": True,
                }
            )

    result["restart_status"] = restart_status
    result["status"] = CONTROLLER.status()
    if restart_status and not restart_status.get("ok"):
        result["ok"] = False
        result["message"] = f"{result.get('message', 'Input failover probe completed.')} Realtime restart failed."
    return result


def _speaker_mic_outcome(probe: dict[str, Any], returncode: int) -> tuple[str, str, str]:
    best = probe.get("best") if isinstance(probe, dict) else {}
    best = best if isinstance(best, dict) else {}
    metrics = best.get("metrics") if isinstance(best, dict) else {}
    metrics = metrics if isinstance(metrics, dict) else {}
    whisper = best.get("whisper") if isinstance(best, dict) else {}
    vosk = best.get("vosk") if isinstance(best, dict) else {}
    whisper_text = str((whisper if isinstance(whisper, dict) else {}).get("text") or "")
    vosk_text = str((vosk if isinstance(vosk, dict) else {}).get("text") or "")

    if bool(probe.get("ok")) and bool(best.get("viable")) and returncode == 0:
        return (
            "pass",
            "Speaker-to-mic command was captured and transcribed as a viable wake-command.",
            "The acoustic loop is strong enough for this room/device pair.",
        )

    if metrics and _coerce_int(metrics.get("above_start_frames"), 0) <= 0:
        peak = _coerce_int(metrics.get("rms_peak"), 0)
        p95 = _coerce_int(metrics.get("rms_p95"), 0)
        return (
            "acoustic_pickup_failed",
            f"Speaker playback reached the mic, but did not cross speech-start VAD: peak={peak}, p95={p95}.",
            "Do not lower VAD just to pass speaker bleed. Use live human acceptance, a headset mic, a better positioned mic, or a virtual audio route for automated loopback.",
        )

    if whisper_text or vosk_text:
        return (
            "asr_mismatch",
            f"Speaker audio was captured but ASR did not hear the expected command. Whisper='{whisper_text or 'empty'}', Vosk='{vosk_text or 'empty'}'.",
            "Treat this as an acoustic/ASR capture failure before changing wake-gate or response playback code.",
        )

    return (
        "failed",
        "Speaker-to-mic self-test did not produce a usable capture.",
        "Check output volume, selected mic, mic mute, Windows input permissions, or use a virtual loopback for fully automated testing.",
    )


def _speaker_to_mic_selftest(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if not SPEAKER_MIC_PROBE_RUNNER.exists():
        return {"ok": False, "state": "unavailable", "message": f"Missing speaker/mic probe: {SPEAKER_MIC_PROBE_RUNNER}"}

    status_before = CONTROLLER.status()
    was_running = bool(status_before.get("running"))
    previous_mode = str(status_before.get("runner_mode") or "local")
    restart_status: dict[str, Any] | None = None
    stop_status: dict[str, Any] | None = None

    if was_running:
        stop_status = CONTROLLER.stop(force=False)
        if not stop_status.get("ok"):
            return {
                "ok": False,
                "state": "stop_failed",
                "message": "Could not stop realtime runner for speaker-to-mic self-test.",
                "stop_status": stop_status,
            }

    config = _load_json(CONFIG_PATH)
    audio = config.get("audio") if isinstance(config, dict) else {}
    audio = audio if isinstance(audio, dict) else {}
    input_defaults = _configured_input_defaults(config)
    device = _coerce_int(
        payload.get("device") if payload.get("device") is not None else input_defaults["device"],
        int(input_defaults["device"]),
    )
    rate = _coerce_int(
        payload.get("rate") if payload.get("rate") is not None else input_defaults["rate"],
        int(input_defaults["rate"]),
    )
    playback_rate = _coerce_int(
        payload.get("playback_rate") if payload.get("playback_rate") is not None else audio.get("playback_rate"),
        44100,
    )

    def _num(name: str, default: float, low: float, high: float) -> float:
        try:
            return max(low, min(float(payload.get(name) if payload.get(name) is not None else default), high))
        except Exception:
            return default

    duration = _num("duration", 7.0, 3.0, 12.0)
    start_delay = _num("start_delay", 1.0, 0.0, 5.0)
    speaker_gain = _num("speaker_gain", 1.0, 0.1, 8.0)
    speaker_text = str(payload.get("speaker_text") or "Hey Ava, what time is it?")
    expected_text = str(payload.get("expected_text") or "hey ava what time is it")
    expected_command = str(payload.get("expected_command") or "what time is it")
    expected_reply_contains = str(payload.get("expected_reply_contains") or "It's")
    run_dir = LOG_ROOT / "speaker_selftests" / f"speaker_to_mic_{time.strftime('%Y%m%d_%H%M%S')}"
    run_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable or "python",
        "-u",
        str(SPEAKER_MIC_PROBE_RUNNER),
        "--duration",
        f"{duration:g}",
        "--devices",
        str(device),
        "--rates",
        str(rate),
        "--max-candidates",
        "1",
        "--max-parallel",
        "1",
        "--start-delay",
        f"{start_delay:g}",
        "--expected-text",
        expected_text,
        "--speaker-text",
        speaker_text,
        "--playback-rate",
        str(playback_rate),
        "--speaker-gain",
        f"{speaker_gain:g}",
        "--output-dir",
        str(run_dir),
    ]
    if payload.get("output_device") is not None:
        cmd.extend(["--output-device", str(payload.get("output_device"))])

    result: dict[str, Any]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            timeout=max(120.0, duration + 120.0),
        )
        probe = _parse_json_stdout(proc.stdout)
        state, message, recommendation = _speaker_mic_outcome(probe, proc.returncode)
        best = probe.get("best") if isinstance(probe, dict) else {}
        best = best if isinstance(best, dict) else {}
        acceptance: dict[str, Any] | None = None
        wav_path = best.get("wav_path")
        if wav_path and LOCAL_INPUT_ACCEPTANCE_RUNNER.exists():
            candidate_wav = Path(str(wav_path))
            if not candidate_wav.is_absolute():
                candidate_wav = APP_DIR / candidate_wav
            acc_cmd = [
                sys.executable or "python",
                "-u",
                str(LOCAL_INPUT_ACCEPTANCE_RUNNER),
                "--input-wav",
                str(candidate_wav),
                "--expected-command",
                expected_command,
                "--expected-reply-contains",
                expected_reply_contains,
                "--output-dir",
                str(run_dir / "acceptance"),
                "--timeout",
                "90",
            ]
            acc_proc = subprocess.run(
                acc_cmd,
                cwd=str(APP_DIR),
                capture_output=True,
                text=True,
                timeout=120.0,
            )
            acceptance = _parse_json_stdout(acc_proc.stdout)
            acceptance["returncode"] = acc_proc.returncode
            acceptance["stderr"] = acc_proc.stderr[-4000:]
            runner_summary = ((acceptance.get("process") or {}).get("runner_summary") or {}) if isinstance(acceptance, dict) else {}
            ignored_reason = str(runner_summary.get("ignored_reason") or "")
            if state != "acoustic_pickup_failed" and not bool(acceptance.get("ok")) and ignored_reason == "empty_transcript":
                state = "acceptance_empty_transcript"
                message = "Captured speaker-to-mic WAV reached AVA's acceptance path, but Whisper produced an empty transcript."
                recommendation = (
                    "This is still a capture/acoustic quality failure, not a wake-gate or response-playback failure. "
                    "Use a human live-window test, better mic placement, headset input, or virtual loopback for automated tests."
                )

        result = {
            "ok": state == "pass",
            "state": state,
            "message": message,
            "recommendation": recommendation,
            "returncode": proc.returncode,
            "probe": probe,
            "best": best,
            "acceptance": acceptance,
            "stderr": proc.stderr[-4000:],
            "command": cmd,
            "run_dir": str(run_dir),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
            "playback_rate": playback_rate,
            "speaker_gain": speaker_gain,
        }
    except subprocess.TimeoutExpired as exc:
        result = {
            "ok": False,
            "state": "timeout",
            "message": "Speaker-to-mic self-test timed out.",
            "recommendation": "Retry after confirming no other process is holding the audio devices.",
            "stderr": str(exc),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
            "playback_rate": playback_rate,
            "speaker_gain": speaker_gain,
            "run_dir": str(run_dir),
        }
    finally:
        if was_running:
            restart_status = CONTROLLER.start(
                {
                    "runner_mode": previous_mode if previous_mode in {"local", "legacy"} else "local",
                    "trace_asr": True,
                    "disable_loopback_probe": True,
                    "validation_mode": False,
                    "force": True,
                }
            )

    result["restart_status"] = restart_status
    result["status"] = CONTROLLER.status()
    if restart_status and not restart_status.get("ok"):
        result["ok"] = False
        result["message"] = f"{result.get('message', 'Speaker-to-mic self-test completed.')} Realtime restart failed."
    return result


def _push_to_talk_once(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if not PUSH_TO_TALK_RUNNER.exists():
        return {"ok": False, "message": f"Missing push-to-talk runner: {PUSH_TO_TALK_RUNNER}"}

    status_before = CONTROLLER.status()
    was_running = bool(status_before.get("running"))
    previous_mode = str(status_before.get("runner_mode") or "local")
    restart_status: dict[str, Any] | None = None
    stop_status: dict[str, Any] | None = None

    if was_running:
        stop_status = CONTROLLER.stop(force=False)
        if not stop_status.get("ok"):
            return {
                "ok": False,
                "message": "Could not stop realtime runner for push-to-talk capture.",
                "stop_status": stop_status,
            }

    input_defaults = _configured_input_defaults()
    device = _coerce_int(
        payload.get("device") if payload.get("device") is not None else input_defaults["device"],
        int(input_defaults["device"]),
    )
    rate = _coerce_int(
        payload.get("rate") if payload.get("rate") is not None else input_defaults["rate"],
        int(input_defaults["rate"]),
    )
    def _num(name: str, default: float, low: float, high: float) -> float:
        try:
            value = payload.get(name) if payload.get(name) is not None else default
            return max(low, min(float(value), high))
        except Exception:
            return default

    try:
        duration = _num("duration", 5.0, 1.0, 10.0)
        start_delay = _num("start_delay", 1.0, 0.0, 5.0)
    except Exception:
        duration, start_delay = 5.0, 1.0

    cmd = [
        sys.executable or "python",
        "-u",
        str(PUSH_TO_TALK_RUNNER),
        "--device",
        str(device),
        "--rate",
        str(rate),
        "--duration",
        f"{duration:g}",
        "--start-delay",
        f"{start_delay:g}",
    ]
    if bool(payload.get("no_speak")):
        cmd.append("--no-speak")

    result: dict[str, Any]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            timeout=max(45.0, duration + 90.0),
        )
        stdout = proc.stdout.strip()
        try:
            parsed = json.loads(stdout or "{}")
        except Exception:
            parsed = {"ok": False, "raw_stdout": stdout}
        result = {
            "ok": bool(parsed.get("ok")) and proc.returncode == 0,
            "message": parsed.get("reply") or ("Push-to-talk completed." if proc.returncode == 0 else "Push-to-talk failed."),
            "returncode": proc.returncode,
            "push_to_talk": parsed,
            "stderr": proc.stderr[-4000:],
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
        }
    except subprocess.TimeoutExpired as exc:
        result = {
            "ok": False,
            "message": "Push-to-talk timed out.",
            "stderr": str(exc),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
        }
    finally:
        if was_running:
            restart_status = CONTROLLER.start(
                {
                    "runner_mode": previous_mode if previous_mode in {"local", "legacy"} else "local",
                    "trace_asr": True,
                    "disable_loopback_probe": True,
                    "validation_mode": False,
                    "force": True,
                }
            )

    result["restart_status"] = restart_status
    result["status"] = CONTROLLER.status()
    if restart_status and not restart_status.get("ok"):
        result["ok"] = False
        result["message"] = f"{result.get('message', 'Push-to-talk completed.')} Realtime restart failed."
    return result


def _mic_calibration_once(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    if not MIC_CALIBRATION_RUNNER.exists():
        return {"ok": False, "message": f"Missing mic calibration runner: {MIC_CALIBRATION_RUNNER}"}

    status_before = CONTROLLER.status()
    was_running = bool(status_before.get("running"))
    previous_mode = str(status_before.get("runner_mode") or "local")
    restart_status: dict[str, Any] | None = None
    stop_status: dict[str, Any] | None = None

    if was_running:
        stop_status = CONTROLLER.stop(force=False)
        if not stop_status.get("ok"):
            return {
                "ok": False,
                "message": "Could not stop realtime runner for mic calibration.",
                "stop_status": stop_status,
            }

    def _num(name: str, default: float, low: float, high: float) -> float:
        try:
            return max(low, min(float(payload.get(name) if payload.get(name) is not None else default), high))
        except Exception:
            return default

    input_defaults = _configured_input_defaults()
    device = _coerce_int(
        payload.get("device") if payload.get("device") is not None else input_defaults["device"],
        int(input_defaults["device"]),
    )
    rate = _coerce_int(
        payload.get("rate") if payload.get("rate") is not None else input_defaults["rate"],
        int(input_defaults["rate"]),
    )

    background_sec = _num("background_sec", 3.0, 1.0, 8.0)
    voice_sec = _num("voice_sec", 8.0, 2.0, 10.0)
    start_delay = _num("start_delay", 1.0, 0.0, 5.0)
    between_delay = _num("between_delay", 1.0, 0.0, 5.0)
    expected_text = str(payload.get("expected_text") or "ava what time is it")

    cmd = [
        sys.executable or "python",
        "-u",
        str(MIC_CALIBRATION_RUNNER),
        "--device",
        str(device),
        "--rate",
        str(rate),
        "--background-sec",
        f"{background_sec:g}",
        "--voice-sec",
        f"{voice_sec:g}",
        "--start-delay",
        f"{start_delay:g}",
        "--between-delay",
        f"{between_delay:g}",
        "--expected-text",
        expected_text,
    ]
    if bool(payload.get("audible_cues", True)):
        cmd.append("--audible-cues")

    result: dict[str, Any]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            timeout=max(60.0, background_sec + voice_sec + 100.0),
        )
        stdout = proc.stdout.strip()
        try:
            parsed = json.loads(stdout or "{}")
        except Exception:
            parsed = {"ok": False, "raw_stdout": stdout}
        evaluation = parsed.get("evaluation") or {}
        result = {
            "ok": bool(parsed.get("ok")) and proc.returncode == 0,
            "message": evaluation.get("recommendation") or ("Mic calibration completed." if proc.returncode == 0 else "Mic calibration failed."),
            "returncode": proc.returncode,
            "calibration": parsed,
            "stderr": proc.stderr[-4000:],
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
        }
    except subprocess.TimeoutExpired as exc:
        result = {
            "ok": False,
            "message": "Mic calibration timed out.",
            "stderr": str(exc),
            "stopped_realtime": was_running,
            "stop_status": stop_status,
            "input_defaults": input_defaults,
        }
    finally:
        if was_running:
            restart_status = CONTROLLER.start(
                {
                    "runner_mode": previous_mode if previous_mode in {"local", "legacy"} else "local",
                    "trace_asr": True,
                    "disable_loopback_probe": True,
                    "validation_mode": False,
                    "force": True,
                }
            )

    result["restart_status"] = restart_status
    result["status"] = CONTROLLER.status()
    if restart_status and not restart_status.get("ok"):
        result["ok"] = False
        result["message"] = f"{result.get('message', 'Mic calibration completed.')} Realtime restart failed."
    return result


HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AVA Realtime Lab</title>
  <style>
    :root {
      --ink: #102026;
      --muted: #60717a;
      --panel: rgba(255, 252, 242, 0.88);
      --panel-strong: #fff8e5;
      --line: rgba(27, 53, 61, 0.16);
      --teal: #0f766e;
      --teal-dark: #0b4f4a;
      --amber: #f0a721;
      --red: #b63b2e;
      --green: #2f7d4d;
      --slate: #18343c;
      --shadow: 0 24px 80px rgba(8, 31, 38, 0.22);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Bahnschrift, "Aptos Display", "Segoe UI Variable Display", sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(240, 167, 33, 0.30), transparent 28rem),
        radial-gradient(circle at 88% 18%, rgba(15, 118, 110, 0.28), transparent 30rem),
        linear-gradient(135deg, #fff4d6 0%, #d9ebe6 44%, #f7ead1 100%);
      min-height: 100vh;
    }
    body:before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.28;
      background-image:
        linear-gradient(rgba(24, 52, 60, 0.12) 1px, transparent 1px),
        linear-gradient(90deg, rgba(24, 52, 60, 0.10) 1px, transparent 1px);
      background-size: 34px 34px;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
    }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px; }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: start;
      margin-bottom: 22px;
    }
    .brand {
      background: rgba(255, 252, 242, 0.58);
      border: 1px solid var(--line);
      border-radius: 28px;
      padding: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    h1 {
      margin: 0;
      font-family: Constantia, Georgia, serif;
      font-size: clamp(2.4rem, 5vw, 5.3rem);
      letter-spacing: -0.06em;
      line-height: 0.9;
    }
    .subtitle { max-width: 720px; color: var(--muted); font-size: 1.05rem; margin-top: 14px; line-height: 1.55; }
    .controls {
      min-width: 320px;
      display: grid;
      gap: 10px;
      padding: 18px;
      border: 1px solid var(--line);
      background: rgba(24, 52, 60, 0.92);
      color: #fff8e5;
      border-radius: 24px;
      box-shadow: var(--shadow);
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 16px;
      padding: 13px 16px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: #fff8e5;
      background: var(--teal);
      transition: transform 150ms ease, filter 150ms ease;
    }
    button:hover { transform: translateY(-1px); filter: brightness(1.04); }
    button.secondary { background: #355761; }
    button.warn { background: var(--amber); color: #2d2108; }
    button.danger { background: var(--red); }
    .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.88rem; color: #cde1dc; }
    label { display: flex; align-items: center; gap: 8px; }
    main { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr); gap: 18px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: var(--shadow);
      overflow: hidden;
      backdrop-filter: blur(14px);
    }
    .panel h2 {
      margin: 0;
      padding: 18px 20px 0;
      font-size: 1rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--teal-dark);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding: 18px;
    }
    .card {
      min-height: 108px;
      padding: 14px;
      border-radius: 18px;
      background: rgba(255,255,255,0.58);
      border: 1px solid var(--line);
      position: relative;
      overflow: hidden;
    }
    .card:after {
      content: "";
      position: absolute;
      right: -28px;
      top: -28px;
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: var(--muted);
      opacity: 0.18;
    }
    .card.ok:after { background: var(--green); }
    .card.warn:after { background: var(--amber); opacity: 0.34; }
    .card.bad:after { background: var(--red); opacity: 0.28; }
    .card .name { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; }
    .card .state { margin-top: 10px; font-weight: 800; font-size: 1.05rem; }
    .card .detail { margin-top: 8px; color: var(--muted); font-size: 0.86rem; line-height: 1.35; word-break: break-word; }
    .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 0 18px 18px; }
    .issue-list, .config-list, .device-list { padding: 14px 18px 18px; display: grid; gap: 10px; }
    .issue {
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.58);
    }
    .issue.critical, .issue.bad { border-color: rgba(182, 59, 46, 0.42); background: rgba(255, 230, 220, 0.72); }
    .issue.warn { border-color: rgba(240, 167, 33, 0.45); background: rgba(255, 246, 213, 0.82); }
    .issue.info { border-color: rgba(15, 118, 110, 0.24); }
    .issue-title { font-weight: 800; }
    .issue-detail { margin-top: 4px; color: var(--muted); font-size: 0.88rem; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .log {
      margin: 18px;
      padding: 16px;
      min-height: 460px;
      max-height: 62vh;
      overflow: auto;
      border-radius: 18px;
      background: #102026;
      color: #d2f2e9;
      font-family: "Cascadia Code", "Consolas", monospace;
      font-size: 0.82rem;
      line-height: 1.45;
      white-space: pre-wrap;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
    }
    .kv {
      display: grid;
      grid-template-columns: 160px minmax(0, 1fr);
      gap: 8px;
      font-size: 0.9rem;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .kv b { color: var(--teal-dark); }
    .kv span { color: var(--muted); word-break: break-word; }
    .path {
      margin: 0 18px 18px;
      font-family: "Cascadia Code", "Consolas", monospace;
      font-size: 0.78rem;
      color: var(--muted);
      word-break: break-all;
    }
    .mini { color: #cde1dc; font-size: 0.82rem; line-height: 1.4; }
    .toast {
      position: fixed;
      right: 22px;
      bottom: 22px;
      max-width: 420px;
      background: var(--slate);
      color: #fff8e5;
      padding: 14px 16px;
      border-radius: 16px;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(12px);
      transition: 180ms ease;
      z-index: 10;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 1080px) {
      header, main { grid-template-columns: 1fr; }
      .controls { min-width: 0; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .columns { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .shell { padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      .toggles { grid-template-columns: 1fr; }
    }
    .test-presets {
      border-top: 1px solid rgba(255,255,255,.14);
      margin-top: 14px;
      padding-top: 14px;
      display: grid;
      gap: 10px;
    }
    .preset-title {
      color: #d7f6ec;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .13em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <section class="brand">
        <h1>AVA Realtime Lab</h1>
        <div class="subtitle">A local control room for developing realtime AVA: launch the voice runtime, keep this dashboard alive, watch the logs, and see what is broken before you have to guess.</div>
      </section>
      <section class="controls">
        <button id="startBtn">Start Local Voice</button>
        <button id="startLegacyBtn" class="secondary">Start Legacy Realtime</button>
        <button id="stopBtn" class="danger">Stop Realtime AVA</button>
        <button id="restartBtn" class="warn">Restart Clean</button>
        <button id="startBrainBtn" class="secondary">Start Brain Server</button>
        <button id="stopBrainBtn" class="secondary">Stop UI Brain Server</button>
        <button id="checksBtn" class="warn">Run Local Checks</button>
        <button id="directLocalBtn" class="warn">Direct Local Voice Self-Test</button>
        <button id="failedWavsBtn" class="warn">Analyze Failed WAVs</button>
        <button id="diagBtn" class="secondary">Refresh Diagnostics</button>
        <button id="audioBtn" class="secondary">Probe Audio Devices</button>
        <button id="inputFailoverBtn" class="warn">Probe Non-Webcam Inputs</button>
        <button id="applyInputFailoverBtn" class="warn">Apply Best Input</button>
        <button id="micCalBtn" class="warn">Calibrate Mic</button>
        <button id="pttBtn" class="warn">Push-to-talk Once</button>
        <button id="liveWindowMarkBtn" class="secondary">Mark Live Test Window</button>
        <button id="liveWindowAnalyzeBtn" class="warn">Analyze Live Window</button>
        <button id="speakerMicBtn" class="warn">Speaker-to-Mic Self-Test</button>
        <div class="test-presets">
          <div class="preset-title">Voice Test Presets</div>
          <button id="listenTestBtn" class="secondary">Listen Only Test</button>
          <button id="wakeTestBtn" class="secondary">Wake Word Test</button>
          <button id="ttsTestBtn" class="secondary">TTS Playback Test</button>
          <button id="roundtripTestBtn" class="secondary">Full Roundtrip Test</button>
        </div>
        <div class="toggles">
          <label><input type="checkbox" id="traceAsr" checked> ASR trace</label>
          <label><input type="checkbox" id="validationMode"> Validation env</label>
          <label><input type="checkbox" id="disableProbe" checked> Disable loopback probe</label>
          <label><input type="checkbox" id="preserveEnv"> Preserve device env</label>
        </div>
        <div class="mini" id="runtimeMini">Waiting for dashboard data...</div>
      </section>
    </header>
    <main>
      <section class="panel">
        <h2>Runtime Systems</h2>
        <div id="cards" class="grid"></div>
        <div class="columns">
          <section>
            <h2>Issue Board</h2>
            <div id="issues" class="issue-list"></div>
          </section>
          <section>
            <h2>Config Snapshot</h2>
            <div id="config" class="config-list"></div>
          </section>
        </div>
      </section>
      <section class="panel">
        <h2>Live Log Tail</h2>
        <div id="log" class="log">Loading logs...</div>
        <div id="paths" class="path"></div>
      </section>
    </main>
    <section class="panel" style="margin-top:18px">
      <h2>Audio Devices</h2>
      <div id="devices" class="device-list"><div class="issue info"><div class="issue-title">Not probed yet</div><div class="issue-detail">Click "Probe Audio Devices" to list PyAudio inputs and outputs.</div></div></div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Input Failover</h2>
      <div id="inputFailoverResult" class="issue info">
        <div class="issue-title">Not run yet</div>
        <div class="issue-detail">Ranks available non-webcam input devices. Use Probe first while speaking the wake phrase; Apply Best Input only writes the best viable non-webcam candidate to the voice config and restarts AVA.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Local Checks</h2>
      <div id="checks" class="device-list"><div class="issue info"><div class="issue-title">Not run yet</div><div class="issue-detail">Click "Run Local Checks" to compile core Python files and verify local voice assets, config, brain health, and PyAudio devices.</div></div></div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Direct Local Voice Self-Test</h2>
      <div id="directLocalResult" class="issue info">
        <div class="issue-title">Not run yet</div>
        <div class="issue-detail">This deterministic test bypasses the room, speaker, and mic. It generates a clean wake-command WAV, runs AVA's local input path, and verifies ASR, wake cleanup, response selection, and TTS synthesis.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Live Voice Test Guide</h2>
      <div id="testGuide" class="issue info">
        <div class="issue-title">No focused test selected</div>
        <div class="issue-detail">Use a Voice Test Preset to start a tagged session, then follow the exact phrase and expected log markers here.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Live Acceptance Window</h2>
      <div id="liveWindowResult" class="issue info">
        <div class="issue-title">No live window marked</div>
        <div class="issue-detail">Mark a window, say one wake-command, then analyze only that log slice. This separates a failed spoken turn from old ambient noise in the log.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Failed-Turn WAV Analysis</h2>
      <div id="failedWavsResult" class="issue info">
        <div class="issue-title">Not run yet</div>
        <div class="issue-detail">Analyzes recent failed-turn WAV artifacts through AVA's deterministic local input path. Empty transcripts point to mic/acoustic capture; intelligible but unaccepted transcripts point to wake/ASR cleanup.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Speaker-to-Mic Self-Test</h2>
      <div id="speakerMicResult" class="issue info">
        <div class="issue-title">Not run yet</div>
        <div class="issue-detail">This automated test plays "Hey Ava, what time is it?" through the speakers, records the configured non-webcam mic, then runs the captured WAV through AVA's acceptance path.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Push-To-Talk Result</h2>
      <div id="pttResult" class="issue info">
        <div class="issue-title">Not run yet</div>
        <div class="issue-detail">Use this when open-mic wake detection is losing to room/background audio. It records one intentional local turn, speaks the reply, then restores realtime AVA.</div>
      </div>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Mic Calibration Verdict</h2>
      <div id="micCalResult" class="issue info">
        <div class="issue-title">Not calibrated yet</div>
        <div class="issue-detail">This test records background first, then your phrase, and proves whether the selected mic can hear you above the room before realtime starts listening. One low beep means stay quiet. Two higher beeps mean repeat the phrase until capture ends.</div>
      </div>
    </section>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    const $ = (id) => document.getElementById(id);
    const VOICE_PRESETS = {
      normal: {
        label: "Normal runtime",
        prompt: "Start AVA normally.",
        expect: "Use this when you are not running a focused voice test."
      },
      listen: {
        label: "Listen-only mic test",
        prompt: "Speak naturally without the wake word for 10 seconds.",
        expect: "Expect mic debug frames, Vosk partials, and overheard/ignored text, but no AVA reply."
      },
      wake: {
        label: "Wake-word test",
        prompt: "Say: Hey Ava, are you listening? Then pause.",
        expect: "Expect a final transcript containing the wake word and an audible reply."
      },
      tts: {
        label: "TTS playback test",
        prompt: "Say: Hey Ava, what time is it?",
        expect: "Expect final transcript, brain/local intent response, tts-in, playback chunk, and audible speech."
      },
      roundtrip: {
        label: "Full roundtrip test",
        prompt: "Say: Hey Ava, tell me one sentence about your audio status.",
        expect: "Expect ASR final, /respond brain call, TTS synthesis, playback, mic mute, and clean return to IDLE."
      }
    };
    let latest = null;
    window.liveAcceptanceMarker = null;

    function toast(msg) {
      const t = $("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2600);
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        headers: {"Content-Type": "application/json"},
        ...options
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || res.statusText);
      return data;
    }

    function options() {
      return {
        trace_asr: $("traceAsr").checked,
        validation_mode: $("validationMode").checked,
        disable_loopback_probe: $("disableProbe").checked,
        preserve_device_env: $("preserveEnv").checked
      };
    }

    function renderCards(cards) {
      $("cards").innerHTML = cards.map(c => `
        <div class="card ${c.state}">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="state">${c.state.toUpperCase()}</div>
          <div class="detail">${escapeHtml(c.detail || "")}</div>
        </div>
      `).join("");
    }

    function renderIssues(issues) {
      if (!issues.length) {
        $("issues").innerHTML = `<div class="issue info"><div class="issue-title">No active issues detected</div><div class="issue-detail">This means the dashboard has not found a known failure marker. It does not prove live mic/speaker success by itself.</div></div>`;
        return;
      }
      $("issues").innerHTML = issues.map(i => `
        <div class="issue ${escapeHtml(i.level || "info")}">
          <div class="issue-title">${escapeHtml((i.level || "info").toUpperCase())}: ${escapeHtml(i.title || "Issue")}</div>
          <div class="issue-detail">${escapeHtml(i.detail || "")}\n${escapeHtml(i.source ? "source: " + i.source : "")}</div>
        </div>
      `).join("");
    }

    function renderConfig(config) {
      const entries = Object.entries(config || {});
      $("config").innerHTML = entries.map(([k, v]) => `
        <div class="kv"><b>${escapeHtml(k)}</b><span>${escapeHtml(Array.isArray(v) ? v.join(", ") : String(v ?? ""))}</span></div>
      `).join("");
    }

    function renderLogs(logs) {
      const stdout = logs.stdout || [];
      const stderr = logs.stderr || [];
      const merged = [
        ...stdout,
        ...(stderr.length ? ["", "----- STDERR -----", ...stderr] : [])
      ].join("\n");
      const log = $("log");
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.textContent = merged || "No logs for this dashboard session yet.";
      if (nearBottom) log.scrollTop = log.scrollHeight;
      $("paths").textContent = [logs.stdout_path, logs.stderr_path].filter(Boolean).join(" | ");
    }

    function renderMini(data) {
      const s = data.status || {};
      const parsed = data.parsed || {};
      $("runtimeMini").innerHTML = `
        Realtime: <b>${s.running ? "running" : "stopped"}</b>${s.pid ? " (PID " + s.pid + ")" : ""}<br>
        Elapsed: ${s.running ? String(s.elapsed_seconds || 0) + "s" : "0s"}<br>
        Started: ${escapeHtml(s.started_at || "not this session")}<br>
        Input: ${escapeHtml(parsed.input || "unknown")}<br>
        Last final: ${escapeHtml(parsed.last_final || "none")}
      `;
    }

    function renderDevices(data) {
      if (!data.ok) {
        $("devices").innerHTML = `<div class="issue warn"><div class="issue-title">Audio probe failed</div><div class="issue-detail">${escapeHtml(data.error || "unknown")}</div></div>`;
        return;
      }
      const rows = data.devices.map(d => `
        <div class="kv">
          <b>#${d.index} ${escapeHtml(d.name || "")}</b>
          <span>in=${d.max_input_channels}, out=${d.max_output_channels}, rate=${d.default_sample_rate}</span>
        </div>
      `).join("");
      $("devices").innerHTML = rows || `<div class="issue warn"><div class="issue-title">No devices found</div></div>`;
    }

    function renderChecks(data) {
      if (!data || !data.checks) {
        $("checks").innerHTML = `<div class="issue warn"><div class="issue-title">Checks unavailable</div></div>`;
        return;
      }
      const rows = data.checks.map(c => `
        <div class="issue ${escapeHtml(c.state || "info")}">
          <div class="issue-title">${escapeHtml((c.state || "info").toUpperCase())}: ${escapeHtml(c.name || "Check")}</div>
          <div class="issue-detail">${escapeHtml(c.detail || "")}${c.command ? "\ncommand: " + escapeHtml(c.command) : ""}</div>
        </div>
      `).join("");
      $("checks").innerHTML = `
        <div class="issue ${escapeHtml(data.state || "info")}">
          <div class="issue-title">Overall: ${escapeHtml((data.state || "unknown").toUpperCase())}</div>
          <div class="issue-detail">Completed in ${escapeHtml(data.elapsed_ms || 0)}ms.</div>
        </div>
        ${rows}
      `;
    }

    function renderPushToTalk(data) {
      const p = (data && data.push_to_talk) || {};
      const metrics = p.metrics || {};
      const vosk = (p.vosk || {}).text || "";
      const whisper = (p.whisper || {}).text || "";
      $("pttResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("pttResult").innerHTML = `
        <div class="issue-title">${data && data.ok ? "Push-to-talk reply spoken" : "Push-to-talk needs retry"}</div>
        <div class="issue-detail">Command: ${escapeHtml(p.command || "none")} (${escapeHtml(p.command_source || "none")})
Reply: ${escapeHtml(p.reply || data.message || "")}
Vosk: ${escapeHtml(vosk || "empty")}
Whisper: ${escapeHtml(whisper || "empty")}
Mic: peak=${escapeHtml(metrics.rms_peak || 0)}, p95=${escapeHtml(metrics.rms_p95 || 0)}, speech_like=${escapeHtml(metrics.speech_like)}
WAV: ${escapeHtml(p.wav_path || "")}</div>
      `;
    }

    function renderMicCalibration(data) {
      const c = (data && data.calibration) || {};
      const e = c.evaluation || {};
      const voice = c.voice || {};
      const bg = c.background || {};
      const vosk = (c.vosk || {}).text || "";
      const whisper = (c.whisper || {}).text || "";
      $("micCalResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("micCalResult").innerHTML = `
        <div class="issue-title">${data && data.ok ? "Mic is viable" : "Mic is not viable yet"}: ${escapeHtml(e.verdict || "unknown")}</div>
        <div class="issue-detail">${escapeHtml(e.recommendation || data.message || "")}
Energy: voice_p95=${escapeHtml(e.voice_p95 || 0)}, background_p95=${escapeHtml(e.background_p95 || 0)}, delta=${escapeHtml(e.p95_delta || 0)}, ratio=${escapeHtml(e.p95_ratio || 0)}
Timing: sustained_voice_ms=${escapeHtml(e.sustained_voice_ms || 0)}, first_voice_ms=${escapeHtml(e.first_voice_ms ?? "n/a")}, last_voice_ms=${escapeHtml(e.last_voice_ms ?? "n/a")}
ASR: command=${escapeHtml(c.command || "none")} (${escapeHtml(c.command_source || "none")}), score=${escapeHtml(e.text_score || 0)}
Vosk: ${escapeHtml(vosk || "empty")}
Whisper: ${escapeHtml(whisper || "empty")}
WAVs: ${escapeHtml(c.background_wav || "")} | ${escapeHtml(c.voice_wav || "")}
Raw peaks: voice=${escapeHtml(voice.rms_peak || 0)}, background=${escapeHtml(bg.rms_peak || 0)}</div>
      `;
    }

    function formatDebugWav(w) {
      const m = (w && w.metrics) || {};
      const bits = [];
      if (m.exists === false) bits.push("missing");
      if (m.seconds !== undefined) bits.push(`${m.seconds}s`);
      if (m.rms !== undefined) bits.push(`rms=${m.rms}`);
      if (m.peak !== undefined) bits.push(`peak=${m.peak}`);
      return `${(w && w.reason) || "unknown"}: ${(w && w.path) || ""}${bits.length ? " (" + bits.join(", ") + ")" : ""}`;
    }

    function renderLiveWindow(data) {
      const a = (data && data.analysis) || {};
      const debugWavs = (a.debug_wavs || []).slice(-4).map(formatDebugWav).join("\n");
      const cq = a.capture_quality || {};
      const captureVerdict = cq.title ? `${cq.title}\n${cq.detail || ""}\nRecommendation: ${cq.recommendation || ""}` : "none";
      $("liveWindowResult").className = `issue ${data && data.ok ? "ok" : (data && data.state === "marked" ? "info" : "warn")}`;
      $("liveWindowResult").innerHTML = `
        <div class="issue-title">${escapeHtml(data && data.state ? data.state : "unknown")}: ${escapeHtml(data && data.message ? data.message : "")}</div>
        <div class="issue-detail">Window: ${escapeHtml(data && data.start_offset !== undefined ? data.start_offset : "mark")} -> ${escapeHtml(data && data.end_offset !== undefined ? data.end_offset : "n/a")} bytes
Finals: ${escapeHtml(a.final_count || 0)}, spoken_replies=${escapeHtml(a.spoken_count || 0)}, speech_starts=${escapeHtml(a.speech_starts || 0)}
Ignored: no_wake=${escapeHtml(a.ignored_no_wake || 0)}, wake_gate=${escapeHtml(a.ignored_wake_gate_no_wake || 0)}, empty=${escapeHtml(a.ignored_empty_transcript || 0)}
Capture verdict: ${escapeHtml(captureVerdict)}
Debug WAVs: ${escapeHtml(debugWavs || "none")}
Log: ${escapeHtml((data && data.marker && data.marker.path) || "")}</div>
      `;
    }

    function renderSpeakerMicSelfTest(data) {
      const best = (data && data.best) || {};
      const metrics = best.metrics || {};
      const whisper = (best.whisper || {}).text || "";
      const vosk = (best.vosk || {}).text || "";
      const acceptance = (data && data.acceptance) || {};
      const runner = ((acceptance.process || {}).runner_summary) || {};
      $("speakerMicResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("speakerMicResult").innerHTML = `
        <div class="issue-title">${escapeHtml(data && data.state ? data.state : "unknown")}: ${escapeHtml(data && data.message ? data.message : "")}</div>
        <div class="issue-detail">${escapeHtml(data && data.recommendation ? data.recommendation : "")}
Mic metrics: peak=${escapeHtml(metrics.rms_peak || 0)}, p95=${escapeHtml(metrics.rms_p95 || 0)}, above_start_frames=${escapeHtml(metrics.above_start_frames || 0)}, speech_like=${escapeHtml(metrics.speech_like)}
ASR: Whisper=${escapeHtml(whisper || "empty")} | Vosk=${escapeHtml(vosk || "empty")}
Acceptance: ok=${escapeHtml(acceptance.ok)}, transcript=${escapeHtml(runner.transcript || "empty")}, ignored=${escapeHtml(runner.ignored_reason || "")}
WAV: ${escapeHtml(best.wav_path || "")}
Artifacts: ${escapeHtml(data && data.run_dir ? data.run_dir : "")}</div>
      `;
    }

    function renderDirectLocalSelfTest(data) {
      const runner = (data && data.runner_summary) || {};
      const score = (data && data.score) || {};
      $("directLocalResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("directLocalResult").innerHTML = `
        <div class="issue-title">${escapeHtml(data && data.state ? data.state : "unknown")}: ${escapeHtml(data && data.message ? data.message : "")}</div>
        <div class="issue-detail">${escapeHtml(data && data.recommendation ? data.recommendation : "")}
Transcript: ${escapeHtml(runner.transcript || "empty")}
Command: ${escapeHtml(runner.command || "empty")}
Reply: ${escapeHtml(runner.reply || "empty")}
Failed checks: ${escapeHtml((score.failed_checks || []).join(", ") || "none")}
Artifacts: ${escapeHtml(data && data.run_dir ? data.run_dir : "")}</div>
      `;
    }

    function formatFailedWavResult(item) {
      const bits = [];
      if (item.transcript) bits.push(`transcript="${item.transcript}"`);
      if (item.command_text) bits.push(`command="${item.command_text}"`);
      if (item.ignored_reason) bits.push(`ignored=${item.ignored_reason}`);
      if (item.failed_checks && item.failed_checks.length) bits.push(`failed=${item.failed_checks.join(",")}`);
      const metrics = item.metrics || {};
      const metricBits = [];
      if (metrics.seconds !== undefined) metricBits.push(`${metrics.seconds}s`);
      if (metrics.rms !== undefined) metricBits.push(`rms=${metrics.rms}`);
      if (metrics.peak !== undefined) metricBits.push(`peak=${metrics.peak}`);
      return `${item.reason || "unknown"} | ${item.intelligibility || item.state || "unknown"} | ${bits.join(" | ") || "no transcript"} | ${metricBits.join(", ")}\n${item.path || ""}`;
    }

    function renderFailedWavAnalysis(data) {
      const results = (data && data.results) || [];
      const lines = results.map(formatFailedWavResult).join("\n\n");
      $("failedWavsResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("failedWavsResult").innerHTML = `
        <div class="issue-title">${escapeHtml(data && data.state ? data.state : "unknown")}: ${escapeHtml(data && data.message ? data.message : "")}</div>
        <div class="issue-detail">${escapeHtml(data && data.recommendation ? data.recommendation : "")}
${escapeHtml(lines || "No failed-turn WAVs analyzed.")}
Artifacts: ${escapeHtml(data && data.run_dir ? data.run_dir : "")}</div>
      `;
    }

    function renderInputFailover(data) {
      const best = (data && data.best) || {};
      const metrics = best.metrics || {};
      const whisper = (best.whisper || {}).text || "";
      const vosk = (best.vosk || {}).text || "";
      const persisted = data && data.persisted ? data.persisted : {};
      $("inputFailoverResult").className = `issue ${data && data.ok ? "ok" : "warn"}`;
      $("inputFailoverResult").innerHTML = `
        <div class="issue-title">${escapeHtml(data && data.state ? data.state : "unknown")}: ${escapeHtml(data && data.message ? data.message : "")}</div>
        <div class="issue-detail">${escapeHtml(data && data.recommendation ? data.recommendation : "")}
Best: device=${escapeHtml(best.device ?? "n/a")} rate=${escapeHtml(best.rate ?? "n/a")} name=${escapeHtml(best.name || "none")} viable=${escapeHtml(best.viable)}
Metrics: peak=${escapeHtml(metrics.rms_peak || 0)}, p95=${escapeHtml(metrics.rms_p95 || 0)}, speech_like=${escapeHtml(metrics.speech_like)}
ASR: Whisper=${escapeHtml(whisper || "empty")} | Vosk=${escapeHtml(vosk || "empty")}
Blocked by: ${escapeHtml((data && data.block_reason) || "none")}
Applied: ${escapeHtml(data && data.applied ? "yes" : "no")} config=${escapeHtml(persisted.config_path || "")} backup=${escapeHtml(persisted.backup_path || "")}
Artifacts: ${escapeHtml(data && data.run_dir ? data.run_dir : "")}</div>
      `;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function refresh() {
      try {
        latest = await api("/api/diagnostics");
        renderCards(latest.cards || []);
        renderIssues(latest.issues || []);
        renderConfig(latest.config_summary || {});
        renderLogs(latest.logs || {});
        renderMini(latest);
      } catch (err) {
        toast("Dashboard refresh failed: " + err.message);
      }
    }

    window.activeVoicePreset = "normal";

    function renderTestGuide(name, message) {
      const preset = VOICE_PRESETS[name] || VOICE_PRESETS.normal;
      const extra = message ? `\n\n${message}` : "";
      $("testGuide").className = `issue ${name === "normal" ? "info" : "warn"}`;
      $("testGuide").innerHTML = `
        <div class="issue-title">${escapeHtml(preset.label)}</div>
        <div class="issue-detail">Speak now: ${escapeHtml(preset.prompt)}

Expected: ${escapeHtml(preset.expect)}${escapeHtml(extra)}</div>
      `;
    }

    async function startVoicePreset(name) {
      window.activeVoicePreset = name;
      renderTestGuide(name, "Starting tagged realtime session...");
      const opts = options();
      opts.test_preset = name;
      opts.runner_mode = "legacy";
      const r = await api("/api/restart", {method: "POST", body: JSON.stringify(opts)});
      toast(r.message);
      renderTestGuide(name, r.message);
      await refresh();
    }

    $("startBtn").onclick = async () => {
      try { window.activeVoicePreset = "normal"; renderTestGuide("normal", "Launching the minimal local voice runner."); const opts = options(); opts.runner_mode = "local"; const r = await api("/api/start", {method: "POST", body: JSON.stringify(opts)}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("startLegacyBtn").onclick = async () => {
      try { window.activeVoicePreset = "normal"; renderTestGuide("normal", "Launching the legacy realtime monolith for comparison only."); const opts = options(); opts.runner_mode = "legacy"; const r = await api("/api/start", {method: "POST", body: JSON.stringify(opts)}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("stopBtn").onclick = async () => {
      try { const r = await api("/api/stop", {method: "POST", body: JSON.stringify({force: false})}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("restartBtn").onclick = async () => {
      try { window.activeVoicePreset = "normal"; renderTestGuide("normal", "Restarting the minimal local voice runner."); const opts = options(); opts.runner_mode = "local"; const r = await api("/api/restart", {method: "POST", body: JSON.stringify(opts)}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("listenTestBtn").onclick = async () => {
      try { await startVoicePreset("listen"); }
      catch (err) { toast(err.message); }
    };
    $("wakeTestBtn").onclick = async () => {
      try { await startVoicePreset("wake"); }
      catch (err) { toast(err.message); }
    };
    $("ttsTestBtn").onclick = async () => {
      try { await startVoicePreset("tts"); }
      catch (err) { toast(err.message); }
    };
    $("roundtripTestBtn").onclick = async () => {
      try { await startVoicePreset("roundtrip"); }
      catch (err) { toast(err.message); }
    };
    $("startBrainBtn").onclick = async () => {
      try { const r = await api("/api/brain/start", {method: "POST", body: "{}"}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("stopBrainBtn").onclick = async () => {
      try { const r = await api("/api/brain/stop", {method: "POST", body: "{}"}); toast(r.message); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("checksBtn").onclick = async () => {
      try { toast("Running local checks..."); renderChecks(await api("/api/run-checks", {method: "POST", body: "{}"})); await refresh(); }
      catch (err) { toast(err.message); }
    };
    $("directLocalBtn").onclick = async () => {
      try {
        $("directLocalResult").className = "issue warn";
        $("directLocalResult").innerHTML = `<div class="issue-title">Running direct local voice self-test</div><div class="issue-detail">Generating a clean wake-command WAV and running AVA's local input acceptance path. No speaker or mic is used.</div>`;
        const r = await api("/api/direct-local-voice-selftest", {method: "POST", body: JSON.stringify({timeout: 140})});
        renderDirectLocalSelfTest(r);
        toast(r.message || "Direct local voice self-test completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("failedWavsBtn").onclick = async () => {
      try {
        $("failedWavsResult").className = "issue warn";
        $("failedWavsResult").innerHTML = `<div class="issue-title">Analyzing failed-turn WAVs</div><div class="issue-detail">Running the latest failed captures through AVA's deterministic local input path.</div>`;
        const r = await api("/api/analyze-failed-turn-wavs", {method: "POST", body: JSON.stringify({limit: 3, timeout: 90})});
        renderFailedWavAnalysis(r);
        toast(r.message || "Failed-turn WAV analysis completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("diagBtn").onclick = refresh;
    $("audioBtn").onclick = async () => {
      try { renderDevices(await api("/api/audio-devices")); }
      catch (err) { toast(err.message); }
    };
    $("inputFailoverBtn").onclick = async () => {
      try {
        renderTestGuide("tts", "Input failover probe is recording all non-webcam inputs. Say repeatedly: Hey Ava, what time is it?");
        $("inputFailoverResult").className = "issue warn";
        $("inputFailoverResult").innerHTML = `<div class="issue-title">Probing non-webcam inputs</div><div class="issue-detail">Realtime AVA is paused while candidate inputs are recorded and ranked. Speak the wake phrase until the probe completes.</div>`;
        const r = await api("/api/input-failover-probe", {method: "POST", body: JSON.stringify({duration: 8, start_delay: 1, apply: false})});
        renderInputFailover(r);
        toast(r.message || "Input failover probe completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("applyInputFailoverBtn").onclick = async () => {
      try {
        renderTestGuide("tts", "Applying requires a fresh non-webcam input probe. Speak repeatedly: Hey Ava, what time is it?");
        $("inputFailoverResult").className = "issue warn";
        $("inputFailoverResult").innerHTML = `<div class="issue-title">Finding and applying best input</div><div class="issue-detail">This will update ava_voice_config.json only if a viable non-webcam candidate is found, then restart AVA.</div>`;
        const r = await api("/api/input-failover-probe", {method: "POST", body: JSON.stringify({duration: 8, start_delay: 1, apply: true, restart: true})});
        renderInputFailover(r);
        toast(r.message || "Input failover apply completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("micCalBtn").onclick = async () => {
      try {
        renderTestGuide("normal", "Mic calibration will record background first. One low beep means stay quiet. Two higher beeps mean repeat: Ava, what time is it? Keep repeating until capture ends.");
        $("micCalResult").className = "issue warn";
        $("micCalResult").innerHTML = `<div class="issue-title">Calibrating now</div><div class="issue-detail">One low beep: stay quiet. Two higher beeps: repeat "Ava, what time is it?" clearly until the 8-second capture ends.</div>`;
        const r = await api("/api/mic-calibration", {method: "POST", body: JSON.stringify({background_sec: 3, voice_sec: 8, start_delay: 1, between_delay: 1, audible_cues: true})});
        renderMicCalibration(r);
        toast(r.message || "Mic calibration completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("pttBtn").onclick = async () => {
      try {
        renderTestGuide("normal", "Push-to-talk will pause realtime first, then record after a short beat. Say: Ava, what time is it?");
        $("pttResult").className = "issue warn";
        $("pttResult").innerHTML = `<div class="issue-title">Recording now</div><div class="issue-detail">Speak clearly for one short turn. The open-mic runner will be restored after capture.</div>`;
        const r = await api("/api/push-to-talk", {method: "POST", body: JSON.stringify({duration: 5, start_delay: 1})});
        renderPushToTalk(r);
        toast(r.message || "Push-to-talk completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("liveWindowMarkBtn").onclick = async () => {
      try {
        const r = await api("/api/live-acceptance-window");
        window.liveAcceptanceMarker = r.marker;
        renderLiveWindow(r);
        renderTestGuide("tts", "Window marked. Say: Hey Ava, what time is it? Then click Analyze Live Window.");
        toast("Live test window marked.");
      }
      catch (err) { toast(err.message); }
    };
    $("liveWindowAnalyzeBtn").onclick = async () => {
      try {
        if (!window.liveAcceptanceMarker) {
          toast("Mark a live window first.");
          return;
        }
        const r = await api("/api/live-acceptance-window", {method: "POST", body: JSON.stringify({offset: window.liveAcceptanceMarker.offset})});
        renderLiveWindow(r);
        toast(r.message || "Live window analyzed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };
    $("speakerMicBtn").onclick = async () => {
      try {
        $("speakerMicResult").className = "issue warn";
        $("speakerMicResult").innerHTML = `<div class="issue-title">Running speaker-to-mic self-test</div><div class="issue-detail">Playing a synthetic wake-command through speakers and recording the configured mic. Realtime AVA is paused during the test and restored afterward.</div>`;
        const r = await api("/api/speaker-to-mic-selftest", {method: "POST", body: JSON.stringify({duration: 7, start_delay: 1, speaker_gain: 3})});
        renderSpeakerMicSelfTest(r);
        toast(r.message || "Speaker-to-mic self-test completed.");
        await refresh();
      }
      catch (err) { toast(err.message); }
    };

    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "AvaRealtimeUI/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[ui] " + (fmt % args) + "\n")

    def _send_json(self, payload: Any, status: int = 200) -> None:
        data = json.dumps(payload, default=_json_safe).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self) -> None:
        if self.path in {"/", "/index.html"}:
            data = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/api/status"):
            self._send_json(CONTROLLER.status())
            return
        if self.path.startswith("/api/diagnostics"):
            self._send_json(DIAGNOSTICS.run())
            return
        if self.path.startswith("/api/logs"):
            self._send_json(CONTROLLER.log_snapshot())
            return
        if self.path.startswith("/api/audio-devices"):
            self._send_json(DIAGNOSTICS.audio_devices())
            return
        if self.path.startswith("/api/run-checks"):
            self._send_json(CHECKS.run())
            return
        if self.path.startswith("/api/live-acceptance-window"):
            self._send_json(_live_acceptance_window({}))
            return
        self._send_json({"ok": False, "message": "Not found"}, status=404)

    def do_POST(self) -> None:
        payload = self._read_json()
        if self.path == "/api/start":
            self._send_json(CONTROLLER.start(payload))
            return
        if self.path == "/api/stop":
            self._send_json(CONTROLLER.stop(force=bool(payload.get("force"))))
            return
        if self.path == "/api/restart":
            self._send_json(CONTROLLER.restart(payload))
            return
        if self.path == "/api/brain/start":
            self._send_json(BRAIN.start())
            return
        if self.path == "/api/brain/stop":
            self._send_json(BRAIN.stop())
            return
        if self.path == "/api/run-checks":
            self._send_json(CHECKS.run())
            return
        if self.path == "/api/live-acceptance-window":
            self._send_json(_live_acceptance_window(payload))
            return
        if self.path == "/api/direct-local-voice-selftest":
            self._send_json(_direct_local_voice_selftest(payload))
            return
        if self.path == "/api/analyze-failed-turn-wavs":
            self._send_json(_analyze_failed_turn_wavs(payload))
            return
        if self.path == "/api/input-failover-probe":
            self._send_json(_input_failover_probe(payload))
            return
        if self.path == "/api/speaker-to-mic-selftest":
            self._send_json(_speaker_to_mic_selftest(payload))
            return
        if self.path == "/api/push-to-talk":
            self._send_json(_push_to_talk_once(payload))
            return
        if self.path == "/api/mic-calibration":
            self._send_json(_mic_calibration_once(payload))
            return
        self._send_json({"ok": False, "message": "Not found"}, status=404)


def main() -> int:
    parser = argparse.ArgumentParser(description="AVA Realtime Lab dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"[ui] AVA Realtime Lab running at {url}")
    print(f"[ui] Repo: {APP_DIR}")
    print("[ui] This dashboard stays up while realtime AVA starts and stops.")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ui] shutting down dashboard")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
