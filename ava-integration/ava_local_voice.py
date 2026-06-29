"""
Minimal local realtime voice runner for AVA.

This is intentionally separate from the legacy realtime monolith. It keeps
the hot path small and half-duplex:

LISTENING -> FINALIZING -> RESPONDING -> SPEAKING -> COOLDOWN -> LISTENING

Design choices:
- Local Whisper final transcript only; no Vosk prewake streaming loop.
- Wake word is validated on the final transcript.
- One response boundary: local AVA server /respond.
- One TTS lifecycle per reply: Piper only.
- Mic capture is paused while speaking.
"""

from __future__ import annotations

import audioop
import argparse
import json
import os
import queue
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import pyaudio
from faster_whisper import WhisperModel

from voice.tts.piper_bin import PiperBinTTS

try:
    from vosk import Model as VoskModel, KaldiRecognizer, SetLogLevel

    SetLogLevel(-1)
    VOSK_AVAILABLE = True
except Exception:
    VOSK_AVAILABLE = False
    VoskModel = None
    KaldiRecognizer = None


APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "ava_voice_config.json"

# --- Spoken-pronunciation lexicon, applied right before TTS so EVERY spoken path is covered
# (server replies, proactive announcements, local speech). Seeded with her own name:
# "AVA"/"Ava" -> "Aiva" which this Piper pronounces /ˈeɪvə/ ("AY-vuh") instead of "AH-vuh" or
# spelled-out "A. V. A.". Extend ava_pronunciations.json (case-insensitive whole words; keys
# starting with _ are ignored) to teach new names. Only changes how things SOUND, not the text.
_PRON_LEXICON = None
def _load_pron_lexicon() -> dict:
    global _PRON_LEXICON
    if _PRON_LEXICON is not None:
        return _PRON_LEXICON
    lex = {"ava": "Aiva"}  # built-in seed so her name is always right
    try:
        p = APP_DIR / "ava_pronunciations.json"
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            for k, v in (data or {}).items():
                if k and not k.startswith("_") and isinstance(v, str) and v.strip():
                    lex[k.lower()] = v.strip()
    except Exception:
        pass
    _PRON_LEXICON = lex
    return lex

def _apply_pron_lexicon(text: str) -> str:
    if os.environ.get("AVA_PRON_LEXICON_OFF") == "1":
        return text or ""
    s = text or ""
    for word, say in _load_pron_lexicon().items():
        s = re.sub(r"\b" + re.escape(word) + r"\b", say, s, flags=re.IGNORECASE)
    return s
DEFAULT_SERVER_URL = "http://127.0.0.1:5051/respond"
TARGET_ASR_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1
FORMAT = pyaudio.paInt16

WAKE_PHRASES = [
    "hey ava",
    "ok ava",
    "ava",
    "aba",
    "hey eva",
    "eva",
    "hey able",
    "able",
    "abel",
    "aber",
]

SOFT_WAKE_PHRASES = [
    "hey bud",
    "hey but",
]

COMMAND_VERBS = {
    "open", "search", "create", "type", "send", "close", "start", "stop",
    "run", "delete", "move", "rename", "copy", "paste", "click", "scroll",
    "navigate", "install", "download", "upload", "write", "edit", "save",
    "launch", "kill", "terminate", "shutdown", "restart", "pause", "resume",
    "turn", "set", "change", "switch", "enable", "disable", "execute",
    "find", "show", "play", "record", "capture", "screenshot", "take",
    "make", "build", "deploy", "push", "pull", "commit", "format",
    "remember", "forget",
}


def _log(message: str) -> None:
    print(f"[local-voice] {message}", flush=True)


def _load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _cfg_float(cfg: dict, env_name: str, cfg_name: str, default: float) -> float:
    try:
        value = os.getenv(env_name)
        if value is None:
            value = cfg.get(cfg_name)
        return float(value)
    except Exception:
        return float(default)


def _cfg_int(cfg: dict, env_name: str, cfg_name: str, default: int) -> int:
    try:
        value = os.getenv(env_name)
        if value is None:
            value = cfg.get(cfg_name)
        return int(value)
    except Exception:
        return int(default)


def _normalize(text: str) -> str:
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _clean_command_after_wake(text: str) -> str:
    normalized = _normalize(text)
    if not normalized:
        return ""
    cleaned = f" {normalized} "
    cleanup_phrases = WAKE_PHRASES + SOFT_WAKE_PHRASES + ["hey"]
    for phrase in sorted(cleanup_phrases, key=len, reverse=True):
        phrase_norm = _normalize(phrase)
        if phrase_norm:
            cleaned = re.sub(rf"\b{re.escape(phrase_norm)}\b", " ", cleaned)
    words = re.sub(r"\s+", " ", cleaned).strip().split()
    if not words:
        return ""
    if len(words) % 2 == 0:
        half = len(words) // 2
        if words[:half] == words[half:]:
            words = words[:half]
    return " ".join(words)


def _strip_wake(text: str) -> tuple[bool, str]:
    normalized = _normalize(text)
    if not normalized:
        return False, ""

    # Handle common ASR splits/misrecognitions without accepting arbitrary speech.
    normalized = normalized.replace("a va", "ava")
    normalized = normalized.replace("a bar", "aber")

    for phrase in sorted(WAKE_PHRASES, key=len, reverse=True):
        phrase_norm = _normalize(phrase)
        if normalized == phrase_norm:
            return True, ""
        if normalized.startswith(phrase_norm + " "):
            return True, _clean_command_after_wake(normalized[len(phrase_norm):].strip())

    for phrase in sorted(SOFT_WAKE_PHRASES, key=len, reverse=True):
        phrase_norm = _normalize(phrase)
        if normalized == phrase_norm:
            return True, ""
        if normalized.startswith(phrase_norm + " "):
            return True, _clean_command_after_wake(normalized[len(phrase_norm):].strip())

    words = normalized.split()
    first_window = " ".join(words[:4])
    for phrase in sorted(WAKE_PHRASES, key=len, reverse=True):
        phrase_norm = _normalize(phrase)
        if phrase_norm in first_window:
            remainder = _clean_command_after_wake(normalized.split(phrase_norm, 1)[1].strip())
            return True, remainder
    return False, normalized


def _local_fact_reply(command_text: str) -> Optional[str]:
    text = _normalize(command_text)
    if not text:
        return None
    if any(p in text for p in ("what time", "time is it", "current time", "the time")):
        now = datetime.now().strftime("%#I:%M %p" if os.name == "nt" else "%-I:%M %p")
        return f"It's {now}."
    if any(p in text for p in (
        "what is today", "what s today", "what day", "what date",
        "today s date", "date today", "date is it", "the date",
    )):
        today = datetime.now().strftime("%A, %B %#d, %Y" if os.name == "nt" else "%A, %B %-d, %Y")
        return f"Today is {today}."
    if any(p in text for p in ("who are you", "what are you", "your name")):
        return "I'm AVA, your local voice assistant."
    return None


def _is_conversational_command(text: str) -> bool:
    normalized = _normalize(text)
    if not normalized:
        return False
    conversational_patterns = (
        "tell me about yourself",
        "tell me who you are",
        "who are you",
        "what are you",
        "your name",
        "about yourself",
    )
    return any(pattern in normalized for pattern in conversational_patterns)


def _should_allow_tools(text: str) -> bool:
    # Allow tools for any request that isn't pure self-intro chit-chat. The old
    # fixed verb list ('open','send',...) blocked common phrasings like
    # "read my email", "what's on my calendar", "list my files", "check my
    # messages" because their verbs weren't in the set. The agent loop / LLM
    # still decides whether a tool is actually needed.
    if _is_conversational_command(text):
        return False
    return True


