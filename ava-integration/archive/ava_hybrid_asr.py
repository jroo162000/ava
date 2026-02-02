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
        whisper_model: str = "base.en",
        on_partial: Callable[[str], None] = None,
        on_final: Callable[[str], None] = None,
        sample_rate: int = 16000,
        silence_threshold: float = 500,  # RMS threshold
        silence_duration: float = 0.5,   # Seconds of silence before final
        min_audio_length: float = 0.3,   # Minimum audio to process (seconds)
        debug: bool = False
    ):
        self.vosk_model_path = vosk_model_path
        self.whisper_model_name = whisper_model
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
        
        # Hallucination filter patterns
        self._hallucination_patterns = [
            "thank you", "thanks for watching", "subscribe",
            "like and subscribe", "see you", "bye", "goodbye",
            "music", "applause", "[music]", "[applause]",
            "subtitles", "captions", "translated by",
            "hey bob", "my house", "that's my house",
            "www.", ".com", ".org", "click", "bell",
        ]
    
    def _log(self, msg: str):
        if self.debug:
            print(f"[hybrid-asr] {msg}")
    
    def initialize(self) -> bool:
        """Load both VOSK and Whisper models"""
        success = True
        
        # Load VOSK
        if VOSK_AVAILABLE:
            vosk_paths = [
                self.vosk_model_path,
                r"C:\Users\USER 1\ava-integration\vosk-models\vosk-model-small-en-us-0.15",
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
        
        return True
    
    def stop(self):
        """Stop the hybrid ASR engine"""
        self._running = False
        self._whisper_queue.put(None)  # Signal worker to stop
        if self._whisper_thread:
            self._whisper_thread.join(timeout=2.0)
    
    def _rms(self, audio_bytes: bytes) -> float:
        """Calculate RMS of audio buffer"""
        if len(audio_bytes) < 2:
            return 0
        n = len(audio_bytes) // 2
        samples = struct.unpack('<' + 'h' * n, audio_bytes[:n*2])
        return (sum(s*s for s in samples) / n) ** 0.5
    
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
            self._last_speech_time = now
        
        # Accumulate for Whisper
        with self._buffer_lock:
            self._audio_buffer.extend(audio_bytes)
        
        # Feed to VOSK for instant streaming
        if self.vosk_recognizer:
            try:
                if self.vosk_recognizer.AcceptWaveform(audio_bytes):
                    # Final result from VOSK (end of utterance detected)
                    result = json.loads(self.vosk_recognizer.Result())
                    text = result.get("text", "").strip()
                    if text:
                        self._vosk_final = text
                        print(f"[vosk] FINAL: {text}")  # DEBUG
                        self._log(f"VOSK final: {text}")
                        # Use Vosk final directly (Whisper is too slow for realtime)
                        # Emit on_final with Vosk's result immediately
                        if self.on_final:
                            print(f"[vosk] Calling on_final with: {text}")  # DEBUG
                            self.on_final(text)
                        # Clear the audio buffer since we've processed this utterance
                        with self._buffer_lock:
                            self._audio_buffer.clear()
                        self._last_speech_time = 0
                else:
                    # Partial result
                    result = json.loads(self.vosk_recognizer.PartialResult())
                    partial = result.get("partial", "").strip()
                    if partial:
                        # Vosk detected speech - update speech time regardless of RMS
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
        
        return self._vosk_partial if self._vosk_partial else None
    
    def is_speaking(self) -> bool:
        """Check if user is currently speaking"""
        if self._last_speech_time == 0:
            return False
        return (time.time() - self._last_speech_time) < self.silence_duration

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
        just_stopped = not currently_speaking and self._was_speaking_for_stop and self.has_enough_audio()
        self._was_speaking_for_stop = currently_speaking
        if just_stopped:
            # Trigger Whisper finalization
            self.get_final_result()
        return just_stopped
    
    def has_enough_audio(self) -> bool:
        """Check if buffer has enough audio to process"""
        with self._buffer_lock:
            return len(self._audio_buffer) >= self.min_audio_bytes
    
    def get_final_result(self, timeout: float = 5.0) -> str:
        """
        Get final transcription from Whisper (most accurate).

        Call this when silence is detected after speech.
        Resets the buffer after processing.

        Returns:
            Whisper transcription (accurate) or empty string
        """
        with self._buffer_lock:
            print(f"[whisper] Buffer size: {len(self._audio_buffer)} bytes (min: {self.min_audio_bytes})")  # DEBUG
            if len(self._audio_buffer) < self.min_audio_bytes:
                print(f"[whisper] Buffer too small, skipping")  # DEBUG
                self._log(f"Buffer too small: {len(self._audio_buffer)} bytes")
                return ""

            audio_to_process = bytes(self._audio_buffer)
            self._audio_buffer.clear()
            print(f"[whisper] Processing {len(audio_to_process)} bytes of audio")  # DEBUG
        
        # Reset VOSK state
        if self.vosk_recognizer:
            self.vosk_recognizer.Reset()
        self._vosk_partial = ""
        self._vosk_final = ""
        self._last_speech_time = 0
        
        # Process with Whisper
        self._whisper_done.clear()
        self._whisper_result = None
        self._whisper_queue.put(audio_to_process)
        
        # Wait for result
        print(f"[whisper] Waiting for result (timeout={timeout}s)...")  # DEBUG
        if self._whisper_done.wait(timeout=timeout):
            result = self._whisper_result
            print(f"[whisper] Got result: '{result}'")  # DEBUG
            if result:
                print(f"[whisper] Calling on_final callback...")  # DEBUG
                if self.on_final:
                    self.on_final(result)
                return result
            else:
                print(f"[whisper] Result was empty")  # DEBUG

        print(f"[whisper] Timeout waiting for result")  # DEBUG
        self._log("Whisper timeout")
        return ""
    
    def _whisper_worker(self):
        """Background thread for Whisper processing"""
        print("[whisper-worker] Thread started")  # DEBUG
        while self._running:
            try:
                print("[whisper-worker] Waiting for audio...")  # DEBUG
                audio_bytes = self._whisper_queue.get(timeout=1.0)
                if audio_bytes is None:
                    print("[whisper-worker] Got None, exiting")  # DEBUG
                    break

                print(f"[whisper-worker] Got {len(audio_bytes)} bytes, transcribing...")  # DEBUG
                result = self._transcribe_whisper(audio_bytes)
                print(f"[whisper-worker] Transcription result: '{result}'")  # DEBUG
                self._whisper_result = result
                self._whisper_done.set()
                print("[whisper-worker] Done set")  # DEBUG

            except queue.Empty:
                continue
            except Exception as e:
                print(f"[whisper-worker] ERROR: {e}")  # DEBUG
                self._log(f"Whisper worker error: {e}")
                self._whisper_done.set()
    
    def _transcribe_whisper(self, audio_bytes: bytes) -> str:
        """Transcribe audio with Whisper + hallucination filtering"""
        print(f"[whisper-transcribe] Starting, model={self.whisper_model is not None}")  # DEBUG
        if not self.whisper_model:
            print("[whisper-transcribe] No model!")  # DEBUG
            return ""

        try:
            # Convert bytes to numpy
            n_samples = len(audio_bytes) // 2
            samples = struct.unpack('<' + 'h' * n_samples, audio_bytes)
            audio_np = np.array(samples, dtype=np.float32) / 32768.0

            # Check energy
            rms = np.sqrt(np.mean(audio_np ** 2))
            print(f"[whisper-transcribe] Audio RMS: {rms:.4f}")  # DEBUG
            if rms < 0.01:
                print(f"[whisper-transcribe] Audio too quiet (rms={rms:.4f} < 0.01), skipping")  # DEBUG
                self._log("Audio too quiet, skipping")
                return ""
            
            # Transcribe
            start = time.time()
            print(f"[whisper-transcribe] Calling Whisper model...")  # DEBUG
            segments, info = self.whisper_model.transcribe(
                audio_np,
                beam_size=5,
                language="en",
                vad_filter=True,  # Use Silero VAD
                vad_parameters=dict(
                    min_silence_duration_ms=300,
                    speech_pad_ms=200
                )
            )
            segments_list = list(segments)
            text = " ".join([seg.text for seg in segments_list]).strip()
            elapsed = time.time() - start

            print(f"[whisper-transcribe] Raw result: '{text}' ({elapsed:.2f}s, {len(segments_list)} segments)")  # DEBUG
            self._log(f"Whisper: '{text}' ({elapsed:.2f}s)")

            # Filter hallucinations
            filtered = self._filter_hallucinations(text, audio_np)
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
        if self.vosk_recognizer:
            self.vosk_recognizer.Reset()


# Convenience function for simple usage
def create_hybrid_asr(
    vosk_model_path: str = None,
    whisper_model: str = "base.en",
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
    
    print("\nSpeak something (Ctrl+C to stop)...")
    print("-" * 60)
    
    p = pyaudio.PyAudio()
    stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=16000,
        input=True,
        frames_per_buffer=1600
    )
    
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
