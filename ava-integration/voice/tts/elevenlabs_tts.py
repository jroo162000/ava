"""
ElevenLabs streaming TTS engine for AVA (fallback voice).

Matches the PiperBinTTS / EdgeStreamTTS interface so it can be dropped in:
  - current_sample_rate      : int, sample rate of emitted PCM16 mono chunks
  - warmup(timeout) -> bool
  - speak(text, on_chunk, frame_ms=None)
  - cancel_current_utterance()
  - stop()

No third-party SDK required (uses urllib streaming). Requires an ElevenLabs API
key, read from an environment variable (default ELEVENLABS_API_KEY) so the key is
never stored in the repo. This engine needs internet; it is intended as a FALLBACK
for when the local Piper voice is unavailable.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from typing import Callable, Optional

# ElevenLabs raw PCM output formats -> sample rate (PCM is signed 16-bit mono).
_PCM_RATES = {
    "pcm_16000": 16000,
    "pcm_22050": 22050,
    "pcm_24000": 24000,
    "pcm_44100": 44100,
}


class ElevenLabsTTS:
    def __init__(
        self,
        voice_id: str,
        api_key: Optional[str] = None,
        api_key_env: str = "ELEVENLABS_API_KEY",
        model_id: str = "eleven_flash_v2_5",
        output_format: str = "pcm_24000",
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        timeout: float = 30.0,
    ) -> None:
        self.voice_id = str(voice_id or "").strip()
        self.api_key = (api_key or os.getenv(api_key_env, "") or "").strip()
        self.model_id = model_id
        self.output_format = output_format if output_format in _PCM_RATES else "pcm_24000"
        self.current_sample_rate = _PCM_RATES[self.output_format]
        self.voice_settings = {
            "stability": float(stability),
            "similarity_boost": float(similarity_boost),
            "style": float(style),
            "use_speaker_boost": True,
        }
        self.timeout = float(timeout)
        self._cancel = threading.Event()
        self._stopped = False
        if not self.api_key:
            raise RuntimeError(
                f"ElevenLabs API key not set (env {api_key_env})."
            )
        if not self.voice_id:
            raise RuntimeError("ElevenLabs voice_id not set in config.")

    def warmup(self, timeout: float = 5.0) -> bool:
        # Nothing to preload for a cloud engine.
        return bool(self.api_key and self.voice_id)

    def speak(self, text: str, on_chunk: Callable[[bytes], None], frame_ms: Optional[int] = None) -> None:
        if self._stopped or not text:
            return
        self._cancel.clear()
        url = (
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream"
            f"?output_format={self.output_format}"
        )
        body = json.dumps(
            {"text": text, "model_id": self.model_id, "voice_settings": self.voice_settings}
        ).encode("utf-8")
        req = urllib.request.Request(
            url=url,
            data=body,
            headers={
                "xi-api-key": self.api_key,
                "Content-Type": "application/json",
                "Accept": "audio/pcm",
            },
            method="POST",
        )
        if frame_ms and frame_ms > 0:
            frame_bytes = max(2, int(self.current_sample_rate * (frame_ms / 1000.0)) * 2)
        else:
            frame_bytes = 4096
        buf = bytearray()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                while not (self._cancel.is_set() or self._stopped):
                    data = resp.read(frame_bytes)
                    if not data:
                        break
                    buf.extend(data)
                    while len(buf) >= frame_bytes:
                        if self._cancel.is_set() or self._stopped:
                            return
                        on_chunk(bytes(buf[:frame_bytes]))
                        del buf[:frame_bytes]
            if buf and not self._cancel.is_set() and not self._stopped:
                on_chunk(bytes(buf))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="ignore")[:200]
            except Exception:
                pass
            print(f"[elevenlabs-tts] HTTP {exc.code}: {detail}")
        except Exception as exc:  # noqa: BLE001 - keep voice loop alive on any network error
            print(f"[elevenlabs-tts] error: {exc}")

    def cancel_current_utterance(self) -> None:
        self._cancel.set()

    def stop(self) -> None:
        self._stopped = True
        self._cancel.set()