def _server_respond(text: str, config: dict) -> str:
    url = str(config.get("server_url") or DEFAULT_SERVER_URL)
    if not url.rstrip("/").endswith("/respond"):
        url = DEFAULT_SERVER_URL

    tools_allowed = _should_allow_tools(text)
    payload = {
        "sessionId": "local-voice",
        "messages": [{"role": "user", "content": text}],
        "freshSession": True,
        "run_tools": tools_allowed,
        "allow_write": tools_allowed,
        "voice_mode": "spoken",
        "spoken_reply_budget": {
            "max_sentences": 300,
            "max_words": 4000,
            "prefer_brief": False,
        },
        "persona": "AVA",
        "style": "first_person",
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            data = json.loads(raw.decode("utf-8", errors="ignore"))
        text_out = (
            data.get("output_text")
            or data.get("text")
            or ((data.get("content") or [{}])[0].get("text"))
            or ""
        )
        return str(text_out).strip()
    except urllib.error.HTTPError as exc:
        _log(f"/respond HTTP error: {exc}")
    except Exception as exc:
        _log(f"/respond error: {exc}")
    return ""


def _resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if not pcm or src_rate == dst_rate:
        return pcm
    converted, _ = audioop.ratecv(pcm, SAMPLE_WIDTH, CHANNELS, int(src_rate), int(dst_rate), None)
    return converted


def _safe_slug(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(text or "debug")).strip("_") or "debug"


@dataclass
class InputStream:
    stream: object
    rate: int
    frames_per_buffer: int
    device_index: Optional[int]
    device_name: str


class SyntheticWavInputStream:
    """Finite PyAudio-like stream for exercising the live capture loop from WAV."""

    def __init__(
        self,
        wav_path: Path,
        *,
        calibration_silence_sec: float = 1.2,
        post_silence_sec: float = 1.2,
    ) -> None:
        with wave.open(str(wav_path), "rb") as wf:
            channels = int(wf.getnchannels())
            sampwidth = int(wf.getsampwidth())
            self.rate = int(wf.getframerate())
            frames = int(wf.getnframes())
            pcm = wf.readframes(frames)

        if channels > 1:
            pcm = audioop.tomono(pcm, sampwidth, 0.5, 0.5)
            channels = 1
        if sampwidth != SAMPLE_WIDTH:
            pcm = audioop.lin2lin(pcm, sampwidth, SAMPLE_WIDTH)

        silence_frame = b"\0" * SAMPLE_WIDTH * channels
        prefix_frames = max(0, int(self.rate * max(0.0, calibration_silence_sec)))
        suffix_frames = max(0, int(self.rate * max(0.0, post_silence_sec)))
        self._pcm = silence_frame * prefix_frames + pcm + silence_frame * suffix_frames
        self._pos = 0
        self.eof = False

    def read(self, frames: int, exception_on_overflow: bool = False) -> bytes:
        del exception_on_overflow
        frame_count = max(1, int(frames))
        time.sleep(frame_count / float(max(1, self.rate)))
        size = frame_count * SAMPLE_WIDTH * CHANNELS
        end = self._pos + size
        chunk = self._pcm[self._pos : end]
        self._pos = min(end, len(self._pcm))
        if self._pos >= len(self._pcm):
            self.eof = True
        if len(chunk) < size:
            chunk += b"\0" * (size - len(chunk))
        return chunk

    def stop_stream(self) -> None:
        pass

    def close(self) -> None:
        pass


@dataclass
class CapturedUtterance:
    pcm: bytes
    src_rate: int
    duration_sec: float
    voiced_sec: float
    peak_rms: int
    mean_rms: int
    start_rms: int
    stop_rms: int


def _captured_utterance_from_wav(
    wav_path: Path,
    *,
    start_rms: int = 500,
    stop_rms: int = 220,
    frame_ms: int = 30,
) -> CapturedUtterance:
    with wave.open(str(wav_path), "rb") as wf:
        channels = int(wf.getnchannels())
        sampwidth = int(wf.getsampwidth())
        rate = int(wf.getframerate())
        frames = int(wf.getnframes())
        pcm = wf.readframes(frames)

    if channels > 1:
        pcm = audioop.tomono(pcm, sampwidth, 0.5, 0.5)
        channels = 1
    if sampwidth != SAMPLE_WIDTH:
        pcm = audioop.lin2lin(pcm, sampwidth, SAMPLE_WIDTH)

    frame_samples = max(1, int(rate * max(10, int(frame_ms)) / 1000))
    frame_bytes = frame_samples * SAMPLE_WIDTH * channels
    rms_values = [
        audioop.rms(pcm[i : i + frame_bytes], SAMPLE_WIDTH)
        for i in range(0, len(pcm), frame_bytes)
        if pcm[i : i + frame_bytes]
    ]
    duration = len(pcm) / float(max(1, rate * SAMPLE_WIDTH * channels))
    voiced_frames = sum(1 for value in rms_values if value >= stop_rms)
    peak = max(rms_values) if rms_values else 0
    mean = int(sum(rms_values) / len(rms_values)) if rms_values else 0
    return CapturedUtterance(
        pcm=pcm,
        src_rate=rate,
        duration_sec=duration,
        voiced_sec=voiced_frames * (frame_samples / float(max(1, rate))),
        peak_rms=peak,
        mean_rms=mean,
        start_rms=start_rms,
        stop_rms=stop_rms,
    )


class LocalVoiceRunner:
    def __init__(self) -> None:
        self.config = _load_config()
        self.audio = pyaudio.PyAudio()
        self.running = True
        self.input_stream: Optional[InputStream] = None
        self.output_stream = None
        self.whisper: Optional[WhisperModel] = None
        self.vosk_model = None
        self.tts: Optional[PiperBinTTS] = None
        self.followup_until = 0.0
        self.no_wake_streak = 0
        # Default -1: disable the Vosk pre-gate so the accurate Whisper final makes the wake
        # decision. The Vosk small model mis-hears "Ava" (e.g. haber/eight/either/evil) on many
        # mics and was blocking valid wake words. Set AVA_LOCAL_WAKE_GATE_AFTER>=0 to re-enable.
        self.wake_gate_after_no_wake = int(os.getenv("AVA_LOCAL_WAKE_GATE_AFTER", "-1") or "-1")
        self.last_wake_gate_rescue_at = 0.0
        self.wake_gate_fallback_transcript = ""
        self.last_transcript = ""
        self.last_command = ""
        self.last_reply = ""
        self.last_spoken_text = ""
        self.last_accepted = False
        self.last_ignored_reason = ""
        # Serializes all TTS output so the proactive-announcement thread never overlaps a reply.
        self._speak_lock = threading.RLock()
        self._announce_thread: Optional[threading.Thread] = None

    def close(self) -> None:
        self.running = False
        try:
            if self.input_stream:
                self.input_stream.stream.stop_stream()
                self.input_stream.stream.close()
        except Exception:
            pass
        try:
            if self.output_stream:
                self.output_stream.stop_stream()
                self.output_stream.close()
        except Exception:
            pass
        try:
            if self.tts:
                self.tts.stop()
        except Exception:
            pass
        try:
            self.audio.terminate()
        except Exception:
            pass

    def _device_info(self, idx: int) -> dict:
        return dict(self.audio.get_device_info_by_index(idx))

    def _open_input(self) -> InputStream:
        audio_cfg = self.config.get("audio") or {}
        configured_idx = os.getenv("AVA_INPUT_DEVICE") or audio_cfg.get("input_device")
        configured_rate = int(audio_cfg.get("input_sample_rate") or 44100)
        default_blocklist = ["webcam", "c920e"]
        blocklist = default_blocklist + [
            str(x).lower() for x in audio_cfg.get("input_device_blocklist") or []
        ]
        avoid = [str(x).lower() for x in audio_cfg.get("input_device_avoid") or []]
        preferences = [str(x).lower() for x in audio_cfg.get("input_device_preferences") or []]
        try:
            configured_idx_int = int(configured_idx) if configured_idx is not None else None
        except Exception:
            configured_idx_int = None

        def blocked(name: str) -> bool:
            low_name = name.lower()
            return any(term in low_name for term in blocklist)

        def host_api_name(info: dict) -> str:
            try:
                host = self.audio.get_host_api_info_by_index(int(info.get("hostApi") or 0))
                return str(host.get("name") or "")
            except Exception:
                return ""

        def close_stream(stream: object) -> None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass

        def baseline_rms(stream: object, frames: int) -> tuple[int, int]:
            values: list[int] = []
            for _ in range(8):
                data = stream.read(frames, exception_on_overflow=False)
                values.append(audioop.rms(data, SAMPLE_WIDTH))
            if not values:
                return 0, 0
            ordered = sorted(values)
            return ordered[len(ordered) // 2], max(values)

        candidates: list[tuple[int, int, str, int, str]] = []
        for idx in range(self.audio.get_device_count()):
            try:
                info = self._device_info(idx)
                if int(info.get("maxInputChannels") or 0) <= 0:
                    continue
                name = str(info.get("name") or "")
                low = name.lower()
                host_name = host_api_name(info)
                host_low = host_name.lower()
                if blocked(name):
                    if configured_idx_int == idx:
                        _log(f"configured_input_blocked={name} idx={idx}")
                    continue
                penalty = 0
                if any(term in low for term in avoid):
                    penalty += 100
                for pref_idx, term in enumerate(preferences):
                    if term and term in low:
                        penalty -= max(5, 25 - pref_idx * 5)
                if "microphone" in low:
                    penalty -= 20
                if configured_idx_int == idx:
                    # A configured input is a real user choice. Prefer it unless
                    # it is blocked, unavailable, or rejected as hot/noisy below.
                    penalty -= 200
                if "wasapi" in host_low:
                    penalty -= 45
                elif "directsound" in host_low:
                    penalty += 5
                elif "mme" in host_low:
                    penalty += 30
                elif "wdm-ks" in host_low:
                    penalty += 60
                rate = int(info.get("defaultSampleRate") or configured_rate or TARGET_ASR_RATE)
                candidates.append((penalty, idx, name, rate, host_name))
            except Exception:
                continue

        seen: set[tuple[int, int]] = set()
        hot_rms = int(os.getenv("AVA_LOCAL_INPUT_HOT_RMS", "5000") or "5000")
        hot_peak = int(os.getenv("AVA_LOCAL_INPUT_HOT_PEAK", "26000") or "26000")
        fallback_rates = [configured_rate, TARGET_ASR_RATE, 44100, 48000]
        for _, idx, name, preferred_rate, host_name in sorted(candidates, key=lambda x: x[0]):
            rates = [preferred_rate]
            if "wasapi" in host_name.lower():
                rates.extend([48000, configured_rate, TARGET_ASR_RATE, 44100])
            else:
                rates.extend(fallback_rates)
            for rate in rates:
                key = (idx, int(rate))
                if key in seen:
                    continue
                seen.add(key)
                frames = max(int(int(rate) * 0.03), 240)
                stream = None
                try:
                    stream = self.audio.open(
                        format=FORMAT,
                        channels=CHANNELS,
                        rate=int(rate),
                        input=True,
                        input_device_index=idx,
                        frames_per_buffer=frames,
                    )
                    baseline, peak = baseline_rms(stream, frames)
                    if baseline >= hot_rms or peak >= hot_peak:
                        _log(
                            f"candidate_hot_rejected={name} idx={idx} host={host_name} "
                            f"rate={int(rate)} rms={baseline} peak={peak}"
                        )
                        close_stream(stream)
                        continue
                    _log(
                        f"input={name} idx={idx} host={host_name} rate={int(rate)} "
                        f"fpb={frames} baseline_rms={baseline} baseline_peak={peak}"
                    )
                    return InputStream(stream, int(rate), frames, idx, name)
                except Exception:
                    if stream is not None:
                        close_stream(stream)
                    continue
        raise RuntimeError("No usable input device found")

    def _open_output(self, rate: int):
        audio_cfg = self.config.get("audio") or {}
        output_idx = audio_cfg.get("output_device")
        kwargs = {
            "format": FORMAT,
            "channels": CHANNELS,
            "rate": int(rate),
            "output": True,
            "frames_per_buffer": max(int(rate * 0.05), 512),
        }
        if output_idx is not None:
            kwargs["output_device_index"] = int(output_idx)
        stream = self.audio.open(**kwargs)
        _log(f"output_rate={rate} output_device={output_idx if output_idx is not None else 'default'}")
        return stream

    def _build_tts(self):
        """Primary = ElevenLabs cloned voice when fully configured (enabled + real voice_id +
        API key present in the env var). Otherwise = local Piper (fast, offline). Whichever is
        not chosen acts as the automatic fallback if the primary fails to build."""
        lf = self.config.get("local_fallback") or {}
        piper_cfg = lf.get("piper") or {}
        exe = str(piper_cfg.get("exe") or (APP_DIR / "vendor" / "piper" / "piper.exe"))
        model = str(piper_cfg.get("model") or (APP_DIR / "vendor" / "piper" / "models" / "en_US-lessac-medium.onnx"))
        el = self.config.get("elevenlabs") or {}
        el_voice = str(el.get("voice_id") or "").strip()
        el_key = os.environ.get(str(el.get("api_key_env") or "ELEVENLABS_API_KEY"), "")
        el_enabled = bool(el.get("enabled", False))
        el_voice_ok = bool(el_voice) and el_voice != "REPLACE_WITH_YOUR_VOICE_ID"
        el_ready = el_enabled and el_voice_ok and bool(el_key)

        def _build_el():
            from voice.tts.elevenlabs_tts import ElevenLabsTTS
            return ElevenLabsTTS(
                voice_id=el_voice,
                api_key_env=str(el.get("api_key_env") or "ELEVENLABS_API_KEY"),
                model_id=str(el.get("model_id") or "eleven_flash_v2_5"),
                output_format=str(el.get("output_format") or "pcm_24000"),
                stability=float(el.get("stability", 0.5)),
                similarity_boost=float(el.get("similarity_boost", 0.75)),
                style=float(el.get("style", 0.0)),
            )

        def _build_piper():
            return PiperBinTTS(exe_path=exe, model_path=model)

        # Primary: ElevenLabs cloned voice, when fully configured.
        if el_ready:
            try:
                tts = _build_el()
                _log(f"tts=elevenlabs voice={el_voice} (primary)")
                return tts
            except Exception as exc:  # noqa: BLE001
                _log(f"tts_elevenlabs_failed={exc}; falling back to piper")

        # Primary (or fallback): local Piper.
        if os.path.exists(exe) and os.path.exists(model):
            try:
                tts = _build_piper()
                _log(f"tts=piper model={os.path.basename(model)}")
                return tts
            except Exception as exc:  # noqa: BLE001
                _log(f"tts_piper_failed={exc}")
        else:
            _log(f"tts_piper_unavailable exe={os.path.exists(exe)} model={os.path.exists(model)}")

        # Last-resort fallback: ElevenLabs even if the key wasn't detected at startup.
        if el_enabled and el_voice_ok:
            try:
                tts = _build_el()
                _log(f"tts=elevenlabs voice={el_voice} (fallback)")
                return tts
            except Exception as exc:  # noqa: BLE001
                _log(f"tts_elevenlabs_unavailable={exc}")

        _log("tts=piper (forced; fallback unavailable)")
        return _build_piper()

    def initialize(self, *, input_enabled: bool = True, playback_enabled: bool = True) -> None:
        if input_enabled:
            self.input_stream = self._open_input()
        self._initialize_wake_gate()
        _lf = self.config.get("local_fallback") or {}
        model_name = str(_lf.get("whisper_model") or "tiny.en")
        # Language: an explicit code like "en", or null/"auto" for multilingual auto-detect.
        _lang = _lf.get("whisper_language", "en")
        if isinstance(_lang, str) and _lang.strip().lower() in ("", "auto", "none", "multi", "multilingual"):
            _lang = None
        self.whisper_language = _lang
        # Task: "transcribe" (keep the spoken language) or "translate" (always output English).
        self.whisper_task = str(_lf.get("whisper_task") or "transcribe").strip().lower()
        _log(f"loading_whisper={model_name} lang={self.whisper_language or 'auto'} task={self.whisper_task}")
        self.whisper = WhisperModel(model_name, device="cpu", compute_type="int8")

        self.tts = self._build_tts()
        if playback_enabled:
            self.output_stream = self._open_output(int((self.config.get("audio") or {}).get("playback_rate") or 44100))
        else:
            self.output_stream = None
            _log("output=disabled")
        _log("ready")

    def _initialize_wake_gate(self) -> None:
        if os.getenv("AVA_LOCAL_WAKE_GATE", "1").lower() in {"0", "false", "no", "off"}:
            _log("wake_gate=disabled")
            return
        if not VOSK_AVAILABLE or VoskModel is None:
            _log("wake_gate=unavailable")
            return

        candidates = [
            os.getenv("AVA_VOSK_MODEL", ""),
            str(APP_DIR / "vosk-models" / "vosk-model-small-en-us-0.15"),
            r"C:\Users\USER 1\ava\ava-integration\vosk-models\vosk-model-small-en-us-0.15",
        ]
        for candidate in candidates:
            if not candidate:
                continue
            path = Path(candidate)
            if not path.exists():
                continue
            try:
                self.vosk_model = VoskModel(str(path))
                _log(f"wake_gate=vosk model={path}")
                return
            except Exception as exc:
                _log(f"wake_gate_load_failed={path} error={exc}")
        _log("wake_gate=model_not_found")

    def _calibrate_noise(self, seconds: float = 1.0) -> tuple[int, int]:
        assert self.input_stream is not None
        stream = self.input_stream.stream
        deadline = time.time() + seconds
        values: list[int] = []
        while time.time() < deadline and self.running:
            data = stream.read(self.input_stream.frames_per_buffer, exception_on_overflow=False)
            values.append(audioop.rms(data, SAMPLE_WIDTH))
        if not values:
            return 350, 220
        values.sort()
        median = values[len(values) // 2]
        vad_cfg = self.config.get("local_vad") or self.config.get("vad") or {}
        noise_percentile = _cfg_float(vad_cfg, "AVA_LOCAL_NOISE_PERCENTILE", "local_noise_percentile", 20.0)
        noise_percentile = min(80.0, max(5.0, noise_percentile))
        noise_idx = min(len(values) - 1, max(0, int((len(values) - 1) * (noise_percentile / 100.0))))
        noise_floor = values[noise_idx]
        high_percentile = _cfg_float(
            vad_cfg,
            "AVA_LOCAL_NOISE_HIGH_PERCENTILE",
            "local_noise_high_percentile",
            80.0,
        )
        high_percentile = min(98.0, max(50.0, high_percentile))
        high_idx = min(len(values) - 1, max(0, int((len(values) - 1) * (high_percentile / 100.0))))
        noise_high = values[high_idx]
        start_mult = _cfg_float(vad_cfg, "AVA_LOCAL_VAD_START_MULT", "local_start_noise_mult", 3.0)
        stop_mult = _cfg_float(vad_cfg, "AVA_LOCAL_VAD_STOP_MULT", "local_stop_noise_mult", 2.0)
        median_start_mult = _cfg_float(vad_cfg, "AVA_LOCAL_VAD_MEDIAN_START_MULT", "local_start_median_mult", 2.0)
        median_stop_mult = _cfg_float(vad_cfg, "AVA_LOCAL_VAD_MEDIAN_STOP_MULT", "local_stop_median_mult", 0.9)
        start_floor = _cfg_int(vad_cfg, "AVA_LOCAL_VAD_MIN_START_RMS", "local_start_rms", 250)
        stop_floor = _cfg_int(vad_cfg, "AVA_LOCAL_VAD_MIN_STOP_RMS", "local_stop_rms", 150)
        device_name = (self.input_stream.device_name if self.input_stream else "").lower()
        sensitive_device = any(term in device_name for term in ("headset", "usb", "logitech", "bluetooth", "airpods"))
        if not sensitive_device:
            start_floor = max(start_floor, _cfg_int(vad_cfg, "AVA_LOCAL_VAD_BUILTIN_START_RMS", "local_builtin_start_rms", 650))
            stop_floor = max(stop_floor, _cfg_int(vad_cfg, "AVA_LOCAL_VAD_BUILTIN_STOP_RMS", "local_builtin_stop_rms", 300))
            if "realtek" in device_name:
                start_floor = max(start_floor, _cfg_int(vad_cfg, "AVA_LOCAL_VAD_REALTEK_START_RMS", "local_realtek_start_rms", 5000))
                stop_floor = max(stop_floor, _cfg_int(vad_cfg, "AVA_LOCAL_VAD_REALTEK_STOP_RMS", "local_realtek_stop_rms", 1800))
        start = max(int(noise_floor * start_mult), int(median * median_start_mult), start_floor)
        stop = max(int(noise_floor * stop_mult), int(median * median_stop_mult), stop_floor)
        if not sensitive_device:
            start_ceiling = _cfg_int(vad_cfg, "AVA_LOCAL_VAD_BUILTIN_MAX_START_RMS", "local_builtin_max_start_rms", 850)
            stop_ceiling = _cfg_int(vad_cfg, "AVA_LOCAL_VAD_BUILTIN_MAX_STOP_RMS", "local_builtin_max_stop_rms", 500)
            ceiling_guard_start = _cfg_float(
                vad_cfg,
                "AVA_LOCAL_VAD_BUILTIN_CEILING_GUARD_MULT",
                "local_builtin_ceiling_guard_mult",
                1.15,
            )
            ceiling_guard_stop = _cfg_float(
                vad_cfg,
                "AVA_LOCAL_VAD_BUILTIN_STOP_CEILING_GUARD_MULT",
                "local_builtin_stop_ceiling_guard_mult",
                0.75,
            )
            min_safe_start = max(start_floor, int(median * ceiling_guard_start))
            min_safe_stop = max(stop_floor, int(median * ceiling_guard_stop))
            if start_ceiling > 0:
                if start_ceiling >= min_safe_start:
                    start = min(start, max(start_floor, start_ceiling))
                else:
                    _log(
                        "vad_start_ceiling_ignored="
                        f"{start_ceiling} min_safe_start={min_safe_start} noise_p50={median}"
                    )
            if stop_ceiling > 0:
                if stop_ceiling >= min_safe_stop:
                    stop = min(stop, max(stop_floor, stop_ceiling))
                else:
                    _log(
                        "vad_stop_ceiling_ignored="
                        f"{stop_ceiling} min_safe_stop={min_safe_stop} noise_p50={median}"
                    )
            dynamic_headroom = _cfg_int(
                vad_cfg,
                "AVA_LOCAL_VAD_HIGH_NOISE_HEADROOM_RMS",
                "local_high_noise_headroom_rms",
                3800,
            )
            if dynamic_headroom > 0:
                dynamic_floor_mult = _cfg_float(
                    vad_cfg,
                    "AVA_LOCAL_VAD_HIGH_NOISE_FLOOR_MULT",
                    "local_high_noise_floor_mult",
                    2.2,
                )
                dynamic_start_cap = max(
                    start_floor,
                    int(noise_floor * dynamic_floor_mult),
                    int(noise_high + dynamic_headroom),
                )
                dynamic_max_start = _cfg_int(
                    vad_cfg,
                    "AVA_LOCAL_VAD_HIGH_NOISE_MAX_START_RMS",
                    "local_high_noise_max_start_rms",
                    7000,
                )
                if dynamic_max_start > 0 and ("realtek" in device_name or noise_high < dynamic_max_start):
                    dynamic_start_cap = min(dynamic_start_cap, max(start_floor, dynamic_max_start))
                if start > dynamic_start_cap:
                    _log(
                        "vad_start_dynamic_cap="
                        f"{dynamic_start_cap} previous={start} noise_p{high_percentile:g}={noise_high} "
                        f"noise_floor_mult={dynamic_floor_mult:g}"
                    )
                    start = dynamic_start_cap
            stop = min(stop, max(stop_floor, int(start * 0.7)))
        if stop >= start:
            stop = max(1, int(start * 0.6))
        _log(
            f"noise_rms={noise_floor} noise_p50={median} noise_pct={noise_percentile:g} "
            f"noise_p{high_percentile:g}={noise_high} "
            f"vad_start={start} vad_stop={stop} "
            f"vad_floor_start={start_floor} vad_floor_stop={stop_floor}"
        )
        return start, stop

    def _capture_utterance(self, start_rms: int, stop_rms: int) -> CapturedUtterance:
        assert self.input_stream is not None
        stream = self.input_stream.stream
        frames_per_buffer = self.input_stream.frames_per_buffer
        pre_roll = deque(maxlen=10)
        active: list[bytes] = []
        active_rms: list[int] = []
        speaking = False
        speech_frames = 0
        silence_started = 0.0
        started_at = 0.0
        vad_cfg = self.config.get("local_vad") or self.config.get("vad") or {}
        start_confirm_frames = max(
            1,
            _cfg_int(vad_cfg, "AVA_LOCAL_VAD_START_CONFIRM_FRAMES", "local_start_confirm_frames", 2),
        )
        device_name = (self.input_stream.device_name if self.input_stream else "").lower()
        if "realtek" in device_name:
            start_confirm_frames = max(
                start_confirm_frames,
                _cfg_int(
                    vad_cfg,
                    "AVA_LOCAL_VAD_REALTEK_START_CONFIRM_FRAMES",
                    "local_realtek_start_confirm_frames",
                    3,
                ),
            )
        if not getattr(self, "_vad_confirm_logged", False):
            _log(f"vad_start_confirm_frames={start_confirm_frames}")
            self._vad_confirm_logged = True
        frame_sec = frames_per_buffer / float(self.input_stream.rate or TARGET_ASR_RATE)
        max_utt = float(((self.config.get("asr") or {}).get("utterance") or {}).get("max_utterance_sec") or 7.0)
        end_silence = max(
            0.75,
            float(((self.config.get("asr") or {}).get("utterance") or {}).get("end_silence_ms") or 700) / 1000.0,
        )
        try:
            heartbeat_sec = float(os.getenv("AVA_LOCAL_MIC_HEARTBEAT_SEC", "10") or "0")
        except Exception:
            heartbeat_sec = 10.0
        next_heartbeat = time.time() + max(1.0, heartbeat_sec)
        idle_rms: list[int] = []
        near_start_frames = 0
        near_start_peak = 0

        def captured(reason: str) -> CapturedUtterance:
            pcm = b"".join(active)
            duration = len(pcm) / float(max(1, self.input_stream.rate * SAMPLE_WIDTH * CHANNELS))
            voiced_frames = sum(1 for value in active_rms if value >= stop_rms)
            peak = max(active_rms) if active_rms else 0
            mean = int(sum(active_rms) / len(active_rms)) if active_rms else 0
            if reason:
                _log(
                    "state=FINALIZING "
                    f"{reason} dur_ms={int(duration * 1000)} "
                    f"voiced_ms={int(voiced_frames * frame_sec * 1000)} peak={peak} mean={mean}"
                )
            return CapturedUtterance(
                pcm=pcm,
                src_rate=self.input_stream.rate,
                duration_sec=duration,
                voiced_sec=voiced_frames * frame_sec,
                peak_rms=peak,
                mean_rms=mean,
                start_rms=start_rms,
                stop_rms=stop_rms,
            )

        while self.running:
            data = stream.read(frames_per_buffer, exception_on_overflow=False)
            rms = audioop.rms(data, SAMPLE_WIDTH)
            now = time.time()
            if not speaking:
                if heartbeat_sec > 0:
                    idle_rms.append(rms)
                    if now >= next_heartbeat:
                        peak = max(idle_rms) if idle_rms else 0
                        mean = int(sum(idle_rms) / len(idle_rms)) if idle_rms else 0
                        near_detail = ""
                        if near_start_frames or near_start_peak:
                            near_detail = (
                                f" confirm={start_confirm_frames}"
                                f" near_start_frames={near_start_frames}"
                                f" near_start_peak={near_start_peak}"
                            )
                        _log(f"mic_idle frames={len(idle_rms)} rms={mean} peak={peak} vad_start={start_rms}{near_detail}")
                        idle_rms.clear()
                        near_start_frames = 0
                        near_start_peak = 0
                        next_heartbeat = now + max(1.0, heartbeat_sec)
                pre_roll.append(data)
                if rms >= start_rms:
                    speech_frames += 1
                    near_start_peak = max(near_start_peak, rms)
                    if speech_frames >= start_confirm_frames:
                        speaking = True
                        started_at = now
                        active.extend(pre_roll)
                        pre_roll.clear()
                        silence_started = 0.0
                        _log(f"state=LISTENING speech_start rms={rms}")
                else:
                    if speech_frames:
                        near_start_frames += speech_frames
                    speech_frames = 0
                if bool(getattr(stream, "eof", False)):
                    _log("state=FINALIZING synthetic_eof_no_speech")
                    return CapturedUtterance(b"", self.input_stream.rate, 0.0, 0.0, 0, 0, start_rms, stop_rms)
                continue

            active.append(data)
            active_rms.append(rms)
            if rms <= stop_rms:
                if not silence_started:
                    silence_started = now
                if now - silence_started >= end_silence:
                    return captured("speech_end")
            else:
                silence_started = 0.0

            if now - started_at >= max_utt:
                return captured("max_utterance")
        return CapturedUtterance(b"", TARGET_ASR_RATE, 0.0, 0.0, 0, 0, start_rms, stop_rms)

    def _should_transcribe(self, utterance: CapturedUtterance) -> bool:
        if not utterance.pcm:
            return False

        utterance_cfg = (self.config.get("asr") or {}).get("utterance") or {}
        min_speech_sec = max(
            0.25,
            float(utterance_cfg.get("min_speech_ms") or 250) / 1000.0,
        )
        vad_cfg = self.config.get("local_vad") or self.config.get("vad") or {}
        min_peak_floor = _cfg_int(vad_cfg, "AVA_LOCAL_VAD_MIN_PEAK_RMS", "local_min_peak_rms", 650)
        loud_short_peak = max(
            int(utterance.start_rms * 1.8),
            utterance.start_rms + 250,
            min_peak_floor,
        )

        if utterance.voiced_sec < min_speech_sec and utterance.peak_rms < loud_short_peak:
            _log(
                "ignored_vad_low_confidence="
                f"voiced_ms:{int(utterance.voiced_sec * 1000)} "
                f"peak:{utterance.peak_rms} min_peak:{loud_short_peak}"
            )
            self._write_debug_wav(utterance, "vad_low_confidence")
            return False

        flat_peak = max(int(utterance.start_rms * 1.15), 1400)
        flat_mean = max(int(utterance.stop_rms * 0.75), 260)
        if utterance.duration_sec < 0.7 and utterance.mean_rms < flat_mean and utterance.peak_rms < flat_peak:
            _log(
                "ignored_vad_flat_capture="
                f"dur_ms:{int(utterance.duration_sec * 1000)} "
                f"mean:{utterance.mean_rms} peak:{utterance.peak_rms}"
            )
            self._write_debug_wav(utterance, "vad_flat_capture")
            return False

        return True

    def _looks_like_no_wake_filler(self, text: str) -> bool:
        normalized = _normalize(text)
        if not normalized:
            return False
        has_wake, _ = _strip_wake(normalized)
        if has_wake:
            return False
        common_fillers = {
            "okay",
            "ok",
            "yes",
            "yeah",
            "thank you",
            "thanks",
            "thank you so much",
            "bye",
            "bye bye",
            "see you later",
            "we will see you later",
        }
        return normalized in common_fillers

    def _wake_gate_active(self) -> bool:
        if not self.vosk_model or KaldiRecognizer is None:
            return False
        if self.wake_gate_after_no_wake < 0:
            return False
        if time.time() <= self.followup_until:
            return False
        return self.no_wake_streak >= self.wake_gate_after_no_wake

    def _wake_gate_text(self, utterance: CapturedUtterance) -> str:
        if not self.vosk_model or KaldiRecognizer is None:
            return ""
        try:
            recognizer = KaldiRecognizer(self.vosk_model, TARGET_ASR_RATE)
            recognizer.SetWords(False)
            pcm16 = _resample_pcm16(utterance.pcm, utterance.src_rate, TARGET_ASR_RATE)
            recognizer.AcceptWaveform(pcm16)
            result = json.loads(recognizer.FinalResult())
            return str(result.get("text") or "").strip()
        except Exception as exc:
            _log(f"wake_gate_error={exc}")
            return ""

    def _wake_gate_partial_wake_hint(self, text: str) -> bool:
        normalized = _normalize(text)
        if not normalized:
            return True
        words = normalized.split()
        wakeish = {"hey", "ava", "aba", "eva", "able", "abel", "aber"}
        phonetic_single_wake = {"offer", "over", "other", "evil"}
        return (
            any(word in wakeish for word in words[:3])
            or (len(words) == 1 and words[0] in phonetic_single_wake)
        )

    def _wake_gate_query_hint(self, text: str) -> bool:
        normalized = _normalize(text)
        if not normalized:
            return False
        words = set(normalized.split())
        query_patterns = (
            "what time",
            "time is it",
            "what date",
            "what day",
            "what is today",
            "what s today",
            "who are you",
            "what are you",
            "why is",
            "how do",
            "can you",
            "could you",
            "tell me",
            "open ",
            "search ",
            "find ",
            "show ",
        )
        return any(pattern in normalized for pattern in query_patterns) or bool(words & COMMAND_VERBS)

    def _wake_gate_local_fallback_transcript(self, text: str, utterance: CapturedUtterance) -> str:
        normalized = _normalize(text)
        if not normalized:
            return ""
        strong_hint = (
            utterance.duration_sec >= 0.8
            and utterance.voiced_sec >= 0.3
            and utterance.peak_rms >= max(utterance.start_rms + 700, int(utterance.start_rms * 1.12))
        )
        if not strong_hint:
            return ""
        words = set(normalized.split())
        if normalized == "time" or (words <= {"the", "time"} and "time" in words):
            return "ava what time is it"
        if normalized in {"today", "date", "day"}:
            return "ava what is today"
        return ""

    def _wake_gate_allows_whisper(self, utterance: CapturedUtterance) -> bool:
        self.wake_gate_fallback_transcript = ""
        if not self._wake_gate_active():
            return True

        text = self._wake_gate_text(utterance)
        has_wake, _ = _strip_wake(text)
        if has_wake:
            self.no_wake_streak = 0
            _log(f"wake_gate_hit={text!r}")
            return True
        if self._wake_gate_query_hint(text):
            self.no_wake_streak = 0
            _log(f"wake_gate_query_bypass={text!r}")
            return True
        fallback = self._wake_gate_local_fallback_transcript(text, utterance)
        if fallback:
            self.no_wake_streak = 0
            self.wake_gate_fallback_transcript = fallback
            _log(f"wake_gate_vosk_local_fallback={fallback!r} text={text!r}")
            return False

        # Keep single-word wake attempts recoverable even if Vosk is uncertain.
        if (
            self._wake_gate_partial_wake_hint(text)
            and utterance.duration_sec <= 1.6
            and utterance.peak_rms >= max(3200, int(utterance.start_rms * 2.0))
        ):
            _log(
                "wake_gate_short_bypass="
                f"dur_ms:{int(utterance.duration_sec * 1000)} peak:{utterance.peak_rms} text:{text!r}"
            )
            self.no_wake_streak = 0
            return True

        normalized = _normalize(text)
        low_information = not normalized or normalized in {"yeah", "yes", "no", "the", "uh", "um", "oh"}
        if not low_information:
            words = normalized.split()
            low_information = len(words) <= 2 and not self._wake_gate_query_hint(normalized)
        strong_peak = utterance.peak_rms >= max(
            utterance.start_rms + 600,
            int(utterance.stop_rms * 2.0),
            3200,
        )
        strong_mean = utterance.mean_rms >= max(int(utterance.stop_rms * 0.8), 450)
        short_command_shaped_energy = (
            1.2 <= utterance.duration_sec <= 4.2
            and utterance.voiced_sec >= 0.5
            and strong_peak
            and utterance.mean_rms >= max(int(utterance.stop_rms * 0.45), 450)
        )
        strong_utterance = (
            (
                utterance.duration_sec >= 1.2
                and utterance.voiced_sec >= 0.45
                and strong_peak
                and strong_mean
            )
            or short_command_shaped_energy
        )
        try:
            rescue_cooldown = float(os.getenv("AVA_LOCAL_WAKE_GATE_RESCUE_COOLDOWN_SEC", "4") or "4")
        except Exception:
            rescue_cooldown = 4.0
        try:
            rescue_after_blocks = int(os.getenv("AVA_LOCAL_WAKE_GATE_RESCUE_AFTER_BLOCKS", "3") or "3")
        except Exception:
            rescue_after_blocks = 3
        try:
            rescue_max_sec = float(os.getenv("AVA_LOCAL_WAKE_GATE_RESCUE_MAX_SEC", "3.8") or "3.8")
        except Exception:
            rescue_max_sec = 3.8
        now = time.time()
        rescue_duration_ok = utterance.duration_sec <= max(1.6, rescue_max_sec)
        streak_rescue = (
            strong_utterance
            and rescue_duration_ok
            and self.no_wake_streak >= max(1, rescue_after_blocks)
        )
        if (
            (low_information or streak_rescue)
            and strong_utterance
            and rescue_duration_ok
            and now - float(getattr(self, "last_wake_gate_rescue_at", 0.0) or 0.0) >= max(0.5, rescue_cooldown)
        ):
            self.last_wake_gate_rescue_at = now
            reason = "low_info" if low_information else "blocked_streak"
            _log(
                "wake_gate_whisper_rescue="
                f"reason:{reason} streak:{self.no_wake_streak} "
                f"dur_ms:{int(utterance.duration_sec * 1000)} voiced_ms:{int(utterance.voiced_sec * 1000)} "
                f"peak:{utterance.peak_rms} text:{text!r}"
            )
            self.no_wake_streak = 0
            return True

        self.no_wake_streak += 1
        _log(f"ignored_wake_gate_no_wake={text!r} streak={self.no_wake_streak}")
        return False

    def _write_debug_wav(self, utterance: CapturedUtterance, reason: str) -> None:
        trace_dir = os.getenv("AVA_ASR_TRACE_DIR") or os.getenv("AVA_LOCAL_UTTERANCE_DIR")
        if not trace_dir or not utterance.pcm:
            return
        try:
            root = Path(trace_dir)
            root.mkdir(parents=True, exist_ok=True)
            name = f"local_{int(time.time() * 1000)}_{_safe_slug(reason)}_{utterance.src_rate}hz.wav"
            path = root / name
            with wave.open(str(path), "wb") as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(SAMPLE_WIDTH)
                wf.setframerate(int(utterance.src_rate))
                wf.writeframes(utterance.pcm)
            _log(f"debug_wav reason={reason!r} path={str(path)!r}")
        except Exception as exc:
            _log(f"debug_wav_failed reason={reason!r} error={exc}")

    def _transcribe(self, utterance: CapturedUtterance) -> str:
        if self.whisper is None or not self._should_transcribe(utterance):
            return ""
        if not self._wake_gate_allows_whisper(utterance):
            fallback = str(getattr(self, "wake_gate_fallback_transcript", "") or "")
            if fallback:
                _log(f"asr_final={fallback!r} source=vosk_local_fallback")
                return fallback
            self._write_debug_wav(utterance, "wake_gate_block")
            return ""
        pcm16 = _resample_pcm16(utterance.pcm, utterance.src_rate, TARGET_ASR_RATE)
        pcm_rms = audioop.rms(pcm16, SAMPLE_WIDTH)
        pcm_max = audioop.max(pcm16, SAMPLE_WIDTH)
        if pcm_rms < 220 and pcm_max < 1200:
            _log(f"ignored_resampled_low_energy=rms:{pcm_rms} max:{pcm_max}")
            return ""
        samples = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size < int(TARGET_ASR_RATE * 0.3):
            _log(f"ignored_resampled_too_short=samples:{samples.size}")
            return ""
        _log(
            "whisper_start="
            f"dur_ms:{int(utterance.duration_sec * 1000)} voiced_ms:{int(utterance.voiced_sec * 1000)} "
            f"rms:{pcm_rms} max:{pcm_max}"
        )
        segments, _ = self.whisper.transcribe(
            samples,
            beam_size=1,
            language=getattr(self, "whisper_language", "en"),
            task=getattr(self, "whisper_task", "transcribe"),
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        if not text:
            _log(f"whisper_retry_no_vad=rms:{pcm_rms} max:{pcm_max}")
            segments, _ = self.whisper.transcribe(
                samples,
                beam_size=1,
                language="en",
                vad_filter=False,
                condition_on_previous_text=False,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
        if self._looks_like_no_wake_filler(text):
            self.no_wake_streak += 1
            _log(f"ignored_asr_filler={text!r}")
            return ""
        if text:
            _log(f"asr_final={text!r}")
        else:
            self._write_debug_wav(utterance, "empty_whisper")
            _log(f"ignored_empty_transcript=rms:{pcm_rms} max:{pcm_max}")
        return text

    def _speak(self, text: str) -> None:
        self.last_spoken_text = text or ""
        if not text or self.tts is None:
            return
        spoken = _apply_pron_lexicon(text)  # fix pronunciations (e.g. "AVA" -> "Aiva") right before TTS
        with self._speak_lock:
            playback_rate = int((self.config.get("audio") or {}).get("playback_rate") or 44100)
            source_rate = int(getattr(self.tts, "current_sample_rate", playback_rate) or playback_rate)
            _log(f"state=SPEAKING text={spoken[:80]!r}")

            # Thread the audioop.ratecv state across THIS utterance's chunks so the resampler
            # filter stays continuous. The shared _resample_pcm16 passes state=None every call,
            # which is fine for one-shot ASR buffers but drops the filter state at every ~100ms
            # frame boundary here, injecting a discontinuity ~10x/sec that sounds choppy. The
            # state list resets per utterance (each _speak call), so utterances stay independent.
            rs_state = [None]

            def on_chunk(pcm: bytes) -> None:
                if not pcm:
                    return
                if self.output_stream is None:
                    return
                if source_rate == playback_rate:
                    out = pcm
                else:
                    out, rs_state[0] = audioop.ratecv(pcm, SAMPLE_WIDTH, CHANNELS, source_rate, playback_rate, rs_state[0])
                self.output_stream.write(out)

            self.tts.speak(spoken, on_chunk, frame_ms=100)
            _log("state=COOLDOWN")
            time.sleep(0.35)

    def _announcements_url(self) -> str:
        """Derive http://host:port/voice/announcements from the configured /respond URL."""
        base = str(self.config.get("server_url") or DEFAULT_SERVER_URL)
        base = base.rstrip("/")
        if base.endswith("/respond"):
            base = base[: -len("/respond")]
        return base + "/voice/announcements"

    def _announce_worker(self) -> None:
        """Poll the server for proactive announcements (e.g. a queued code change) and speak
        them aloud. The speak lock guarantees we never talk over a live reply; the wake gate
        ignores AVA's own voice, so speaking while the mic is open is harmless."""
        url = self._announcements_url()
        interval = float(os.getenv("AVA_ANNOUNCE_POLL_SEC", "8") or "8")
        while self.running:
            try:
                req = urllib.request.Request(url=url, method="GET")
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                for item in (data.get("items") or []):
                    if not self.running:
                        break
                    text = str(item or "").strip()
                    if text:
                        _log(f"announcement={text[:80]!r}")
                        self._speak(text)
            except Exception:
                pass
            time.sleep(max(2.0, interval))

    def _start_announce_thread(self) -> None:
        if os.getenv("AVA_ANNOUNCE_OFF") == "1":
            return
        if self._announce_thread and self._announce_thread.is_alive():
            return
        t = threading.Thread(target=self._announce_worker, name="ava-announce", daemon=True)
        self._announce_thread = t
        t.start()
        _log("announce_thread=started")

    def _followup_window_sec(self) -> float:
        validation = self.config.get("validation_mode") or {}
        try:
            return max(10.0, float(validation.get("followup_window_sec") or 10.0))
        except Exception:
            return 10.0

    def _open_followup(self, reason: str) -> None:
        seconds = self._followup_window_sec()
        self.followup_until = time.time() + seconds
        _log(f"followup_open_sec={seconds:.1f} reason={reason}")

    def _allow_followup_command(self, command: str) -> bool:
        if not command:
            return False
        return bool(
            _local_fact_reply(command)
            or _is_conversational_command(command)
            or _should_allow_tools(command)
        )

    def _handle_transcript(self, transcript: str) -> None:
        self.last_transcript = transcript or ""
        self.last_command = ""
        self.last_reply = ""
        self.last_accepted = False
        self.last_ignored_reason = ""
        if not _normalize(transcript):
            self.last_ignored_reason = "empty_transcript"
            if os.getenv("AVA_LOCAL_VOICE_TRACE_EMPTY", "").lower() in {"1", "true", "yes"}:
                _log("ignored_empty_transcript")
            return
        has_wake, command = _strip_wake(transcript)
        if not has_wake:
            now = time.time()
            command = _normalize(transcript)
            if now <= self.followup_until and self._allow_followup_command(command):
                self.no_wake_streak = 0
                _log(f"followup_command={command!r}")
            elif now <= self.followup_until:
                self.last_ignored_reason = "followup_low_confidence"
                _log(f"ignored_followup_low_confidence={transcript!r}")
                return
            else:
                self.no_wake_streak += 1
                self.last_ignored_reason = "no_wake"
                _log(f"ignored_no_wake={transcript!r}")
                return
        self.no_wake_streak = 0
        self.last_accepted = True
        if not command:
            self.last_reply = "I'm listening."
            self._speak("I'm listening.")
            self._open_followup("wake_only")
            return

        self.followup_until = 0.0
        self.last_command = command
        local = _local_fact_reply(command)
        if local:
            self.last_reply = local
            self._speak(local)
            self._open_followup("answered_local")
            return

        _log(f"state=RESPONDING command={command!r}")
        reply = _server_respond(command, self.config)
        if reply:
            self.last_reply = reply
            self._speak(reply)
            self._open_followup("answered_server")
        else:
            self.last_reply = "I could not reach my local brain."
            self._speak("I could not reach my local brain.")
            self._open_followup("brain_unavailable")

    def _utterance_from_wav(self, wav_path: Path, start_rms: int = 500, stop_rms: int = 220) -> CapturedUtterance:
        return _captured_utterance_from_wav(wav_path, start_rms=start_rms, stop_rms=stop_rms)

    def _input_stream_from_wav(self, wav_path: Path) -> InputStream:
        stream = SyntheticWavInputStream(Path(wav_path))
        frames_per_buffer = max(1, int(stream.rate * 0.03))
        return InputStream(
            stream=stream,
            rate=stream.rate,
            frames_per_buffer=frames_per_buffer,
            device_index=None,
            device_name="Synthetic Live WAV Input",
        )

    def run_live_input_wav(self, wav_path: Path, *, playback_enabled: bool = True) -> dict:
        self.initialize(input_enabled=False, playback_enabled=playback_enabled)
        self.input_stream = self._input_stream_from_wav(Path(wav_path))
        _log(f"synthetic_live_input=path:{Path(wav_path)} rate:{self.input_stream.rate}")
        start_rms, stop_rms = self._calibrate_noise()
        _log("state=LISTENING")
        utterance = self._capture_utterance(start_rms, stop_rms)
        transcript = self._transcribe(utterance)
        self._handle_transcript(transcript)
        summary = {
            "mode": "live_input_wav",
            "input_wav": str(Path(wav_path)),
            "transcript": self.last_transcript,
            "accepted": bool(self.last_accepted),
            "command": self.last_command,
            "reply": self.last_reply,
            "ignored_reason": self.last_ignored_reason,
            "playback_enabled": bool(playback_enabled),
            "tts_attempted": bool(self.last_spoken_text),
            "vad_start": int(start_rms),
            "vad_stop": int(stop_rms),
            "captured_duration_sec": float(utterance.duration_sec),
            "captured_peak_rms": int(utterance.peak_rms),
            "captured_mean_rms": int(utterance.mean_rms),
        }
        _log(f"synthetic_live_summary={json.dumps(summary, sort_keys=True)}")
        return summary

    def run_input_wav(self, wav_path: Path, *, playback_enabled: bool = True) -> dict:
        self.initialize(input_enabled=False, playback_enabled=playback_enabled)
        utterance = self._utterance_from_wav(Path(wav_path))
        _log(
            "deterministic_input="
            f"path:{Path(wav_path)} dur_ms:{int(utterance.duration_sec * 1000)} "
            f"voiced_ms:{int(utterance.voiced_sec * 1000)} peak:{utterance.peak_rms} mean:{utterance.mean_rms}"
        )
        transcript = self._transcribe(utterance)
        self._handle_transcript(transcript)
        summary = {
            "input_wav": str(Path(wav_path)),
            "transcript": self.last_transcript,
            "accepted": bool(self.last_accepted),
            "command": self.last_command,
            "reply": self.last_reply,
            "ignored_reason": self.last_ignored_reason,
            "playback_enabled": bool(playback_enabled),
            "tts_attempted": bool(self.last_spoken_text),
        }
        _log(f"deterministic_summary={json.dumps(summary, sort_keys=True)}")
        return summary

    def run(self) -> None:
        self.initialize()
        self._start_announce_thread()
        start_rms, stop_rms = self._calibrate_noise()
        while self.running:
            _log("state=LISTENING")
            utterance = self._capture_utterance(start_rms, stop_rms)
            transcript = self._transcribe(utterance)
            self._handle_transcript(transcript)


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AVA local realtime voice.")
    parser.add_argument("--input-wav", default=os.getenv("AVA_LOCAL_INPUT_WAV", ""))
    parser.add_argument("--live-input-wav", default=os.getenv("AVA_LOCAL_LIVE_INPUT_WAV", ""))
    parser.add_argument("--no-playback", action="store_true", default=os.getenv("AVA_LOCAL_NO_PLAYBACK", "").lower() in {"1", "true", "yes"})
    parser.add_argument("--summary-json", default=os.getenv("AVA_LOCAL_SUMMARY_JSON", ""))
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    runner = LocalVoiceRunner()

    def _stop(_sig, _frame):
        _log("stopping")
        runner.close()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _stop)
    try:
        if str(args.input_wav or "").strip() and str(args.live_input_wav or "").strip():
            print("Only one of --input-wav or --live-input-wav may be supplied.", file=sys.stderr)
            return 2
        if str(args.live_input_wav or "").strip():
            summary = runner.run_live_input_wav(Path(args.live_input_wav), playback_enabled=not bool(args.no_playback))
            if str(args.summary_json or "").strip():
                Path(args.summary_json).write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(json.dumps(summary, sort_keys=True))
            return 0 if summary.get("accepted") else 2
        if str(args.input_wav or "").strip():
            summary = runner.run_input_wav(Path(args.input_wav), playback_enabled=not bool(args.no_playback))
            if str(args.summary_json or "").strip():
                Path(args.summary_json).write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(json.dumps(summary, sort_keys=True))
            return 0 if summary.get("accepted") else 2
        runner.run()
    except KeyboardInterrupt:
        pass
    finally:
        runner.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
