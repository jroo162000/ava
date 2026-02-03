from __future__ import annotations
import threading
from typing import Optional, Dict, Any
from dataclasses import dataclass
from ..base import VoiceProvider
from ..bus import EventBus

# Inline simple VoiceEvent to avoid import conflict with voice/events/ package
@dataclass
class VoiceEvent:
    type: str
    text: Optional[str] = None
    audio: Optional[bytes] = None
    confidence: Optional[float] = None
    is_final: Optional[bool] = None
    meta: Optional[Dict[str, Any]] = None

try:
    # Import from root-level ava_hybrid_asr (not .hybrid_asr which has different class)
    from ava_hybrid_asr import HybridASREngine
    _HYBRID_AVAILABLE = True
except Exception as e:
    HybridASREngine = None  # type: ignore
    _HYBRID_AVAILABLE = False
    print(f"[local_hybrid] HybridASREngine import failed: {type(e).__name__}: {e}")


class LocalHybridProvider(VoiceProvider):
    def __init__(self, bus: EventBus, whisper_model: str = "small"):
        super().__init__(bus)
        self.whisper_model = whisper_model
        self.asr: Optional[HybridASREngine] = None  # type: ignore
        self._running = False
        self._speak_thread: Optional[threading.Thread] = None
        self._tts_stop = threading.Event()
        # Utterance tracking
        self._utt_seq = 0
        self._current_utt_id: Optional[str] = None
        self._in_utt = False
        # Simple two-frame VAD confirmation counter for barge-in gating
        self._gate_pos_frames = 0

    def start(self) -> None:
        if not _HYBRID_AVAILABLE:
            raise RuntimeError("Hybrid ASR not available")
        self._running = True
        self._tts_stop.clear()

        # Early commit support: if partial stable for a short window and short phrase, emit final early
        self._last_partial = ""
        self._last_partial_ts = 0.0
        self._early_final_sent = False

        def on_partial(txt: str, conf: float | None = None):
            if not txt:
                return
            # Start new utterance if needed
            import time as _time
            if not self._in_utt:
                self._utt_seq += 1
                self._current_utt_id = f"utt-{int(_time.time()*1000)}-{self._utt_seq}"
                self._in_utt = True
            self.bus.emit(VoiceEvent(type="asr.partial", text=txt, confidence=conf, is_final=False, meta={
                "utterance_id": self._current_utt_id,
                "early": False,
            }))
            # Track stability for early commit - BE MORE CONSERVATIVE to avoid false activations
            now = __import__('time').time()
            if txt != self._last_partial:
                self._last_partial = txt
                self._last_partial_ts = now
                self._early_final_sent = False
            else:
                # Only emit early final for very short, common commands
                # Vosk partials are often wrong (e.g., "anna the attack"), so be conservative
                words = txt.split()
                word_count = len(words)
                
                # Only early-commit very short phrases (1-3 words) after longer stability
                # This prevents false activations from garbled Vosk transcriptions
                if not self._early_final_sent and (now - (self._last_partial_ts or now)) >= 0.5:  # was 0.3
                    # Only very short phrases to reduce false positives
                    if word_count <= 3:  # was 8
                        # Additional safety: require minimum confidence or common command words
                        common_commands = {'stop', 'cancel', 'abort', 'yes', 'no', 'okay', 'hey', 'ava', 
                                         'hello', 'hi', 'pause', 'continue', 'next', 'back', 'quit'}
                        first_word = words[0].lower() if words else ''
                        
                        # Only early-commit if it looks like a command or is very short
                        if word_count <= 2 or first_word in common_commands:
                            try:
                                print(f"[early-commit] Emitting early final: '{txt}'")
                                self.bus.emit(VoiceEvent(type="asr.final", text=txt, is_final=True, meta={
                                    "utterance_id": self._current_utt_id,
                                    "early": True,
                                }))
                                self._early_final_sent = True
                            except Exception:
                                pass

        def on_final(txt: str):
            if not txt:
                return
            self.bus.emit(VoiceEvent(type="asr.final", text=txt, is_final=True, meta={
                "utterance_id": self._current_utt_id,
                "early": False,
            }))
            # Reset utterance state
            self._in_utt = False
            self._current_utt_id = None

        self.asr = HybridASREngine(
            whisper_model=self.whisper_model,
            on_partial=on_partial,
            on_final=on_final,
            sample_rate=16000,
        )
        ok = self.asr.start()
        if not ok:
            raise RuntimeError("Hybrid ASR failed to start")

    def stop(self) -> None:
        self._running = False
        self.stop_speaking()
        try:
            if self.asr:
                self.asr.stop()
        finally:
            self.asr = None

    def push_audio(self, pcm16: bytes) -> None:
        if not self._running or not self.asr:
            # DEBUG: print why we're not feeding
            if not hasattr(self, '_dbg_skip_count'):
                self._dbg_skip_count = 0
            self._dbg_skip_count += 1
            if self._dbg_skip_count % 50 == 1:
                print(f"[provider] SKIPPING audio: running={self._running} asr={self.asr is not None}")
            return
        try:
            self.asr.feed_audio(pcm16)
        except Exception as e:
            print(f"[provider] feed_audio error: {e}")

        # Optional VAD exposure – if engine supports transitions, emit here.
        try:
            if getattr(self.asr, 'just_started_speaking', None) and self.asr.just_started_speaking():
                self.bus.emit(VoiceEvent(type="vad.start"))
            if getattr(self.asr, 'just_stopped_speaking', None) and self.asr.just_stopped_speaking():
                self.bus.emit(VoiceEvent(type="vad.end"))
        except Exception:
            pass

    def speak(self, text: str) -> None:
        # This provider does not include TTS; session/core will attach TTS.
        # Emit start/end events only.
        self.bus.emit(VoiceEvent(type="tts.start", text=text))
        self.bus.emit(VoiceEvent(type="tts.end"))

    def stop_speaking(self) -> None:
        self._tts_stop.set()
