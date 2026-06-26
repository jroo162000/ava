"""
AVA Hybrid ASR Engine - Vosk + Whisper

Combines instant Vosk streaming with accurate Whisper final transcription.
- Vosk: Shows real-time partial results while speaking (~50ms latency)
- Whisper: Processes final buffer for accuracy (~6% WER)

Architecture:
1. Audio streams to Vosk for instant partial results
2. Audio accumulates in buffer
3. On silence detection, Whisper processes full buffer
4. Whisper result (more accurate) is sent to AVA
"""

import os
import sys
import json
import re
import struct
import time
import threading
import queue
import numpy as np
from typing import Callable, Optional, Tuple

# VOSK import
try:
    from vosk import Model as VoskModel, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)  # Suppress VOSK logs
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False
    print("[hybrid-asr] vosk not installed")

# Whisper import
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    print("[hybrid-asr] faster-whisper not installed")


class HybridASREngine:
    """
    Hybrid ASR combining Vosk (fast streaming) + Whisper (accurate final).
    
    Usage:
        engine = HybridASREngine(
            vosk_model_path="path/to/vosk-model",
            whisper_model="base.en",
            on_partial=lambda text: print(f"[partial] {text}"),
            on_final=lambda text: print(f"[final] {text}")
        )
        engine.start()
        
        # Feed audio chunks (16kHz, mono, int16)
        engine.feed_audio(audio_bytes)
        
        # When silence detected, get final result
        final_text = engine.get_final_result()
        
        engine.stop()
    """
    
    def __init__(
        self,
        vosk_model_path: str = None,
        whisper_model: str = "tiny.en",
        on_partial: Callable[[str], None] = None,
        on_final: Callable[[str], None] = None,
        sample_rate: int = 16000,
        silence_threshold: float = 500,  # RMS threshold
        silence_duration: float = 0.35,  # Seconds of silence before final
        min_audio_length: float = 0.45,  # Minimum audio to process (seconds) for short voice turns
        max_utterance_sec: float = 4.5,
        wake_words: list[str] | None = None,
        use_vosk_final_direct: bool = False,
        debug: bool = False
    ):
        self.vosk_model_path = vosk_model_path
        self.whisper_model_name = whisper_model
        _timeout_override = str(os.getenv('AVA_ASR_FINAL_TIMEOUT_SEC', '') or '').strip()
        if _timeout_override:
            try:
                self._final_timeout_sec = max(float(_timeout_override), 0.5)
            except Exception:
                self._final_timeout_sec = self._recommended_final_timeout(self.whisper_model_name)
        else:
            self._final_timeout_sec = self._recommended_final_timeout(self.whisper_model_name)
        self.on_partial = on_partial
        self.on_final = on_final
        self.sample_rate = sample_rate
        self.silence_threshold = silence_threshold
        self.silence_duration = silence_duration
        self.min_audio_bytes = int(sample_rate * 2 * min_audio_length)
        self.debug = debug
        
        # Models
        self.vosk_model = None
        self.vosk_recognizer = None
        self.whisper_model = None
        
        # Audio buffer for Whisper
        self._audio_buffer = bytearray()
        self._buffer_lock = threading.Lock()
        
        # State
        self._running = False
        self._last_speech_time = 0
        self._vosk_partial = ""
        self._vosk_final = ""
        
        # Whisper processing thread
        self._whisper_queue = queue.Queue()
        self._whisper_thread = None
        self._whisper_result = None
        self._whisper_done = threading.Event()
        self._whisper_state_lock = threading.Lock()
        self._whisper_job_seq = 0
        self._whisper_pending_response = None
        self._finalize_lock = threading.Lock()
        self._finalize_thread = None
        self._warmup_done = False
        self._last_final_meta = {}
        
        # Hallucination filter patterns
        self._hallucination_patterns = [
            "thank you", "thanks for watching", "subscribe",
            "like and subscribe", "see you", "bye", "goodbye",
            "music", "applause", "[music]", "[applause]",
            "subtitles", "captions", "translated by",
            "hey bob", "my house", "that's my house",
            "www.", ".com", ".org", "click", "bell",
        ]

        # Utterance timing and gating
        self._utt_start_ts = 0.0
        self._max_utt_sec = float(max_utterance_sec or 6.0)
        self.capture_enabled = True if (wake_words is None or len(wake_words) == 0) else False
        self._wake_words = [w.lower() for w in (wake_words or [])]
        self._prewake_buffer_max_bytes = int(sample_rate * 2 * max(float(max_utterance_sec or 4.5), 6.0))
        self.use_vosk_final_direct = bool(use_vosk_final_direct)
        self._last_rms_speech_time = 0.0
        self._last_partial_activity_time = 0.0
        self._partial_hold_duration = max(0.12, min(self.silence_duration * 0.5, 0.18))
        self._partial_rms_threshold = max(120.0, self.silence_threshold * 0.45)
        self._trace_enabled = os.environ.get("AVA_ASR_TRACE", "0") == "1"
        self._trace_throttle_sec = max(float(os.environ.get("AVA_ASR_TRACE_THROTTLE_SEC", "0.75") or "0.75"), 0.0)
        self._trace_last_emit = {}
        self._soft_wake_hint = False
        self._prewake_rescue_enabled = os.environ.get("AVA_ASR_PREWAKE_RESCUE", "0").strip().lower() in {"1", "true", "on", "yes"}
        self._prewake_query_rescue_enabled = os.environ.get("AVA_ASR_PREWAKE_QUERY_RESCUE", "1").strip().lower() in {"1", "true", "on", "yes"}

    def set_capture_enabled(self, enabled: bool):
        self.capture_enabled = bool(enabled)
        if not self.capture_enabled:
            with self._buffer_lock:
                self._audio_buffer.clear()
            self._utt_start_ts = 0.0
            self._last_speech_time = 0.0
            self._last_rms_speech_time = 0.0
            self._last_partial_activity_time = 0.0
            self._soft_wake_hint = False

    def _reset_utterance_state(self):
        """Reset ASR turn state after a final/discard path without touching model lifetime."""
        try:
            if self.vosk_recognizer:
                self.vosk_recognizer.Reset()
        except Exception:
            pass
        self._vosk_partial = ""
        self._vosk_final = ""
        self._last_speech_time = 0
        self._last_rms_speech_time = 0
        self._last_partial_activity_time = 0
        self._soft_wake_hint = False
        self._utt_start_ts = 0.0
        if self._wake_words:
            self.capture_enabled = False
        if hasattr(self, "_was_speaking_for_stop"):
            self._was_speaking_for_stop = False
        if hasattr(self, "_was_speaking"):
            self._was_speaking = False
    
    def _log(self, msg: str):
        if self.debug:
            print(f"[hybrid-asr] {msg}")

    def _trace(self, msg: str):
        if self._trace_enabled:
            key = None
            if msg.startswith("has_enough_audio reason=just_stopped_check"):
                key = "has_enough_audio:just_stopped_check"
            elif msg.startswith("just_stopped current=") and "rescue=1" not in msg and "wake_hint=1" not in msg and "soft_wake_command=1" not in msg:
                key = "just_stopped:steady"
            if key and self._trace_throttle_sec > 0:
                now = time.time()
                last = self._trace_last_emit.get(key, 0.0)
                if now - last < self._trace_throttle_sec:
                    return
                self._trace_last_emit[key] = now
            print(f"[hybrid-trace] {msg}")
    
    def _normalized_words(self, text: str) -> list[str]:
        cleaned = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()
        return cleaned.split()

    def _transcript_has_wake_word(self, text: str) -> bool:
        words = self._normalized_words(text)
        if not words or not self._wake_words:
            return False
        normalized = " ".join(words)
        wake_phrases = [" ".join(self._normalized_words(w)) for w in self._wake_words]
        return any(w and (normalized.startswith(w) or f" {w}" in normalized) for w in wake_phrases)

    def _transcript_has_soft_wake_hint(self, text: str) -> bool:
        words = self._normalized_words(text)
        if not words or not self._wake_words:
            return False
        normalized = " ".join(words)
        wake_phrases = [" ".join(self._normalized_words(w)) for w in self._wake_words]
        if any(w and (normalized.startswith(w) or f" {w}" in normalized) for w in wake_phrases):
            return True
        wake_tokens = {
            token
            for wake in wake_phrases
            for token in wake.split()
            if token and token not in {"hey", "ok"}
        }
        wake_tokens.update({"haber", "aber", "abba", "able", "abel", "buh"})
        for word in words[:3]:
            for token in wake_tokens:
                if word == token:
                    return True
                if word.endswith(token) and (len(word) - len(token)) <= 2:
                    return True
                if token.endswith(word) and (len(token) - len(word)) <= 1:
                    return True
        return False

    def _soft_wake_result_looks_command_like(self, text: str) -> bool:
        words = self._normalized_words(text)
        if len(words) < 2:
            return False
        has_soft_wake_hint = self._transcript_has_soft_wake_hint(text)
        if words[0] in {"hey", "hi", "hello"}:
            return bool(has_soft_wake_hint and len(words) >= 3)
        if has_soft_wake_hint:
            return True
        lead_commands = {
            "what", "when", "where", "who", "why", "how", "can", "could", "would", "should",
            "open", "close", "turn", "set", "start", "stop", "pause", "resume", "play", "search",
            "find", "tell", "show", "read", "write", "send", "create", "make", "give", "check",
            "run", "launch", "switch", "move", "scroll", "click", "type", "dictate", "remember",
        }
        return bool(words[0] in lead_commands or "?" in str(text or ""))

    def _prewake_query_hint(self, text: str) -> bool:
        """True when Vosk heard likely command/question content but missed the wake token."""
        if not text or not self._prewake_query_rescue_enabled:
            return False
        words = self._normalized_words(text)
        if not words:
            return False
        query_terms = {
            "what", "when", "where", "who", "why", "how",
            "time", "date", "today", "day", "name", "listening",
        }
        action_terms = {
            "tell", "show", "find", "search", "open", "close", "start", "stop",
            "turn", "set", "play", "pause", "resume", "read", "write", "send",
        }
        return bool(set(words[:8]) & (query_terms | action_terms))

    def _prewake_vosk_text_has_signal(self, text: str) -> bool:
        """Keep wake-like or command-like Vosk text before capture is armed."""
        if not self._wake_words or self.capture_enabled:
            return True
        if self._transcript_has_soft_wake_hint(text):
            return True
        if self._prewake_query_hint(text):
            return True
        return self._soft_wake_result_looks_command_like(text)

    def _vosk_fallback_can_rescue(self, text: str) -> bool:
        """Allow Vosk to rescue Whisper when it heard wake-ish command text."""
        if not text or not self._wake_words:
            return False
        if self._transcript_has_wake_word(text):
            return True
        return bool(
            self._transcript_has_soft_wake_hint(text)
            and self._soft_wake_result_looks_command_like(text)
        )

    def _recommended_final_timeout(self, model_name: str) -> float:
        name = str(model_name or "").lower()
        if "tiny" in name:
            return 7.5
        if "base" in name:
            return 9.5
        if "small" in name:
            return 12.0
        return 6.0

    def initialize(self) -> bool:
        """Load both VOSK and Whisper models"""
        success = True
        
        # Load VOSK
        if VOSK_AVAILABLE:
            # Prefer relative model under repo to avoid brittle absolute paths
            base_dir = os.path.dirname(__file__)
            vosk_paths = [
                self.vosk_model_path,
                os.path.join(base_dir, "vosk-models", "vosk-model-small-en-us-0.15"),
                r"C:\Users\USER 1\ava\ava-integration\vosk-models\vosk-model-small-en-us-0.15",
                "vosk-model-small-en-us-0.15",
                "model",
            ]

            for path in vosk_paths:
                if path and os.path.exists(path):
                    try:
                        self._log(f"Loading VOSK from '{path}'...")
                        self.vosk_model = VoskModel(path)
                        self.vosk_recognizer = KaldiRecognizer(self.vosk_model, self.sample_rate)
                        self.vosk_recognizer.SetWords(True)  # Enable word-level timing
                        print(f"[hybrid-asr] ✓ VOSK loaded (instant streaming)")
                        break
                    except Exception as e:
                        self._log(f"VOSK load error: {e}")

            if not self.vosk_model:
                print("[hybrid-asr] ✗ VOSK model not found")
                success = False
        else:
            print("[hybrid-asr] ✗ VOSK not available")
            success = False
        
        # Load Whisper
        if WHISPER_AVAILABLE:
            try:
                self._log(f"Loading Whisper '{self.whisper_model_name}'...")
                self.whisper_model = WhisperModel(
                    self.whisper_model_name, 
                    device="cpu", 
                    compute_type="int8"
                )
                print(f"[hybrid-asr] ✓ Whisper loaded ({self.whisper_model_name})")
            except Exception as e:
                print(f"[hybrid-asr] ✗ Whisper load error: {e}")
                success = False
        else:
            print("[hybrid-asr] ✗ Whisper not available")
            success = False
        
        return success

    def warmup(self) -> bool:
        """Prime Whisper once so the first real turn does not pay full cold-start cost."""
        if self._warmup_done:
            return True
        if not self.whisper_model:
            return False
        try:
            warm_samples = np.zeros(max(int(self.sample_rate * 0.2), 512), dtype=np.float32)
            warm_samples[len(warm_samples) // 2] = 0.02
            segments, _ = self.whisper_model.transcribe(
                warm_samples,
                beam_size=1,
                condition_on_previous_text=False,
                language="en",
                vad_filter=False,
            )
            list(segments)
            self._warmup_done = True
            self._log("Whisper warmup complete")
            return True
        except Exception as e:
            self._log(f"Whisper warmup error: {e}")
            return False
    
    def start(self):
        """Start the hybrid ASR engine"""
        if not self.vosk_model or not self.whisper_model:
            if not self.initialize():
                return False
        
        self._running = True
        
        # Start Whisper processing thread
        self._whisper_thread = threading.Thread(
            target=self._whisper_worker, 
            daemon=True, 
            name="HybridASR-Whisper"
        )
        self._whisper_thread.start()
        try:
            self.warmup()
        except Exception:
            pass
        
        return True
    
    def stop(self):
        """Stop the hybrid ASR engine"""
        self._running = False
        self._whisper_queue.put(None)  # Signal worker to stop
        if self._whisper_thread:
            self._whisper_thread.join(timeout=2.0)
        if self._finalize_thread and self._finalize_thread.is_alive():
            self._finalize_thread.join(timeout=0.5)
    
    def _rms(self, audio_bytes: bytes) -> float:
        """Calculate RMS of audio buffer"""
        if len(audio_bytes) < 2:
            return 0
        n = len(audio_bytes) // 2
        samples = struct.unpack('<' + 'h' * n, audio_bytes[:n*2])
        return (sum(s*s for s in samples) / n) ** 0.5

    def _buffered_audio_sec(self) -> float:
        with self._buffer_lock:
            return len(self._audio_buffer) / float(self.sample_rate * 2)
    
    def feed_audio(self, audio_bytes: bytes) -> Optional[str]:
        """
        Feed audio chunk to the hybrid engine.
        
        Returns:
            - Vosk partial result (instant feedback) if available
            - None if no result yet
        
        The audio is accumulated for Whisper processing.
        """
        if not self._running:
            return None
        
        now = time.time()
        rms = self._rms(audio_bytes)
        
        # Track speech activity
        if rms > self.silence_threshold:
            self._last_rms_speech_time = now
            self._last_speech_time = now
            if (self.capture_enabled or self._wake_words) and not self._utt_start_ts:
                self._utt_start_ts = now
                self._trace(
                    f"utt_start rms={int(rms)} capture={self.capture_enabled} "
                    f"wake_gated={bool(self._wake_words)} buf={len(self._audio_buffer)}"
                )
        
        # Keep a capped rolling buffer even before wake so Whisper can rescue missed wake words.
        should_buffer = self.capture_enabled or bool(self._wake_words)
        if should_buffer:
            with self._buffer_lock:
                self._audio_buffer.extend(audio_bytes)
                if self._wake_words and not self.capture_enabled and len(self._audio_buffer) > self._prewake_buffer_max_bytes:
                    overflow = len(self._audio_buffer) - self._prewake_buffer_max_bytes
                    del self._audio_buffer[:overflow]
        
        # Feed to VOSK for instant streaming
        if self.vosk_recognizer:
            try:
                if self.vosk_recognizer.AcceptWaveform(audio_bytes):
                    # Final result from VOSK (end of utterance detected)
                    result = json.loads(self.vosk_recognizer.Result())
                    text = result.get("text", "").strip()
                    if text:
                        if self._wake_words and not self.capture_enabled and not self._prewake_vosk_text_has_signal(text):
                            self._trace(f"suppress_prewake_vosk_final final='{text[:48]}'")
                            self._vosk_final = ""
                            self._vosk_partial = ""
                            self._last_speech_time = 0
                            self._last_rms_speech_time = 0
                            self._last_partial_activity_time = 0
                            try:
                                self.vosk_recognizer.Reset()
                            except Exception:
                                pass
                            return None
                        self._vosk_final = text
                        print(f"[vosk] FINAL: {text}")  # DEBUG
                        self._log(f"VOSK final: {text}")
                        if self._wake_words and not self.capture_enabled:
                            exact_wake_final = self._transcript_has_wake_word(text)
                            soft_wake_command_final = self._vosk_fallback_can_rescue(text)
                            if exact_wake_final:
                                self.capture_enabled = True
                                self._utt_start_ts = self._utt_start_ts or now
                                self._last_partial_activity_time = now
                                self._trace(
                                    f"wake_final final='{text}' rms={int(rms)} "
                                    f"buf={len(self._audio_buffer)}"
                                )
                            elif soft_wake_command_final:
                                self._soft_wake_hint = True
                                self._last_partial_activity_time = now
                                self._last_speech_time = now
                                self._trace(
                                    f"wake_soft_final_preserved final='{text}' rms={int(rms)} "
                                    f"buf={len(self._audio_buffer)}"
                                )
                            else:
                                self._log(f"Ignoring ungated VOSK final: '{text}'")
                                self._vosk_final = ""
                                self._vosk_partial = ""
                                self._last_speech_time = 0
                                self._last_rms_speech_time = 0
                                self._last_partial_activity_time = 0
                                try:
                                    self.vosk_recognizer.Reset()
                                except Exception:
                                    pass
                                return None
                        elif self._wake_words and self._transcript_has_soft_wake_hint(text) and not self._soft_wake_hint:
                            self._soft_wake_hint = True
                            self._trace(
                                f"wake_soft final='{text}' rms={int(rms)} "
                                f"buf={len(self._audio_buffer)}"
                            )

                        if self.use_vosk_final_direct:
                            if self.on_final:
                                print(f"[vosk] Calling on_final with: {text}")  # DEBUG
                                self.on_final(text)
                            with self._buffer_lock:
                                self._audio_buffer.clear()
                            self._last_speech_time = 0
                            self._vosk_partial = ""
                else:
                    # Partial result
                    result = json.loads(self.vosk_recognizer.PartialResult())
                    partial = result.get("partial", "").strip()
                    if partial:
                        # Wake gating: enable capture only after wake phrase seen in partials
                        try:
                            if not self.capture_enabled and self._wake_words:
                                if self._transcript_has_soft_wake_hint(partial) and not self._soft_wake_hint:
                                    self._soft_wake_hint = True
                                    self._trace(
                                        f"wake_soft partial='{partial}' rms={int(rms)} "
                                        f"buf={len(self._audio_buffer)}"
                                    )
                                if self._transcript_has_wake_word(partial):
                                    self.capture_enabled = True
                                    self._utt_start_ts = self._utt_start_ts or now
                                    self._last_partial_activity_time = now
                                    self._trace(
                                        f"wake_partial partial='{partial}' rms={int(rms)} "
                                        f"buf={len(self._audio_buffer)}"
                                    )
                        except Exception:
                            pass
                        if self._wake_words and not self.capture_enabled and not self._prewake_vosk_text_has_signal(partial):
                            if partial != self._vosk_partial:
                                self._trace(f"suppress_prewake_vosk_partial partial='{partial[:48]}'")
                            self._vosk_partial = ""
                            return None
                        # Partial text can bridge short gaps, but should not keep turns alive for seconds.
                        if rms >= self._partial_rms_threshold or (
                            self._last_rms_speech_time and (now - self._last_rms_speech_time) < self.silence_duration
                        ):
                            self._last_partial_activity_time = now
                            self._last_speech_time = now
                        if partial != self._vosk_partial:
                            self._vosk_partial = partial
                            print(f"[vosk] partial: {partial}")  # DEBUG
                            if self.on_partial:
                                self.on_partial(partial)
                            return partial
            except Exception as e:
                print(f"[vosk] ERROR: {e}")  # DEBUG
                self._log(f"VOSK error: {e}")
        
        # Hard utterance cutoff
        try:
            if self._utt_start_ts:
                utt_age = now - self._utt_start_ts
                audio_age = self._buffered_audio_sec()
                use_buffered_age = bool(self._wake_words and not self.capture_enabled)
                cutoff_age = audio_age if use_buffered_age else utt_age
                if cutoff_age > self._max_utt_sec:
                    enough_audio = self.has_enough_audio(trace_reason="hard_cutoff")
                    prewake_without_signal = bool(
                        self._wake_words
                        and not self.capture_enabled
                        and not self._transcript_has_wake_word(self._vosk_partial)
                        and not self._transcript_has_wake_word(self._vosk_final)
                        and not self._vosk_fallback_can_rescue(self._vosk_partial)
                        and not self._vosk_fallback_can_rescue(self._vosk_final)
                        and not self._prewake_query_hint(self._vosk_partial)
                        and not self._prewake_query_hint(self._vosk_final)
                    )
                    self._trace(
                        f"hard_cutoff age_ms={int(utt_age * 1000)} audio_ms={int(audio_age * 1000)} "
                        f"cutoff_ms={int(cutoff_age * 1000)} enough={enough_audio} "
                        f"capture={self.capture_enabled} partial='{self._vosk_partial[:32]}' "
                        f"final='{self._vosk_final[:32]}'"
                    )
                    if prewake_without_signal and not self._prewake_rescue_enabled:
                        self._trace("hard_cutoff_prewake_suppressed no wake/soft-wake signal")
                        self._reset_utterance_state()
                        with self._buffer_lock:
                            self._audio_buffer.clear()
                        return None
                    if enough_audio:
                        return self.get_final_result(trace_reason="hard_cutoff")
        except Exception:
            pass
        return self._vosk_partial if self._vosk_partial else None
    
    def is_speaking(self) -> bool:
        """Check if user is currently speaking"""
        now = time.time()
        if self._last_rms_speech_time and (now - self._last_rms_speech_time) < self.silence_duration:
            return True
        if self._last_partial_activity_time and (now - self._last_partial_activity_time) < self._partial_hold_duration:
            return True
        if self._last_speech_time == 0:
            return False
        return (now - self._last_speech_time) < self.silence_duration

    def just_started_speaking(self) -> bool:
        """Check if speech just started (one-shot trigger)"""
        if not hasattr(self, '_was_speaking'):
            self._was_speaking = False
        currently_speaking = self.is_speaking()
        just_started = currently_speaking and not self._was_speaking
        self._was_speaking = currently_speaking
        return just_started

    def just_stopped_speaking(self) -> bool:
        """Check if speech just stopped (one-shot trigger) - also triggers Whisper finalization"""
        if not hasattr(self, '_was_speaking_for_stop'):
            self._was_speaking_for_stop = False
        currently_speaking = self.is_speaking()
        enough_audio = self.has_enough_audio(trace_reason="just_stopped_check")
        with self._buffer_lock:
            buffered_bytes = len(self._audio_buffer)
        wake_hint = self._transcript_has_wake_word(self._vosk_partial) or self._transcript_has_wake_word(self._vosk_final)
        soft_wake_command_hint = (
            self._vosk_fallback_can_rescue(self._vosk_partial)
            or self._vosk_fallback_can_rescue(self._vosk_final)
        )
        prewake_query_hint = (
            self._prewake_query_hint(self._vosk_partial)
            or self._prewake_query_hint(self._vosk_final)
        )
        now = time.time()
        utt_age = (now - self._utt_start_ts) if self._utt_start_ts else 0.0
        prewake_whisper_rescue = bool(
            self._prewake_rescue_enabled
            and self._wake_words
            and not self.capture_enabled
            and enough_audio
            and self._was_speaking_for_stop
            and utt_age >= min(max(self._max_utt_sec, 1.5), 3.0)
        )
        defer_prewake = bool(
            self._wake_words
            and not self.capture_enabled
            and not wake_hint
            and not soft_wake_command_hint
            and not prewake_query_hint
            and not prewake_whisper_rescue
        )
        just_stopped = (
            (not currently_speaking and self._was_speaking_for_stop and enough_audio and not defer_prewake)
            or prewake_whisper_rescue
        )
        if self._was_speaking_for_stop != currently_speaking or just_stopped or defer_prewake:
            rms_age_ms = int(max(0.0, now - (self._last_rms_speech_time or 0.0)) * 1000) if self._last_rms_speech_time else -1
            partial_age_ms = int(max(0.0, now - (self._last_partial_activity_time or 0.0)) * 1000) if self._last_partial_activity_time else -1
            self._trace(
                f"just_stopped current={currently_speaking} prev={self._was_speaking_for_stop} "
                f"enough={enough_audio} defer_prewake={int(defer_prewake)} wake_hint={int(wake_hint)} "
                f"soft_wake_command={int(soft_wake_command_hint)} "
                f"query_hint={int(prewake_query_hint)} "
                f"rescue={int(prewake_whisper_rescue)} utt_age_ms={int(utt_age * 1000)} "
                f"buf={buffered_bytes} rms_age_ms={rms_age_ms} partial_age_ms={partial_age_ms}"
            )
        self._was_speaking_for_stop = currently_speaking
        if just_stopped:
            reason = "prewake_whisper_rescue" if prewake_whisper_rescue else "just_stopped_speaking"
            self.request_final_result(trace_reason=reason)
        return just_stopped
    
    def has_enough_audio(self, trace_reason: str | None = None) -> bool:
        """Check if buffer has enough audio to process"""
        with self._buffer_lock:
            buf_len = len(self._audio_buffer)
        enough = buf_len >= self.min_audio_bytes
        if trace_reason:
            self._trace(
                f"has_enough_audio reason={trace_reason} enough={enough} "
                f"buf={buf_len} min={self.min_audio_bytes}"
            )
        return enough

    def request_final_result(self, timeout: float | None = None, tts_active: bool = False,
                             echo_gate_active: bool = False, trace_reason: str = "manual") -> bool:
        """Finalize in the background so mic ingestion does not stall on Whisper."""
        timeout = float(timeout if timeout is not None else self._final_timeout_sec)
        enough_audio = self.has_enough_audio(trace_reason=f"request:{trace_reason}")
        if not enough_audio:
            self._trace(
                f"request_final_result skipped reason={trace_reason} timeout={timeout:.2f} "
                f"tts={tts_active} echo={echo_gate_active}"
            )
            return False
        if self._finalize_lock.locked():
            self._trace(f"request_final_result skipped reason={trace_reason} finalize_lock=busy")
            return False
        self._trace(
            f"request_final_result accepted reason={trace_reason} timeout={timeout:.2f} "
            f"tts={tts_active} echo={echo_gate_active}"
        )

        def _run():
            if not self._finalize_lock.acquire(blocking=False):
                self._trace(f"finalize_thread abandoned reason={trace_reason} acquire_failed")
                return
            try:
                self.get_final_result(
                    timeout=timeout,
                    tts_active=tts_active,
                    echo_gate_active=echo_gate_active,
                    trace_reason=trace_reason,
                )
            finally:
                self._finalize_lock.release()

        self._finalize_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="HybridASR-Finalize",
        )
        self._finalize_thread.start()
        return True
    
    def get_final_result(self, timeout: float | None = None, tts_active: bool = False,
                         echo_gate_active: bool = False, trace_reason: str = "manual") -> str:
        """
        Get final transcription from Whisper (most accurate).

        Call this when silence is detected after speech.
        Resets the buffer after processing.

        Args:
            timeout: Max wait for Whisper result (default 3s, reduced from 5s)
            tts_active: If True, TTS is playing — skip Whisper to prevent echo/stall
            echo_gate_active: If True, within echo-gate grace period — skip

        Returns:
            Whisper transcription (accurate) or empty string
        """
        timeout = float(timeout if timeout is not None else self._final_timeout_sec)
        self._last_final_meta = {}
        soft_wake_hint = self._soft_wake_hint
        if trace_reason == "hard_cutoff" and soft_wake_hint:
            timeout = max(timeout, self._final_timeout_sec + 1.5)
        self._trace(
            f"get_final_result enter reason={trace_reason} timeout={timeout:.2f} "
            f"tts={tts_active} echo={echo_gate_active} capture={self.capture_enabled} "
            f"soft_wake_hint={int(soft_wake_hint)}"
        )

        # GUARD: Do not dispatch Whisper while TTS is active or echo gate is up
        if tts_active or echo_gate_active:
            with self._buffer_lock:
                self._audio_buffer.clear()  # Discard echo audio
            self._reset_utterance_state()
            self._trace(f"get_final_result guard_clear reason={trace_reason}")
            return ""

        capture_was_open = self.capture_enabled
        vosk_fallback = self._vosk_final.strip()
        if not vosk_fallback and self._vosk_fallback_can_rescue(self._vosk_partial):
            vosk_fallback = self._vosk_partial.strip()
        with self._buffer_lock:
            if len(self._audio_buffer) < self.min_audio_bytes:
                self._audio_buffer.clear()
                self._reset_utterance_state()
                self._trace(
                    f"get_final_result short_buffer reason={trace_reason} "
                    f"buf={len(self._audio_buffer)} min={self.min_audio_bytes} fallback='{vosk_fallback[:32]}'"
                )
                return vosk_fallback

            audio_to_process = bytes(self._audio_buffer)
            self._audio_buffer.clear()
            self._trace(
                f"get_final_result dispatch reason={trace_reason} bytes={len(audio_to_process)} "
                f"fallback='{vosk_fallback[:32]}' capture_was_open={capture_was_open} "
                f"soft_wake_hint={int(soft_wake_hint)}"
            )

            # Pre-check RMS before dispatching to Whisper — avoid empty results
            try:
                n_samples = len(audio_to_process) // 2
                samples = struct.unpack('<' + 'h' * n_samples, audio_to_process)
                rms = (sum(s * s for s in samples) / n_samples) ** 0.5 / 32768.0
                if rms < 0.01:
                    self._reset_utterance_state()
                    self._trace(
                        f"get_final_result quiet_buffer reason={trace_reason} rms={rms:.4f} "
                        f"bytes={len(audio_to_process)}"
                    )
                    return ""
            except Exception:
                pass
        
        self._reset_utterance_state()
        
        # Process with Whisper
        response = {
            "id": None,
            "event": threading.Event(),
            "result": None,
            "cancelled": False,
            "error": None,
        }
        with self._whisper_state_lock:
            self._whisper_job_seq += 1
            job_id = self._whisper_job_seq
            response["id"] = job_id
            previous = self._whisper_pending_response
            self._whisper_pending_response = response
        if previous is not None:
            previous["cancelled"] = True
            previous["event"].set()

        drained_jobs = 0
        while True:
            try:
                stale_job = self._whisper_queue.get_nowait()
            except queue.Empty:
                break
            if stale_job is None:
                self._whisper_queue.put(None)
                break
            _, _, stale_response = stale_job
            stale_response["cancelled"] = True
            stale_response["event"].set()
            drained_jobs += 1
        if drained_jobs:
            self._trace(f"get_final_result drained_jobs reason={trace_reason} count={drained_jobs}")

        self._whisper_done.clear()
        self._whisper_result = None
        self._whisper_queue.put((job_id, audio_to_process, response))

        try:
            if response["event"].wait(timeout=timeout):
                if response.get("cancelled"):
                    self._trace(f"get_final_result superseded reason={trace_reason} job={job_id}")
                    return ""
                if response.get("error"):
                    self._log(f"Whisper worker error: {response['error']}")
                    self._trace(f"get_final_result whisper_error reason={trace_reason} job={job_id}")
                    return ""
                result = (response.get("result") or "").strip()
                self._trace(
                    f"get_final_result whisper_done reason={trace_reason} "
                    f"job={job_id} result_len={len(result)} fallback_len={len(vosk_fallback)}"
                )
                if result:
                    vosk_rescue = bool(
                        vosk_fallback
                        and not self._transcript_has_wake_word(result)
                        and self._vosk_fallback_can_rescue(vosk_fallback)
                    )
                    if vosk_rescue:
                        self._log(f"Using VOSK wake rescue over Whisper: '{vosk_fallback}' (whisper='{result}')")
                        self._last_final_meta = {
                            "source": "vosk_rescue",
                            "soft_wake_rescue": True,
                            "whisper_result": result,
                        }
                        if self.on_final:
                            self.on_final(vosk_fallback)
                        self._trace(
                            f"get_final_result vosk_wake_rescue reason={trace_reason} "
                            f"fallback='{vosk_fallback[:48]}' whisper='{result[:48]}'"
                        )
                        return vosk_fallback
                    allow_soft_wake_rescue = (
                        soft_wake_hint
                            and trace_reason in {"hard_cutoff", "just_stopped_speaking"}
                        and len(result.split()) >= 2
                        and self._soft_wake_result_looks_command_like(result)
                    )
                    if self._wake_words and not capture_was_open and not self._transcript_has_wake_word(result):
                        if not allow_soft_wake_rescue:
                            self._log(f"Suppressing Whisper final without wake: '{result}'")
                            self._trace(
                                f"get_final_result suppress_whisper_no_wake reason={trace_reason} "
                                f"result='{result[:48]}'"
                            )
                            return ""
                        self._trace(
                            f"get_final_result soft_wake_rescue reason={trace_reason} "
                            f"result='{result[:48]}'"
                        )
                    self._vosk_final = ""
                    self._last_final_meta = {
                        "source": "whisper",
                        "soft_wake_rescue": bool(allow_soft_wake_rescue),
                    }
                    if self.on_final:
                        self.on_final(result)
                    self._trace(f"get_final_result returning_whisper reason={trace_reason} text='{result[:48]}'")
                    return result

            self._log("Whisper timeout")
            self._trace(
                f"get_final_result whisper_timeout reason={trace_reason} job={job_id} fallback_len={len(vosk_fallback)}"
            )
        finally:
            with self._whisper_state_lock:
                if self._whisper_pending_response is response:
                    self._whisper_pending_response = None
        self._vosk_final = ""
        if vosk_fallback:
            vosk_rescue = self._vosk_fallback_can_rescue(vosk_fallback)
            if self._wake_words and not capture_was_open and not self._transcript_has_wake_word(vosk_fallback):
                if vosk_rescue:
                    self._trace(
                        f"get_final_result vosk_soft_wake_fallback reason={trace_reason} "
                        f"fallback='{vosk_fallback[:48]}'"
                    )
                else:
                    self._log(f"Suppressing VOSK fallback without wake: '{vosk_fallback}'")
                    self._trace(
                        f"get_final_result suppress_vosk_no_wake reason={trace_reason} "
                        f"fallback='{vosk_fallback[:48]}'"
                    )
                    return ""
            self._log(f"Using VOSK fallback: '{vosk_fallback}'")
            self._last_final_meta = {
                "source": "vosk",
                "soft_wake_rescue": bool(vosk_rescue and not self._transcript_has_wake_word(vosk_fallback)),
            }
            if self.on_final:
                self.on_final(vosk_fallback)
            self._trace(f"get_final_result returning_vosk reason={trace_reason} text='{vosk_fallback[:48]}'")
            return vosk_fallback
        self._trace(f"get_final_result empty reason={trace_reason}")
        return ""
    
    def _whisper_worker(self):
        """Background thread for Whisper processing"""
        while self._running:
            response = None
            try:
                job = self._whisper_queue.get(timeout=1.0)
                if job is None:
                    break

                job_id, audio_bytes, response = job
                result = self._transcribe_whisper(audio_bytes)
                if response.get("cancelled"):
                    self._trace(f"whisper_worker discard_cancelled job={job_id}")
                    continue
                response["result"] = result
                self._whisper_result = result
                self._whisper_done.set()
                response["event"].set()

            except queue.Empty:
                continue
            except Exception as e:
                print(f"[whisper-worker] ERROR: {e}")  # DEBUG
                self._log(f"Whisper worker error: {e}")
                if response is not None and not response.get("cancelled"):
                    response["error"] = str(e)
                    response["event"].set()
                self._whisper_done.set()
    
    def _audio_rms(self, audio_np: np.ndarray) -> float:
        if audio_np.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(audio_np * audio_np)))

    def _prepare_audio_for_whisper(self, audio_np: np.ndarray) -> Tuple[np.ndarray, dict]:
        audio_np = np.asarray(audio_np, dtype=np.float32)
        if audio_np.size == 0:
            return audio_np, {
                "raw_sec": 0.0,
                "raw_rms": 0.0,
                "threshold": 0.0,
                "trimmed": False,
                "prepared_sec": 0.0,
                "prepared_rms": 0.0,
                "gain": 1.0,
            }

        centered = audio_np - float(np.mean(audio_np))
        raw_rms = self._audio_rms(centered)
        stats = {
            "raw_sec": float(centered.size / self.sample_rate),
            "raw_rms": raw_rms,
            "threshold": 0.0,
            "trimmed": False,
            "prepared_sec": float(centered.size / self.sample_rate),
            "prepared_rms": raw_rms,
            "gain": 1.0,
        }

        if centered.size < max(160, int(self.sample_rate * 0.08)):
            return centered.astype(np.float32, copy=False), stats

        frame_size = max(160, int(self.sample_rate * 0.02))
        hop_size = max(80, int(self.sample_rate * 0.01))
        pad_before = int(self.sample_rate * 0.12)
        pad_after = int(self.sample_rate * 0.18)
        frame_rms = []
        last_offset = max(centered.size - frame_size, 0)

        for offset in range(0, last_offset + 1, hop_size):
            frame = centered[offset:offset + frame_size]
            frame_rms.append(self._audio_rms(frame))

        if not frame_rms:
            frame_rms.append(raw_rms)

        noise_floor = float(np.percentile(frame_rms, 20))
        speech_floor = max(0.0035, noise_floor * 2.8, raw_rms * 0.18)
        stats["threshold"] = speech_floor
        stats["expanded"] = False

        voiced_frames = [idx for idx, value in enumerate(frame_rms) if value >= speech_floor]
        prepared = centered
        speech_start = 0
        speech_end = centered.size
        if voiced_frames:
            speech_start = max(0, voiced_frames[0] * hop_size - pad_before)
            speech_end = min(centered.size, voiced_frames[-1] * hop_size + frame_size + pad_after)
            min_window = max(frame_size, int(self.sample_rate * 0.18))
            if speech_end - speech_start >= min_window:
                prepared = centered[speech_start:speech_end].copy()
                stats["trimmed"] = speech_start > 0 or speech_end < centered.size

        if stats["trimmed"]:
            min_prepared_sec = 0.55 if stats["raw_sec"] >= 0.8 else 0.35
            min_prepared_samples = int(self.sample_rate * min_prepared_sec)
            if prepared.size < min_prepared_samples and centered.size > prepared.size:
                center_sample = (speech_start + speech_end) // 2
                start = max(0, center_sample - (min_prepared_samples // 2))
                end = min(centered.size, start + min_prepared_samples)
                if end - start < min_prepared_samples:
                    start = max(0, end - min_prepared_samples)
                if end - start > prepared.size:
                    prepared = centered[start:end].copy()
                    stats["expanded"] = True

        prepared_rms = self._audio_rms(prepared)
        gain = 1.0
        if prepared_rms > 0.0:
            peak = float(np.max(np.abs(prepared)))
            target_rms = 0.075
            if prepared_rms < target_rms and peak > 0.0:
                gain = min(6.0, target_rms / prepared_rms, 0.98 / peak)
                if gain > 1.05:
                    prepared = np.clip(prepared * gain, -0.98, 0.98).astype(np.float32)
                    prepared_rms = self._audio_rms(prepared)

        stats["prepared_sec"] = float(prepared.size / self.sample_rate)
        stats["prepared_rms"] = prepared_rms
        stats["gain"] = float(gain)
        return prepared.astype(np.float32, copy=False), stats

    def _transcribe_whisper(self, audio_bytes: bytes) -> str:
        """Transcribe audio with Whisper + hallucination filtering"""
        if not self.whisper_model:
            return ""

        try:
            n_samples = len(audio_bytes) // 2
            if n_samples == 0:
                return ""

            samples = struct.unpack('<' + 'h' * n_samples, audio_bytes[:n_samples * 2])
            audio_np = np.array(samples, dtype=np.float32) / 32768.0
            raw_rms = self._audio_rms(audio_np)
            quiet_threshold = 0.0035
            if raw_rms < quiet_threshold:
                self._log("Audio too quiet, skipping")
                self._trace(f"whisper_audio quiet_raw sec={len(audio_np) / self.sample_rate:.2f} rms={raw_rms:.4f}")
                return ""

            prepared_audio, prepared_stats = self._prepare_audio_for_whisper(audio_np)
            prepared_rms = float(prepared_stats.get("prepared_rms") or 0.0)
            if prepared_audio.size == 0 or prepared_rms < quiet_threshold:
                self._log("Prepared audio too quiet, skipping")
                self._trace(
                    "whisper_audio quiet_prepared "
                    f"raw_sec={prepared_stats['raw_sec']:.2f} raw_rms={prepared_stats['raw_rms']:.4f} "
                    f"prepared_sec={prepared_stats['prepared_sec']:.2f} prepared_rms={prepared_rms:.4f}"
                )
                return ""

            use_vad = prepared_stats["prepared_sec"] > 1.4 and not prepared_stats["trimmed"]
            self._trace(
                "whisper_audio "
                f"raw_sec={prepared_stats['raw_sec']:.2f} raw_rms={prepared_stats['raw_rms']:.4f} "
                f"trimmed={int(bool(prepared_stats['trimmed']))} threshold={prepared_stats['threshold']:.4f} "
                f"prepared_sec={prepared_stats['prepared_sec']:.2f} prepared_rms={prepared_stats['prepared_rms']:.4f} "
                f"gain={prepared_stats['gain']:.2f} expanded={int(bool(prepared_stats.get('expanded')))} vad={int(use_vad)}"
            )

            start = time.time()
            transcribe_kwargs = dict(
                beam_size=1,
                condition_on_previous_text=False,
                language="en",
                vad_filter=use_vad,
            )
            if use_vad:
                transcribe_kwargs["vad_parameters"] = dict(
                    min_silence_duration_ms=160,
                    speech_pad_ms=120,
                )

            segments, info = self.whisper_model.transcribe(prepared_audio, **transcribe_kwargs)
            segments_list = list(segments)
            text = " ".join([seg.text for seg in segments_list]).strip()
            elapsed = time.time() - start

            if text:
                print(f"[whisper] Result: '{text}' ({elapsed:.2f}s, {len(segments_list)} segments)")
            else:
                self._trace(f"whisper_audio no_text elapsed={elapsed:.2f}s segments={len(segments_list)}")
            self._log(f"Whisper: '{text}' ({elapsed:.2f}s)")

            filtered = self._filter_hallucinations(text, prepared_audio)
            if filtered != text:
                print(f"[whisper-transcribe] Filtered: '{text}' -> '{filtered}'")  # DEBUG

            return filtered

        except Exception as e:
            self._log(f"Whisper error: {e}")
            return ""
    
    def _filter_hallucinations(self, text: str, audio_np: np.ndarray) -> str:
        """Filter common Whisper hallucinations"""
        if not text:
            return ""
        
        text_lower = text.lower().strip()
        
        # Filter short hallucinations
        if len(text) < 30:
            for pattern in self._hallucination_patterns:
                if pattern in text_lower:
                    self._log(f"Filtered hallucination: '{text}'")
                    return ""
        
        # Filter suspicious speech rate (hallucinations often have many words)
        audio_duration = len(audio_np) / 16000
        words = len(text.split())
        if audio_duration > 0.1:
            wps = words / audio_duration
            if wps > 6 and audio_duration < 2:
                self._log(f"Filtered fast speech ({wps:.1f} w/s): '{text}'")
                return ""
        
        # Filter if text is just filler words
        filler_words = {"huh", "um", "uh", "hmm", "ah", "oh", "mm"}
        if text_lower in filler_words:
            return ""
        
        return text
    
    def clear_buffer(self):
        """Clear the audio buffer (call during TTS playback to prevent echo)"""
        with self._buffer_lock:
            self._audio_buffer.clear()
        self._vosk_partial = ""
        self._vosk_final = ""
        self._last_speech_time = 0
        self._last_rms_speech_time = 0
        self._last_partial_activity_time = 0
        if self.vosk_recognizer:
            self.vosk_recognizer.Reset()


# Convenience function for simple usage
def create_hybrid_asr(
    vosk_model_path: str = None,
    whisper_model: str = "tiny.en",
    debug: bool = False
) -> HybridASREngine:
    """Create and initialize a hybrid ASR engine"""
    engine = HybridASREngine(
        vosk_model_path=vosk_model_path,
        whisper_model=whisper_model,
        debug=debug
    )
    if engine.initialize():
        return engine
    return None


if __name__ == "__main__":
    # Test the hybrid ASR
    import pyaudio
    
    print("=" * 60)
    print("Hybrid ASR Test (Vosk + Whisper)")
    print("=" * 60)
    
    def on_partial(text):
        print(f"\r🎤 {text}...", end="", flush=True)
    
    def on_final(text):
        print(f"\n✅ Final: {text}")
    
    engine = HybridASREngine(
        on_partial=on_partial,
        on_final=on_final,
        debug=True
    )
    
    if not engine.start():
        print("Failed to start engine")
        sys.exit(1)
    
    try:
        while True:
            audio = stream.read(1600, exception_on_overflow=False)
            engine.feed_audio(audio)
            
            # Check for silence after speech
            if not engine.is_speaking() and engine.has_enough_audio():
                final = engine.get_final_result()
                if final:
                    print(f">>> FINAL RESULT: {final}")
                print()
    
    except KeyboardInterrupt:
        print("\n\nStopping...")
    
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
        engine.stop()


