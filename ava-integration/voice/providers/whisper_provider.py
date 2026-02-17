"""
Whisper STT Provider
====================
Local batch ASR using faster-whisper (offline).
"""

import struct
import time
import asyncio
from typing import AsyncIterator, Optional, List
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from .base import STTProvider, TranscriptionResult

# Whisper imports
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False


class WhisperProvider:
    """Whisper local batch STT provider.

    Provides high-accuracy transcription (~6% WER) with batch processing.
    Works completely offline after model download.

    Note: This is a batch processor, not streaming. Audio is accumulated
    and processed when get_final_result() is called.

    Usage:
        provider = WhisperProvider(model="base.en")
        await provider.connect()

        # Accumulate audio
        await provider.send_audio(audio_bytes)

        # Get final transcription
        result = await provider.get_final_result()
        print(result.text)

        await provider.disconnect()
    """

    # Common hallucination patterns to filter
    HALLUCINATION_PATTERNS = [
        "thank you", "thanks for watching", "subscribe",
        "like and subscribe", "see you", "bye", "goodbye",
        "music", "applause", "[music]", "[applause]",
        "subtitles", "captions", "translated by",
        "www.", ".com", ".org", "click", "bell",
    ]

    def __init__(
        self,
        model: str = "base.en",
        device: str = "cpu",
        compute_type: str = "int8",
        language: str = "en",
        beam_size: int = 5,
        use_vad: bool = True,
        filter_hallucinations: bool = True,
        debug: bool = False,
    ):
        """Initialize Whisper provider.

        Args:
            model: Whisper model name (tiny, base, small, medium, large)
            device: Compute device (cpu, cuda)
            compute_type: Precision (int8, float16, float32)
            language: Language code
            beam_size: Beam search size
            use_vad: Use Silero VAD filter
            filter_hallucinations: Filter common hallucinations
            debug: Enable debug output
        """
        if not WHISPER_AVAILABLE:
            raise RuntimeError("faster-whisper not installed. Run: pip install faster-whisper")

        self._model_name = model
        self._device = device
        self._compute_type = compute_type
        self._language = language
        self._beam_size = beam_size
        self._use_vad = use_vad
        self._filter_hallucinations = filter_hallucinations
        self._debug = debug

        self._model: Optional[WhisperModel] = None
        self._connected = False

        # Audio buffer
        self._audio_buffer = bytearray()
        self._sample_rate = 16000
        self._min_audio_bytes = int(self._sample_rate * 2 * 0.3)  # Min 0.3 seconds

        # Thread pool for blocking transcription
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")

    @property
    def name(self) -> str:
        """Provider name."""
        return "whisper"

    @property
    def is_streaming(self) -> bool:
        """Whisper does NOT support real-time streaming."""
        return False

    @property
    def is_connected(self) -> bool:
        """Whether provider is connected/initialized."""
        return self._connected

    async def connect(self) -> bool:
        """Load Whisper model.

        Returns:
            True if loaded successfully
        """
        if self._connected:
            return True

        try:
            if self._debug:
                print(f"[whisper] Loading model '{self._model_name}'...")

            self._model = WhisperModel(
                self._model_name,
                device=self._device,
                compute_type=self._compute_type,
            )

            self._connected = True
            print(f"[whisper] Model '{self._model_name}' loaded")
            return True

        except Exception as e:
            print(f"[whisper] Failed to load model: {e}")
            return False

    async def disconnect(self) -> None:
        """Clean up Whisper resources."""
        self._model = None
        self._connected = False
        self._audio_buffer.clear()
        self._executor.shutdown(wait=False)

    async def send_audio(self, audio_bytes: bytes) -> None:
        """Accumulate audio for batch processing.

        Args:
            audio_bytes: PCM audio data (16-bit, mono)
        """
        self._audio_buffer.extend(audio_bytes)

    async def receive_transcription(self) -> AsyncIterator[TranscriptionResult]:
        """Whisper doesn't support streaming - this yields nothing.

        Use get_final_result() instead.
        """
        # Whisper is batch only - no streaming results
        return
        yield  # Make this a generator

    async def get_final_result(self, timeout: float = 10.0) -> Optional[TranscriptionResult]:
        """Transcribe accumulated audio.

        Args:
            timeout: Maximum processing time

        Returns:
            TranscriptionResult or None
        """
        if not self._model:
            return None

        if len(self._audio_buffer) < self._min_audio_bytes:
            if self._debug:
                print(f"[whisper] Buffer too small: {len(self._audio_buffer)} bytes")
            return None

        # Get audio and clear buffer
        audio_bytes = bytes(self._audio_buffer)
        self._audio_buffer.clear()

        # Run transcription in thread pool
        loop = asyncio.get_event_loop()
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    self._executor,
                    self._transcribe_sync,
                    audio_bytes
                ),
                timeout=timeout
            )
            return result
        except asyncio.TimeoutError:
            if self._debug:
                print("[whisper] Transcription timeout")
            return None
        except Exception as e:
            if self._debug:
                print(f"[whisper] Transcription error: {e}")
            return None

    def _transcribe_sync(self, audio_bytes: bytes) -> Optional[TranscriptionResult]:
        """Synchronous transcription (runs in thread).

        Args:
            audio_bytes: PCM audio data

        Returns:
            TranscriptionResult or None
        """
        if not self._model:
            return None

        try:
            # Convert bytes to float numpy array
            n_samples = len(audio_bytes) // 2
            samples = struct.unpack('<' + 'h' * n_samples, audio_bytes)
            audio_np = np.array(samples, dtype=np.float32) / 32768.0

            # Check audio energy
            rms = np.sqrt(np.mean(audio_np ** 2))
            if rms < 0.01:
                if self._debug:
                    print("[whisper] Audio too quiet")
                return None

            # Transcribe
            start_time = time.time()

            vad_params = {}
            if self._use_vad:
                vad_params = dict(
                    min_silence_duration_ms=300,
                    speech_pad_ms=200
                )

            segments, info = self._model.transcribe(
                audio_np,
                beam_size=self._beam_size,
                language=self._language,
                vad_filter=self._use_vad,
                vad_parameters=vad_params if self._use_vad else None,
            )

            # Collect segments
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text)

            text = " ".join(text_parts).strip()
            elapsed = time.time() - start_time

            if self._debug:
                print(f"[whisper] '{text}' ({elapsed:.2f}s)")

            # Filter hallucinations
            if self._filter_hallucinations:
                text = self._filter_hallucination_text(text, audio_np)

            if not text:
                return None

            return TranscriptionResult(
                text=text,
                is_final=True,
                confidence=0.9,  # Whisper typically has high accuracy
                provider=self.name,
                latency_ms=elapsed * 1000,
                language=info.language if hasattr(info, 'language') else self._language,
            )

        except Exception as e:
            if self._debug:
                print(f"[whisper] Transcription error: {e}")
            return None

    def _filter_hallucination_text(
        self,
        text: str,
        audio_np: np.ndarray
    ) -> str:
        """Filter common Whisper hallucinations.

        Args:
            text: Transcribed text
            audio_np: Audio numpy array

        Returns:
            Filtered text or empty string
        """
        if not text:
            return ""

        text_lower = text.lower().strip()

        # Filter short hallucinations
        if len(text) < 30:
            for pattern in self.HALLUCINATION_PATTERNS:
                if pattern in text_lower:
                    if self._debug:
                        print(f"[whisper] Filtered hallucination: '{text}'")
                    return ""

        # Filter suspicious speech rate
        audio_duration = len(audio_np) / self._sample_rate
        words = len(text.split())

        if audio_duration > 0.1:
            wps = words / audio_duration
            if wps > 6 and audio_duration < 2:
                if self._debug:
                    print(f"[whisper] Filtered fast speech ({wps:.1f} w/s): '{text}'")
                return ""

        # Filter filler words
        filler_words = {"huh", "um", "uh", "hmm", "ah", "oh", "mm"}
        if text_lower in filler_words:
            return ""

        return text

    def reset(self) -> None:
        """Reset audio buffer."""
        self._audio_buffer.clear()

    def clear_buffer(self) -> None:
        """Clear accumulated audio buffer."""
        self._audio_buffer.clear()


# Convenience function
def create_whisper_provider(
    model: str = "base.en",
    debug: bool = False
) -> Optional[WhisperProvider]:
    """Create and initialize Whisper provider.

    Args:
        model: Whisper model name
        debug: Enable debug output

    Returns:
        Initialized WhisperProvider or None
    """
    if not WHISPER_AVAILABLE:
        print("[whisper] faster-whisper not available")
        return None

    provider = WhisperProvider(model=model, debug=debug)
    return provider
