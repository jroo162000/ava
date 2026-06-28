import os
import threading
from typing import Callable, Optional


class VoiceSession:
    def __init__(self, provider) -> None:
        self.provider = provider
        self.tts = None
        self._playback_cb = None
        self._on_user_final: Optional[Callable[[str], None]] = None
        self._last_user_final_meta = None
        self._running = False
        self._stop_speaking_requested = threading.Event()
        # Subscribe to provider bus for finals
        try:
            self.provider.bus.subscribe(self._on_bus_event)
        except Exception:
            pass

    def _on_bus_event(self, ev) -> None:
        et = getattr(ev, 'type', None)
        if et == 'asr.final':
            txt = getattr(ev, 'text', '') or ''
            self._last_user_final_meta = getattr(ev, 'meta', None) or {}
            if self._on_user_final and txt:
                try:
                    self._on_user_final(txt)
                except Exception:
                    pass

    def on_user_final(self, cb: Callable[[str], None]) -> None:
        self._on_user_final = cb

    def set_tts(self, tts, playback_cb: Callable[[bytes], None]) -> None:
        self.tts = tts
        self._playback_cb = playback_cb

    def start(self) -> None:
        if not self._running:
            try:
                self.provider.start()
            except Exception:
                pass
            try:
                warmup = getattr(self.tts, 'warmup', None)
                if callable(warmup):
                    warmup()
            except Exception:
                pass
            self._running = True

    def stop(self) -> None:
        self._running = False
        self._stop_speaking_requested.set()
        try:
            self.provider.stop()
        except Exception:
            pass
        try:
            if self.tts:
                self.tts.stop()
        except Exception:
            pass

    def stop_speaking(self) -> None:
        self._stop_speaking_requested.set()
        try:
            if self.tts:
                cancel_current_utterance = getattr(self.tts, 'cancel_current_utterance', None)
                if callable(cancel_current_utterance):
                    cancel_current_utterance()
                else:
                    self.tts.stop()
        except Exception:
            pass

    def push_audio(self, pcm16: bytes) -> None:
        try:
            self.provider.push_audio(pcm16)
        except Exception:
            pass

    def speak(self, text: str) -> None:
        if not self.tts or not self._playback_cb or not text:
            return

        self._stop_speaking_requested.clear()
        chunks = [text]
        try:
            cfg = getattr(self, 'tts_chunking_cfg', None) or {}
            chunking_env = os.environ.get("AVA_TTS_CHUNKING", "0").strip().lower()
            enabled = bool(cfg.get('enabled', False)) and chunking_env in {"1", "true", "on", "yes"}
            engine = str(getattr(self.tts, 'engine', '') or getattr(self.tts, 'name', '') or '').lower()
            if enabled and engine == 'piper':
                from .tts.chunker import chunk_text_for_tts
                chunks = chunk_text_for_tts(
                    text,
                    max_words=int(cfg.get('max_words', 6)),
                    max_chars=int(cfg.get('max_chars', 60)),
                    min_words=int(cfg.get('min_words', 3)),
                ) or [text]
        except Exception:
            chunks = [text]

        # Emit simple tts lifecycle events via bus if available
        try:
            self.provider.bus.emit(type('E', (), {'type': 'tts.start', 'text': text}))
        except Exception:
            pass
        try:
            for chunk in chunks:
                if self._stop_speaking_requested.is_set():
                    break
                if not chunk:
                    continue
                try:
                    frame_ms = int(os.environ.get("AVA_PLAYBACK_FRAME_MS", "100") or "100")
                except Exception:
                    frame_ms = 100
                try:
                    self.tts.speak(chunk, self._playback_cb, frame_ms=frame_ms)
                except TypeError:
                    self.tts.speak(chunk, self._playback_cb)
                if self._stop_speaking_requested.is_set():
                    break
        finally:
            try:
                self.provider.bus.emit(type('E', (), {'type': 'tts.end'}))
            except Exception:
                pass
