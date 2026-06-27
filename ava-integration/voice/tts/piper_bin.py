import json
import os
import queue
import subprocess
import threading
import time
import wave
from typing import Callable, Optional


class PiperBinTTS:
    """Local TTS via a persistent Piper binary process.

    Piper's biggest latency spike is voice-model load. Keep one process alive and
    feed it one utterance per line so only startup pays that cost.
    """

    def __init__(self, exe_path: str, model_path: str) -> None:
        self.exe_path = exe_path
        self.model_path = model_path
        self.engine = "piper"
        self.name = "piper"
        self.current_sample_rate = self._load_sample_rate()
        self._proc: Optional[subprocess.Popen] = None
        self._proc_lock = threading.RLock()
        self._speak_lock = threading.Lock()
        self._event_queue: queue.Queue = queue.Queue()
        self._ready_event = threading.Event()
        self._stop_requested = threading.Event()
        self._cancel_requested = threading.Event()
        self._utterance_idle = threading.Event()
        self._utterance_idle.set()
        self._stdout_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._drain_thread: Optional[threading.Thread] = None

    def _load_sample_rate(self) -> int:
        config_path = f"{self.model_path}.json"
        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            audio_cfg = cfg.get("audio") or {}
            sample_rate = int(audio_cfg.get("sample_rate") or 22050)
            if sample_rate > 0:
                return sample_rate
        except Exception:
            pass
        return 22050

    def _build_args(self) -> list[str]:
        espeak_dir = os.path.join(os.path.dirname(self.exe_path), "espeak-ng-data")
        args = [self.exe_path, "-m", self.model_path, "-f", "-", "--output_raw"]
        if os.path.isdir(espeak_dir):
            args += ["--espeak_data", espeak_dir]
        return args

    def _stdout_reader(self, proc: subprocess.Popen, event_queue: queue.Queue) -> None:
        out = proc.stdout
        if out is None:
            event_queue.put(("eof", None))
            return

        while True:
            try:
                chunk = out.read(4096)
            except Exception:
                chunk = b""
            if not chunk:
                event_queue.put(("eof", None))
                return
            event_queue.put(("audio", chunk))

    def _stderr_reader(
        self,
        proc: subprocess.Popen,
        event_queue: queue.Queue,
        ready_event: threading.Event,
    ) -> None:
        err = proc.stderr
        if err is None:
            return

        while True:
            try:
                raw_line = err.readline()
            except Exception:
                raw_line = b""
            if not raw_line:
                return

            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            lowered = line.lower()
            if "initialized piper" in lowered:
                ready_event.set()
            elif "real-time factor:" in lowered:
                event_queue.put(("utterance_done", None))
            elif "terminated piper" in lowered:
                event_queue.put(("terminated", None))

    def _terminate_process_locked(self) -> None:
        proc = self._proc
        self._proc = None
        self._stop_requested.set()
        self._cancel_requested.set()
        self._utterance_idle.set()
        try:
            self._event_queue.put_nowait(("stopped", None))
        except Exception:
            pass

        if proc is None:
            return

        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except Exception:
                    proc.kill()
                    proc.wait(timeout=2.0)
        except Exception:
            pass

    def _ensure_process(self) -> Optional[subprocess.Popen]:
        with self._proc_lock:
            if self._proc and self._proc.poll() is None:
                return self._proc

            self._terminate_process_locked()
            self._event_queue = queue.Queue()
            self._ready_event = threading.Event()
            self._stop_requested.clear()
            self._cancel_requested.clear()
            self._utterance_idle.set()

            if not (os.path.isfile(self.exe_path) and os.path.isfile(self.model_path)):
                return None

            try:
                proc = subprocess.Popen(
                    self._build_args(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                    creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                )
            except Exception:
                return None

            self._proc = proc
            q = self._event_queue
            ready_event = self._ready_event
            self._stdout_thread = threading.Thread(
                target=self._stdout_reader,
                args=(proc, q),
                daemon=True,
                name="PiperStdout",
            )
            self._stderr_thread = threading.Thread(
                target=self._stderr_reader,
                args=(proc, q, ready_event),
                daemon=True,
                name="PiperStderr",
            )
            self._stdout_thread.start()
            self._stderr_thread.start()
            return proc

    def _drain_events(self) -> None:
        while True:
            try:
                self._event_queue.get_nowait()
            except queue.Empty:
                return

    def _wait_for_idle(self, timeout: float = 1.0) -> bool:
        if self._utterance_idle.wait(timeout=max(timeout, 0.0)):
            return True

        with self._proc_lock:
            self._terminate_process_locked()
        self._utterance_idle.set()
        return False

    def _cancel_drain_loop(self, proc: subprocess.Popen, event_queue: queue.Queue) -> None:
        utterance_done = False
        done_deadline: Optional[float] = None
        hard_deadline = time.time() + 1.5

        try:
            while True:
                if self._stop_requested.is_set():
                    break

                timeout = 0.05 if utterance_done else 0.10
                try:
                    event_type, _ = event_queue.get(timeout=timeout)
                except queue.Empty:
                    if utterance_done and done_deadline and time.time() >= done_deadline:
                        break
                    if proc.poll() is not None:
                        break
                    if time.time() >= hard_deadline:
                        with self._proc_lock:
                            if self._proc is proc and proc.poll() is None:
                                self._terminate_process_locked()
                        break
                    continue

                if event_type == "utterance_done":
                    utterance_done = True
                    done_deadline = time.time() + 0.25
                elif event_type in {"eof", "terminated", "stopped"}:
                    break
        finally:
            self._cancel_requested.clear()
            self._utterance_idle.set()

    def _start_cancel_drain(self, proc: subprocess.Popen) -> None:
        if self._drain_thread and self._drain_thread.is_alive():
            return

        event_queue = self._event_queue

        def _run() -> None:
            self._cancel_drain_loop(proc, event_queue)

        drain_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="PiperCancelDrain",
        )
        self._drain_thread = drain_thread
        drain_thread.start()

    def warmup(self, timeout: float = 5.0) -> bool:
        proc = self._ensure_process()
        if proc is None:
            return False
        if self._ready_event.is_set():
            return True

        deadline = time.time() + max(timeout, 0.1)
        while time.time() < deadline:
            if self._ready_event.wait(timeout=0.1):
                return True
            if proc.poll() is not None:
                break
        return self._ready_event.is_set()

    def _send_text(self, proc: subprocess.Popen, text: str) -> Optional[subprocess.Popen]:
        payload = (text.strip() + "\n").encode("utf-8", errors="ignore")
        for _ in range(2):
            try:
                if proc.stdin is None:
                    return None
                proc.stdin.write(payload)
                proc.stdin.flush()
                return proc
            except Exception:
                with self._proc_lock:
                    self._terminate_process_locked()
                    proc = self._ensure_process()
                if proc is None:
                    return None
                self.warmup(timeout=5.0)
                self._drain_events()
        return None

    def speak(self, text: str, on_chunk: Callable[[bytes], None], frame_ms: int | None = None) -> None:
        """Speak `text`, streaming 16-bit mono PCM frames to `on_chunk`."""
        if not text:
            return

        with self._speak_lock:
            self._wait_for_idle(timeout=0.75)
            proc = self._ensure_process()
            if proc is None:
                return

            self.warmup(timeout=5.0)
            self._stop_requested.clear()
            self._cancel_requested.clear()
            self._drain_events()
            self._utterance_idle.clear()
            proc = self._send_text(proc, text)
            if proc is None:
                self._utterance_idle.set()
                return

            if frame_ms is None:
                try:
                    frame_ms = int(os.environ.get("AVA_PLAYBACK_FRAME_MS", "100") or "100")
                except Exception:
                    frame_ms = 100
            frame_ms = max(20, min(int(frame_ms), 200))
            samples_per_frame = max(int(self.current_sample_rate * (frame_ms / 1000.0)), 1)
            frame_bytes = samples_per_frame * 2
            pcm_buf = b""
            utterance_done = False
            done_deadline: Optional[float] = None
            cancel_mode = False

            debug_wav_path = os.getenv("AVA_DEBUG_LAST_TTS_WAV", "").strip()
            debug_wav = None
            if debug_wav_path:
                try:
                    debug_wav = wave.open(debug_wav_path, "wb")
                    debug_wav.setnchannels(1)
                    debug_wav.setsampwidth(2)
                    debug_wav.setframerate(self.current_sample_rate)
                except Exception:
                    debug_wav = None

            def _emit_frames() -> None:
                nonlocal pcm_buf, done_deadline
                while len(pcm_buf) >= frame_bytes:
                    frame = pcm_buf[:frame_bytes]
                    pcm_buf = pcm_buf[frame_bytes:]
                    on_chunk(frame)
                if utterance_done:
                    done_deadline = time.time() + 0.20

            try:
                while True:
                    if self._stop_requested.is_set():
                        break

                    timeout = 0.05 if utterance_done else 0.25
                    try:
                        event_type, payload = self._event_queue.get(timeout=timeout)
                    except queue.Empty:
                        if self._cancel_requested.is_set():
                            cancel_mode = True
                            pcm_buf = b""
                            self._start_cancel_drain(proc)
                            break
                        if utterance_done and done_deadline and time.time() >= done_deadline:
                            break
                        if proc.poll() is not None:
                            break
                        continue

                    if self._cancel_requested.is_set() or event_type == "cancel":
                        cancel_mode = True
                        pcm_buf = b""
                        self._start_cancel_drain(proc)
                        break

                    if event_type == "audio":
                        chunk = payload or b""
                        if debug_wav is not None:
                            try:
                                debug_wav.writeframes(chunk)
                            except Exception:
                                pass
                        pcm_buf += chunk
                        _emit_frames()
                    elif event_type == "utterance_done":
                        utterance_done = True
                        done_deadline = time.time() + 0.25
                    elif event_type in {"eof", "terminated", "stopped"}:
                        break

                if not self._stop_requested.is_set() and not cancel_mode and pcm_buf:
                    pad = (-len(pcm_buf)) % frame_bytes
                    if pad:
                        pcm_buf += b"\x00" * pad
                    _emit_frames()
            except Exception:
                pass
            finally:
                try:
                    if debug_wav is not None:
                        debug_wav.close()
                except Exception:
                    pass
                if not cancel_mode:
                    self._cancel_requested.clear()
                    self._utterance_idle.set()

    def cancel_current_utterance(self) -> None:
        if self._utterance_idle.is_set():
            return
        self._cancel_requested.set()
        try:
            self._event_queue.put_nowait(("cancel", None))
        except Exception:
            pass

    def stop(self) -> None:
        with self._proc_lock:
            self._terminate_process_locked()
