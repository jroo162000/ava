"""
AVA standalone voice runtime.

Canonical local path:
- Hybrid local ASR (Vosk streaming + Whisper final)
- Local AVA server (/respond) for the brain/tools
- Local TTS playback (Piper by default)
- Validation-mode wake gating and half-duplex echo suppression
"""

import asyncio
import base64
import json
import os
import sys
import wave
import threading
import queue
from datetime import datetime
from pathlib import Path
import time
import urllib.request
import urllib.error
import ssl
import re
import platform
import subprocess
import random
import uuid
import hashlib
# Prosody import (works whether run as module or script)
try:
    from .prosody import ProsodyPreprocessor  # type: ignore
except Exception:
    try:
        # When running as a script from ava-integration directory
        from prosody import ProsodyPreprocessor  # type: ignore
    except Exception:
        # Fallback no-op preprocessor
        class ProsodyPreprocessor:  # type: ignore
            def __init__(self, cfg=None):
                pass
            def process(self, text: str) -> str:
                return text
VOICE_UNIFIED = os.getenv("VOICE_UNIFIED", "0") == "1"  # legacy override only

# -------------------- Latency profiler --------------------
class _LatencyProfiler:
    def __init__(self):
        self._buckets = {}
        self._last_report = 0.0
        self._window = 200  # rolling samples per metric
        self._interval = 30.0  # seconds

    def record(self, name: str, value_ms: int):
        try:
            from collections import deque
            dq = self._buckets.get(name)
            if dq is None:
                dq = deque(maxlen=self._window)
                self._buckets[name] = dq
            dq.append(int(value_ms))
        except Exception:
            pass

    def _quantiles(self, arr):
        if not arr:
            return (None, None, None)
        vals = sorted(arr)
        n = len(vals)
        def q(p):
            if n == 1:
                return vals[0]
            idx = max(0, min(n - 1, int(round((p/100.0)*(n-1)))))
            return vals[idx]
        return (q(50), q(95), q(99))

    def maybe_report(self):
        try:
            now = time.time()
            if (now - self._last_report) < self._interval:
                return
            self._last_report = now
            lines = []
            for name, dq in self._buckets.items():
                p50, p95, p99 = self._quantiles(list(dq))
                if p50 is None:
                    continue
                lines.append(f"{name}: p50={p50}ms p95={p95}ms p99={p99}ms (n={len(dq)})")
            if lines:
                print("[latstats] " + " | ".join(lines))
        except Exception:
            pass
try:
    # Unified voice scaffolding
    from voice.bus import EventBus as _VoiceEventBus
    from voice.session import VoiceSession as _VoiceSession
    from voice.providers.local_hybrid import LocalHybridProvider as _LocalHybridProvider
    from voice.tts.edge_stream import EdgeStreamTTS as _EdgeStreamTTS
    from voice.tts.piper_bin import PiperBinTTS as _PiperBinTTS
    _VOICE_SCAFFOLD_AVAILABLE = True
except Exception as e:
    _VOICE_SCAFFOLD_AVAILABLE = False
    print(f"[warning] Unified voice scaffold not available: {type(e).__name__}: {e}")
import random

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        os.environ['PYTHONIOENCODING'] = 'utf-8'

WS_AVAILABLE = True
try:
    import websockets
    WS_ClosedOK = websockets.exceptions.ConnectionClosedOK
    WS_ClosedError = websockets.exceptions.ConnectionClosedError
    WS_ClosedGeneral = websockets.exceptions.ConnectionClosed
except Exception as e:
    websockets = None  # type: ignore
    WS_AVAILABLE = False
    class WS_ClosedOK(Exception):
        pass
    class WS_ClosedError(Exception):
        pass
    class WS_ClosedGeneral(Exception):
        pass
    print(f"[warning] websockets not available: {e}")

import pyaudio
from corrected_tool_definitions import CORRECTED_TOOLS

# Local voice fallback imports (Whisper + Edge TTS)
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    print("[warning] faster-whisper not installed - local fallback unavailable")

try:
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except ImportError:
    EDGE_TTS_AVAILABLE = False
    print("[warning] edge-tts not installed - local fallback unavailable")

LOCAL_FALLBACK_AVAILABLE = WHISPER_AVAILABLE and EDGE_TTS_AVAILABLE

# Hybrid ASR (Vosk streaming + Whisper final) - preferred local fallback
try:
    from ava_hybrid_asr import HybridASREngine
    HYBRID_ASR_AVAILABLE = True
except Exception as e:
    HYBRID_ASR_AVAILABLE = False
    HybridASREngine = None
    print(f"[warning] ava_hybrid_asr not available - hybrid local ASR disabled: {e}")

# Personality system import
try:
    from ava_personality import get_personality, get_personality_context, get_greeting, get_acknowledgment
    PERSONALITY_AVAILABLE = True
except ImportError:
    PERSONALITY_AVAILABLE = False
    print("[warning] ava_personality not found - personality system unavailable")

# Self-modification system import
try:
    from ava_self_modification import (
        self_mod_tool_handler,
        CORE_FILES as SELF_MOD_CORE_FILES,
        CODING_KNOWLEDGE,
        diagnose_codebase,
        diagnose_error
    )
    SELF_MOD_AVAILABLE = True
except ImportError:
    SELF_MOD_AVAILABLE = False
    print("[warning] ava_self_modification not found - self-modification unavailable")

# Self-awareness system import
try:
    from ava_self_awareness import (
        get_self_awareness,
        introspect,
        who_am_i,
        diagnose as self_diagnose,
        get_prompt_context,
        learn_from_correction,
        check_past_mistakes
    )
    SELF_AWARENESS_AVAILABLE = True
except ImportError:
    SELF_AWARENESS_AVAILABLE = False
    print("[warning] ava_self_awareness not found - self-awareness unavailable")

# Passive learning system import
try:
    from ava_passive_learning import (
        get_passive_learning,
        start_passive_learning,
        stop_passive_learning,
        get_current_context as get_passive_context,
        record_interaction,
        get_learning_summary
    )
    PASSIVE_LEARNING_AVAILABLE = True
except ImportError:
    PASSIVE_LEARNING_AVAILABLE = False
    print("[warning] ava_passive_learning not found - passive learning unavailable")

# NEW: Intent router for command classification
try:
    from ava_intent_router import (
        classify_intent,
        requires_confirmation,
        extract_entities,
        IntentRouter
    )
    INTENT_ROUTER_AVAILABLE = True
except ImportError:
    INTENT_ROUTER_AVAILABLE = False
    print("[warning] ava_intent_router not found - intent routing disabled")

# NEW: Session manager for persistent conversations
try:
    from ava_session_manager import (
        get_session,
        get_accuracy_monitor,
        reset_session,
        VoiceSession
    )
    SESSION_MANAGER_AVAILABLE = True
except ImportError:
    SESSION_MANAGER_AVAILABLE = False
    print("[warning] ava_session_manager not found - session persistence disabled")

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.secrets import load_into_env
try:
    from ava_server_client import AvaServerClient
    SERVER_CLIENT_AVAILABLE = True
except Exception:
    SERVER_CLIENT_AVAILABLE = False
try:
    import msvcrt  # Windows-only hotkey support
    MSVCRT_AVAILABLE = True
except Exception:
    MSVCRT_AVAILABLE = False
from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.config import Config
import cmpuse.tools

# Load secrets and configuration
load_into_env()

# Enable full access
os.environ['CMPUSE_ALLOW_SHELL'] = '1'
os.environ['CMPUSE_FORCE'] = '1'
os.environ['CMPUSE_CONFIRM'] = '0'
os.environ['CMPUSE_DRY_RUN'] = '0'
os.environ['CMPUSE_ALLOW_NETWORK'] = '1'
os.environ['CMPUSE_PATH_WHITELIST'] = "C:\\"

# Disable autonomy when voice mode is active (D002: voice = intent producer only)
os.environ['DISABLE_AUTONOMY'] = '1'
print("[autonomy] disabled (voice mode) — DISABLE_AUTONOMY=1 set")

# Audio configuration
MIC_RATE = 16000           # Mic capture rate - MUST be 16kHz for Deepgram Agent
PLAYBACK_RATE = 24000      # TTS playback target
CHANNELS = 1
CHUNK_SIZE = 480           # ~30ms at 16kHz for low-latency streaming
CHUNK_SAMPLES = 480        # ~30ms @16kHz for low-latency streaming
FORMAT = pyaudio.paInt16

def _resample_audio(audio_bytes: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Resample PCM16 audio from src_rate to dst_rate using linear interpolation."""
    if src_rate == dst_rate:
        return audio_bytes
    try:
        import numpy as np
        # Convert bytes to int16 array
        samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32)
        # Calculate new length
        new_length = int(len(samples) * dst_rate / src_rate)
        if new_length == 0:
            return audio_bytes
        # Linear interpolation resampling
        x_old = np.linspace(0, 1, len(samples))
        x_new = np.linspace(0, 1, new_length)
        resampled = np.interp(x_new, x_old, samples)
        # Convert back to int16 bytes
        return resampled.astype(np.int16).tobytes()
    except Exception as e:
        print(f"[resample] Error: {e}")
        return audio_bytes

# Deepgram endpoints
DG_LISTEN_URL = (
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate="
    f"{MIC_RATE}&channels=1&model=nova-2&smart_format=true"
)
DG_SPEAK_BASE = "https://api.deepgram.com/v1/speak?model=aura-2-andromeda-en"

# ==================== TURN STATE MACHINE (Voice Stabilizer) ====================

class TurnState:
    """Explicit turn states for voice interaction.

    State machine: IDLE -> LISTEN -> FINAL -> DECIDE -> SPEAK -> IDLE

    This enforces deterministic voice behavior:
    - Partial transcripts NEVER trigger tools (PARTIAL -> NO_TOOL)
    - Only final transcripts can trigger DECIDE phase (FINAL -> DECIDE)
    - Mic is muted during SPEAK state (half-duplex)
    """
    IDLE = "IDLE"
    LISTEN = "LISTEN"
    FINAL = "FINAL"
    DECIDE = "DECIDE"
    SPEAK = "SPEAK"


class TurnStateMachine:
    """Thread-safe state machine for voice turn management.

    Logs all state transitions in format: [turn-state] PREV -> NEW
    Validates that only one turn is active at any time.

    HARD LOCK: While in SPEAK state, NO transitions are allowed except SPEAK -> IDLE
    via force_idle(). This prevents SPEAK->LISTEN/FINAL/DECIDE errors entirely.
    Barge-in is disabled until stability is proven (reintroduce behind feature flag).
    """

    def __init__(self, barge_in_enabled: bool = False):
        self._state = TurnState.IDLE
        self._lock = threading.Lock()
        self._turn_id = 0
        self._turn_start_time = 0.0
        self._tts_token = None
        # D005: Barge-in HARD DISABLED for stability. Do not re-enable via config.
        self._barge_in_enabled = False
        self._interrupted = False
        self._interrupt_count = 0

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def barge_in_enabled(self) -> bool:
        return False  # HARD DISABLED

    @barge_in_enabled.setter
    def barge_in_enabled(self, value: bool):
        # Ignore all attempts to enable barge-in — hard locked for stability
        if value:
            print(f"[D005] Barge-in enable IGNORED — hard locked for turn-state stability")

    def is_speaking(self) -> bool:
        """Check if currently in SPEAK state (TTS active)."""
        with self._lock:
            return self._state == TurnState.SPEAK

    def transition(self, new_state: str, reason: str = "") -> bool:
        """Transition to a new state with logging.

        Returns True if transition was valid, False if blocked.
        HARD LOCK: While in SPEAK, silently drops all transitions except via force_idle().
        """
        with self._lock:
            old_state = self._state

            # HARD LOCK: SPEAK state rejects ALL transitions (only force_idle exits SPEAK)
            if old_state == TurnState.SPEAK:
                # Silently drop — these are expected during TTS (VAD/ASR still firing)
                print(f"[speak-lock] Dropped {old_state} -> {new_state} ({reason}) — TTS active")
                return False

            # Validate transition
            if not self._is_valid_transition(old_state, new_state):
                print(f"[VOICE_ERROR] Invalid transition {old_state} -> {new_state} (reason: {reason})")
                return False

            # Check for concurrent turn violation
            if old_state == TurnState.IDLE and new_state == TurnState.LISTEN:
                self._turn_id += 1
                self._turn_start_time = time.time()
                self._interrupted = False

            self._state = new_state
            reason_str = f" ({reason})" if reason else ""
            print(f"[turn-state] {old_state} -> {new_state}{reason_str}")

            # Mint TTS token when entering DECIDE — only this turn may speak
            if new_state == TurnState.DECIDE:
                self._tts_token = uuid.uuid4().hex[:8]
                print(f"[turn-token] Minted {self._tts_token} for turn {self._turn_id}")

            return True

    def _is_valid_transition(self, old: str, new: str) -> bool:
        """Check if a state transition is valid.

        SPEAK -> anything is handled by the hard lock above, not here.
        """
        valid_transitions = {
            TurnState.IDLE: [TurnState.LISTEN],
            TurnState.LISTEN: [TurnState.FINAL, TurnState.IDLE],
            TurnState.FINAL: [TurnState.DECIDE, TurnState.IDLE],
            TurnState.DECIDE: [TurnState.SPEAK, TurnState.IDLE],
            TurnState.SPEAK: [TurnState.IDLE],  # Only via force_idle()
        }
        return new in valid_transitions.get(old, [])

    def is_in_turn(self) -> bool:
        """Check if currently in an active turn (not IDLE)."""
        with self._lock:
            return self._state != TurnState.IDLE

    def interrupt_speaking(self, reason: str = "barge-in") -> bool:
        """D005 Barge-in: HARD DISABLED for turn-state stability.

        Always returns False. To reintroduce, gate behind a tested feature flag
        after proving no SPEAK->LISTEN errors for N sessions.
        """
        print(f"[D005] Barge-in HARD DISABLED — interrupt rejected ({reason})")
        return False

    def force_idle(self, reason: str = "forced reset"):
        """Force state back to IDLE (for error recovery)."""
        with self._lock:
            old_state = self._state
            if old_state != TurnState.IDLE:
                print(f"[turn-state] {old_state} -> {TurnState.IDLE} ({reason})")
                self._state = TurnState.IDLE
                self._tts_token = None

    def was_interrupted(self) -> bool:
        """Check if the current turn was started via barge-in interrupt."""
        with self._lock:
            return self._interrupted

    @property
    def tts_token(self):
        with self._lock:
            return self._tts_token

    def mint_tts_token(self, reason="agent-mode"):
        """Manually mint a TTS token for code paths that don't use transition(DECIDE)."""
        with self._lock:
            self._tts_token = uuid.uuid4().hex[:8]
            print(f"[turn-token] Minted {self._tts_token} ({reason})")
            return self._tts_token


class WavToPcmStripper:
    """Strips WAV header and forwards only PCM data bytes.

    Reset this between clips (e.g., on AgentAudioDone).
    Tolerates data chunk size of 0 by streaming until reset.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self._need_header = True
        self._buffer = bytearray()
        self._data_started = False

    def feed(self, data: bytes) -> bytes:
        if not data:
            return b''
        if not self._need_header:
            return data  # already in data section
        # accumulate header until we find 'data' chunk
        self._buffer.extend(data)
        # minimal parser: look for 'data' chunk start; then emit everything after its 8-byte header
        buf = self._buffer
        if len(buf) < 44:
            return b''
        # Check RIFF/WAVE
        if not (buf[0:4] == b'RIFF' and buf[8:12] == b'WAVE'):
            # Not WAV; pass-through to avoid stalling
            self._need_header = False
            return bytes(buf)
        # Search for 'data' chunk from byte 12 onwards
        i = 12
        while i + 8 <= len(buf):
            chunk_id = buf[i:i+4]
            chunk_size = int.from_bytes(buf[i+4:i+8], 'little', signed=False)
            if chunk_id == b'data':
                start = i + 8
                self._need_header = False
                self._data_started = True
                out = bytes(buf[start:])
                # Clear buffer to avoid growth
                self._buffer = bytearray()
                return out
            # advance to next chunk
            i += 8 + chunk_size
            if i > len(buf) + 4096:
                # safety; don't spin
                break
        # header incomplete; wait for more bytes
        return b''


# ==================== LOCAL VOICE ENGINE (Whisper + Edge TTS) ====================

class LocalVoiceEngine:
    """Fallback voice engine using local Whisper ASR + Edge TTS.
    
    Used when Deepgram quota is exhausted. Completely offline ASR,
    free unlimited TTS via Microsoft Edge's neural voices.
    """
    
    def __init__(self, parent, whisper_model="base", edge_voice="en-US-MichelleNeural"):
        self.parent = parent  # Reference to StandaloneRealtimeAVA
        self.whisper_model_name = whisper_model
        self.edge_voice = edge_voice
        self.whisper_model = None
        self.running = False
        self.shutdown = threading.Event()
        self._audio_buffer = bytearray()
        self._buffer_lock = threading.Lock()
        self._min_audio_length = 16000 * 2 * 1  # 1 second of 16kHz mono int16
        self._silence_threshold = 600  # RMS threshold for silence detection (increased)
        self._silence_duration = 0.8  # Seconds of silence before processing
        self._last_speech_time = 0

        # Hybrid ASR engine (preferred when available)
        self.hybrid_asr = None
        self._using_hybrid_asr = False

        # Wake word detection - AVA only responds when addressed
        self._wake_words = [
            "ava", "eva", "hey ava", "hey eva", "ok ava", "okay ava",
            "hi ava", "hello ava", "yo ava", "ava can you", "ava please",
            "ava what", "ava tell", "ava show", "ava help", "ava do",
            "ava activate", "ava close", "ava open", "ava turn"
        ]

        # Vosk ASR frequently misrecognizes "ava" — map known aliases
        # (pattern, replacement) applied left-to-right, first match wins
        self._vosk_wake_aliases = [
            ('hey we\'re', 'hey ava'),
            ('hey we\'ll', 'hey ava'),
            ('hey a were', 'hey ava'),
            ('hey able', 'hey ava'),
            ('the able', 'hey ava'),
            ('be able', 'hey ava'),
            ('hey uber', 'hey ava'),
            ('however', 'hey ava'),
            ('haber', 'ava'),
            ('aber', 'ava'),
            ('abba', 'ava'),
            ('able', 'ava'),
        ]

        # Audio learning - store overheard conversations for context
        from collections import deque
        self._overheard_audio = deque(maxlen=50)  # Last 50 transcriptions
        self._audio_context_lock = threading.Lock()

    def _is_addressed(self, transcript: str) -> bool:
        """Check if the user is addressing AVA (contains wake word)"""
        lower = self._normalize_for_wake(transcript)

        # Check for wake words
        for wake_word in self._wake_words:
            if wake_word in lower:
                return True

        # Also respond to direct questions/commands if they're short
        # (likely directed at AVA in a conversation context)
        direct_patterns = [
            "what do you see", "what can you see", "close the camera",
            "activate the camera", "turn on", "turn off", "what time",
            "what's the time", "what date", "thank you", "thanks"
        ]
        for pattern in direct_patterns:
            if pattern in lower:
                return True

        return False

    def _normalize_for_wake(self, text: str) -> str:
        """Normalize known Vosk misrecognitions of 'ava' before wake word detection."""
        lower = text.lower().strip()
        # 1. Exact alias lookup
        for alias, replacement in self._vosk_wake_aliases:
            if lower.startswith(alias):
                lower = replacement + lower[len(alias):]
                print(f"[vosk-alias] '{text[:30]}' -> '{lower[:30]}' (matched '{alias}')")
                return lower
        # 2. Fuzzy match: if first/second word is close to 'ava'/'eva', treat as wake word
        _ed = getattr(self, '_edit_distance', None)
        if _ed is None:
            return lower
        words = lower.split()
        if not words:
            return lower
        wake_targets = ['ava', 'eva']
        for i, word in enumerate(words[:2]):
            clean = word.strip('.,!?')
            if len(clean) < 2 or len(clean) > 5:
                continue
            for target in wake_targets:
                dist = _ed(clean, target)
                if dist <= 1:  # 1 edit away from ava/eva
                    words[i] = target
                    result = ' '.join(words)
                    print(f"[vosk-fuzzy] '{text[:30]}' -> '{result[:30]}' ('{clean}'~'{target}' dist={dist})")
                    return result
            # Also check "hey/ok X" where X is <=2 edits from ava/eva
            # (looser threshold OK because "hey" prefix narrows context)
            if i == 0 and clean in ('hey', 'ok', 'okay', 'hi', 'hello') and len(words) > 1:
                w2 = words[1].strip('.,!?')
                if len(w2) >= 2 and len(w2) <= 5:
                    for target in wake_targets:
                        dist = _ed(w2, target)
                        if dist <= 2:
                            words[1] = target
                            result = ' '.join(words)
                            print(f"[vosk-fuzzy] '{text[:30]}' -> '{result[:30]}' ('hey {w2}'~'hey {target}' dist={dist})")
                            return result
        return lower

    @staticmethod
    def _edit_distance(s1: str, s2: str) -> int:
        """Levenshtein edit distance between two strings."""
        if len(s1) < len(s2):
            return LocalVoiceEngine._edit_distance(s2, s1)
        if len(s2) == 0:
            return len(s1)
        prev = list(range(len(s2) + 1))
        for i, c1 in enumerate(s1):
            curr = [i + 1]
            for j, c2 in enumerate(s2):
                curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (0 if c1 == c2 else 1)))
            prev = curr
        return prev[-1]

    def _store_overheard(self, transcript: str, responded: bool = False):
        """Store overheard audio for context/learning"""
        from datetime import datetime
        with self._audio_context_lock:
            self._overheard_audio.append({
                "time": datetime.now().isoformat(),
                "transcript": transcript,
                "responded": responded,
                "type": "overheard" if not responded else "addressed"
            })

    def get_audio_context(self, count: int = 10) -> list:
        """Get recent audio context for learning"""
        with self._audio_context_lock:
            items = list(self._overheard_audio)
            return items[-count:] if len(items) > count else items

    def get_audio_summary(self) -> str:
        """Get summary of what AVA has heard"""
        with self._audio_context_lock:
            if not self._overheard_audio:
                return "I haven't heard anything notable recently."

            items = list(self._overheard_audio)
            overheard = [i for i in items if i.get("type") == "overheard"]
            addressed = [i for i in items if i.get("type") == "addressed"]

            summary_parts = []
            if overheard:
                summary_parts.append(f"I've overheard {len(overheard)} conversations in the background")
            if addressed:
                summary_parts.append(f"and responded to {len(addressed)} direct requests")

            # Include some recent overheard content
            recent_overheard = [i["transcript"] for i in overheard[-3:] if i.get("transcript")]
            if recent_overheard:
                summary_parts.append(f"Recent background: {'; '.join(recent_overheard)}")

            return ". ".join(summary_parts) + "." if summary_parts else "Nothing notable heard recently."
        
    def initialize(self):
        """Load Whisper model (done lazily to save memory)"""
        if not WHISPER_AVAILABLE:
            print("[local] Whisper not available")
            return False
        if self.whisper_model is None:
            print(f"[local] Loading Whisper model '{self.whisper_model_name}'...")
            try:
                # Use CPU by default, can change to "cuda" if GPU available
                self.whisper_model = WhisperModel(self.whisper_model_name, device="cpu", compute_type="int8")
                print(f"[local] Whisper model loaded successfully")
                return True
            except Exception as e:
                print(f"[local] Failed to load Whisper: {e}")
                return False
        return True
    
    def _rms(self, audio_bytes):
        """Calculate RMS of audio buffer"""
        if len(audio_bytes) < 2:
            return 0
        import struct
        n = len(audio_bytes) // 2
        samples = struct.unpack('<' + 'h' * n, audio_bytes[:n*2])
        return (sum(s*s for s in samples) / n) ** 0.5
    
    async def synthesize_speech(self, text, turn_id=None):
        """Generate speech using Edge TTS and play it"""
        if not text or not EDGE_TTS_AVAILABLE:
            return
        # TURN-SCOPED TTS GATE: Only user-turn responses may speak
        active_token = getattr(self.parent._turn_state, 'tts_token', None) if hasattr(self.parent, '_turn_state') else None
        if turn_id is None or turn_id != active_token:
            print(f"[tts.blocked_background] Rejected (local): turn_id={turn_id} active={active_token} text='{(text or '')[:40]}...'")
            return
        # CHOKEPOINT FILTER: Block internal agent-loop status from local TTS path
        if hasattr(self.parent, '_is_step_status_message') and self.parent._is_step_status_message(text):
            print(f"[tts-filter] Blocked agent-loop status (local): {text[:60]}...")
            return
        # TTS SOURCE OF TRUTH: sha1 proves no hidden rewrite between /respond and TTS
        _sha1 = hashlib.sha1(text.encode()).hexdigest()[:12]
        print(f"[tts-in] TTS_SOURCE=local turn_id={turn_id} sha1={_sha1} preview='{text[:60]}...'")
        try:
            print(f"[local-tts] Synthesizing: {text[:50]}...")
            communicate = edge_tts.Communicate(text, self.edge_voice)
            
            audio_data = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_data.extend(chunk["data"])
            
            if not audio_data:
                print("[local-tts] No audio data received")
                return
                
            print(f"[local-tts] Got {len(audio_data)} bytes, playing...")
            
            # Save to temp file
            import tempfile
            tmp_path = os.path.join(tempfile.gettempdir(), f"ava_tts_{int(time.time()*1000)}.mp3")
            with open(tmp_path, 'wb') as f:
                f.write(audio_data)
            
            self.parent.tts_active.set()
            self.parent._tts_last_active = time.time()
            played = False
            
            # Method 1: Try pygame
            try:
                import pygame
                if not pygame.mixer.get_init():
                    pygame.mixer.init()
                
                pygame.mixer.music.load(tmp_path)
                pygame.mixer.music.play()
                
                # Wait with timeout based on audio size (rough estimate: 1 sec per 16KB)
                max_wait = max(5, len(audio_data) // 8000)
                start = time.time()
                
                # Check if barge-in is allowed
                allow_barge = self.parent.cfg.get('allow_barge', False)

                while pygame.mixer.music.get_busy():
                    if self.shutdown.is_set():
                        pygame.mixer.music.stop()
                        print("[local-tts] Shutdown")
                        break
                    # Only allow interruption if barge is enabled
                    if allow_barge and self.parent.user_speaking.is_set():
                        pygame.mixer.music.stop()
                        print("[local-tts] Interrupted by user")
                        break
                    if time.time() - start > max_wait:
                        print("[local-tts] Playback timeout")
                        break
                    time.sleep(0.1)
                
                played = True
                print("[local-tts] Playback complete")
                
            except Exception as e:
                print(f"[local-tts] pygame failed: {e}")
            
            # Method 2: Fallback to Windows Media Player via subprocess
            if not played:
                try:
                    import subprocess
                    # Use Windows start command to play audio
                    subprocess.run(
                        ['cmd', '/c', 'start', '/wait', '', tmp_path],
                        shell=False, timeout=30
                    )
                    played = True
                except Exception as e:
                    print(f"[local-tts] subprocess failed: {e}")
            
            self.parent.tts_active.clear()
            
            # Cleanup
            try:
                time.sleep(0.5)
                os.unlink(tmp_path)
            except:
                pass
                        
        except Exception as e:
            print(f"[local-tts] Error: {e}")
            import traceback
            traceback.print_exc()
    
    def transcribe_audio(self, audio_bytes):
        """Transcribe audio using Whisper with hallucination filtering.

        Phase A: Never annihilate non-empty Whisper outputs — if filtering would
        return an empty string but the raw Whisper text is non-empty, fall back
        to the raw text. Also relax polite filler filtering in validation mode.
        """
        if not self.whisper_model or len(audio_bytes) < self._min_audio_length:
            return ""
        
        try:
            import numpy as np
            import struct
            
            # Convert bytes to numpy array
            n_samples = len(audio_bytes) // 2
            samples = struct.unpack('<' + 'h' * n_samples, audio_bytes)
            audio_np = np.array(samples, dtype=np.float32) / 32768.0
            
            # Check audio energy - skip if too quiet (raised for Whisper stability)
            rms = np.sqrt(np.mean(audio_np ** 2))
            if rms < 0.01:
                return ""
            
            # Transcribe
            segments, info = self.whisper_model.transcribe(audio_np, beam_size=5, language="en")
            raw_text = " ".join([seg.text for seg in segments]).strip()
            
            # Filter out common Whisper hallucinations
            hallucination_patterns = [
                "thank you", "thanks for watching", "subscribe",
                "like and subscribe", "see you", "bye", "goodbye",
                "music", "applause", "[music]", "[applause]",
                "subtitles", "captions", "translated by",
                "hey bob", "my house", "that's my house",
                "www.", ".com", ".org",
            ]
            # In validation mode, do not treat polite fillers as annihilating patterns
            try:
                val_mode = bool(getattr(self.parent, '_validation_mode', False))
            except Exception:
                val_mode = False
            if val_mode:
                _polite = {"thank you", "thanks", "thanks for watching"}
                hallucination_patterns = [p for p in hallucination_patterns if p not in _polite]

            # Begin filtered text as raw_text; apply cleaning rules non-destructively
            filtered = raw_text
            text_lower = raw_text.lower()
            
            # If text is very short and matches hallucination patterns, skip
            if len(raw_text) < 30:
                for pattern in hallucination_patterns:
                    if pattern in text_lower:
                        print(f"[local-asr] Filtered hallucination pattern='{pattern}': {raw_text}")
                        filtered = ""
                        break
            
            # Skip if text doesn't match audio characteristics
            # (e.g., very long text from short audio is suspicious)
            audio_duration = len(audio_np) / 16000  # seconds
            words = len(raw_text.split())
            words_per_second = words / max(audio_duration, 0.1)
            
            # Normal speech is 2-4 words per second, hallucinations often have many more
            if words_per_second > 6 and audio_duration < 2:
                print(f"[local-asr] Filtered suspicious speed ({words_per_second:.1f} w/s): {raw_text}")
                filtered = ""

            # Phase A rule: filtering can clean but must not annihilate non-empty raw
            if (filtered or "").strip() == "" and (raw_text or "").strip() != "":
                print(f"[whisper-final] raw='{raw_text}' filtered='' -> using RAW (fallback)")
                return raw_text

            # Log both raw and filtered for debugging
            try:
                if filtered != raw_text:
                    print(f"[whisper-final] raw='{raw_text}' filtered='{filtered}'")
                else:
                    print(f"[whisper-final] raw=filtered='{raw_text}'")
            except Exception:
                pass

            return filtered
        except Exception as e:
            print(f"[local-asr] Transcription error: {e}")
            return ""
    
    def run(self):
        """Main loop for local voice engine"""
        # Prefer hybrid ASR if available
        self._using_hybrid_asr = False
        if 'HYBRID_ASR_AVAILABLE' in globals() and HYBRID_ASR_AVAILABLE:
            try:
                self.hybrid_asr = HybridASREngine(
                    whisper_model=self.whisper_model_name,
                    on_partial=None,
                    on_final=None,
                    sample_rate=16000,
                )
                if self.hybrid_asr.start():
                    self._using_hybrid_asr = True
                    print("[local] 🎤 Local voice engine started (Hybrid ASR: Vosk streaming + Whisper final)")
                else:
                    self.hybrid_asr = None
            except Exception as e:
                print(f"[local] Hybrid ASR init failed, falling back to Whisper-only: {e}")
                self.hybrid_asr = None
        if not self.initialize():
            print("[local] Cannot start - Whisper initialization failed")
            return
        
        print("[local] 🎤 Local voice engine started (Whisper + Edge TTS)")
        self.running = True
        self.shutdown.clear()
        
        p = pyaudio.PyAudio()
        
        # Open microphone with rate cascade (try config rate, then 48000/44100/16000)
        aud_cfg = self.parent.cfg.get('audio') or {}
        config_sr = int(aud_cfg.get('input_sample_rate', 16000))
        _local_rates = list(dict.fromkeys([config_sr, 48000, 44100, 16000]))
        _local_mic_rate = 16000
        mic_stream = None
        target_idx = self.parent.input_device_index
        if target_idx is not None:
            for rate in _local_rates:
                try:
                    cf = max(int(rate * 0.02), 160)
                    kw = dict(format=pyaudio.paInt16, channels=1, rate=rate,
                              input=True, frames_per_buffer=cf, input_device_index=target_idx)
                    mic_stream = p.open(**kw)
                    _local_mic_rate = rate
                    info = p.get_device_info_by_index(target_idx)
                    print(f"[local] Opened input: {info.get('name')} (idx={target_idx}) @ {rate} Hz")
                    break
                except Exception as e:
                    print(f"[local] Device {target_idx} @ {rate} Hz failed: {e}")
        if mic_stream is None:
            for rate in _local_rates:
                try:
                    cf = max(int(rate * 0.02), 160)
                    kw = dict(format=pyaudio.paInt16, channels=1, rate=rate, input=True, frames_per_buffer=cf)
                    mic_stream = p.open(**kw)
                    _local_mic_rate = rate
                    info = p.get_default_input_device_info()
                    print(f"[local] Fallback input: {info.get('name')} (idx={info.get('index')}) @ {rate} Hz")
                    break
                except Exception as e:
                    print(f"[local] Default @ {rate} Hz failed: {e}")
        if mic_stream is None:
            print(f"[local] Mic open error: all rates {_local_rates} failed on all devices")
            return
        chunk_frames = max(int(_local_mic_rate * 0.02), 160)
        _local_need_resample = (_local_mic_rate != 16000)
        if _local_need_resample:
            print(f"[local] Will resample mic: {_local_mic_rate} Hz -> 16000 Hz")

        print("[local] 🎤 Microphone active - listening...")

        try:
            while not self.shutdown.is_set() and self.parent.running:
                try:
                    # Read audio chunk
                    audio_data = mic_stream.read(chunk_frames, exception_on_overflow=False)
                    if _local_need_resample:
                        audio_data = _resample_audio(audio_data, _local_mic_rate, 16000)
                    rms = self._rms(audio_data)
                    now = time.time()
                    
                    # HALF-DUPLEX: Skip if TTS is playing (mic muted during speech)
                    if self.parent.tts_active.is_set():
                        time.sleep(0.01)
                        continue
                    
                    # Hybrid ASR path: feed streaming engine and handle finalization
                    if getattr(self, '_using_hybrid_asr', False) and getattr(self, 'hybrid_asr', None):
                        try:
                            transcript = self.hybrid_asr.feed_audio(audio_data) or ""
                            if (not transcript) and (not self.hybrid_asr.is_speaking()) and self.hybrid_asr.has_enough_audio():
                                # Pass TTS/echo state so Whisper skips during playback
                                _tts_up = self.parent.tts_active.is_set()
                                _echo_up = (time.time() - getattr(self.parent, '_tts_last_active', 0)) < self.parent.cfg.get('echo_cancellation', {}).get('grace_period_sec', 3.0)
                                transcript = self.hybrid_asr.get_final_result(
                                    timeout=3.0, tts_active=_tts_up, echo_gate_active=_echo_up
                                ) or ""
                            if transcript:
                                # Check if AVA is being addressed (wake word detection)
                                is_addressed = self._is_addressed(transcript)

                                if is_addressed:
                                    print(f"\n🗣  You: {transcript}")
                                    self._store_overheard(transcript, responded=True)
                                else:
                                    # Not addressed - store for learning but don't respond
                                    print(f"\n[overheard]: {transcript}")
                                    self._store_overheard(transcript, responded=False)
                                    continue  # Skip responding, just listen and learn

                                # TURN STATE: Final transcript from local engine
                                print(f"[FINAL -> DECIDE] '{transcript[:40]}...'")
                                if hasattr(self.parent, '_turn_state'):
                                    self.parent._turn_state.transition(TurnState.LISTEN, "user speaking")
                                    self.parent._turn_state.transition(TurnState.FINAL, "final transcript")
                                    self.parent._turn_state.transition(TurnState.DECIDE, "processing")
                                tts_token = self.parent._turn_state.tts_token

                                # Get response from server (only if addressed)
                                loop = asyncio.new_event_loop()
                                try:
                                    # Check if this is a correction
                                    if hasattr(self.parent, '_detect_correction') and self.parent._detect_correction(transcript):
                                        self.parent._handle_correction(transcript)

                                    # Handle local intents first
                                    handled = loop.run_until_complete(
                                        self.parent._maybe_handle_local_intent(transcript, turn_id=tts_token)
                                    )
                                    if not handled:
                                        # Check for past mistakes
                                        enhanced = transcript
                                        if hasattr(self.parent, '_get_enhanced_transcript'):
                                            enhanced = self.parent._get_enhanced_transcript(transcript)

                                        # Get server response
                                        reply = loop.run_until_complete(
                                            self.parent._ask_server_respond(enhanced)
                                        )
                                        if reply:
                                            print(f"🤖 AVA: {reply}")
                                            # TURN STATE: Entering SPEAK phase
                                            if hasattr(self.parent, '_turn_state'):
                                                self.parent._turn_state.transition(TurnState.SPEAK, "TTS starting")
                                            try:
                                                loop.run_until_complete(
                                                    self.synthesize_speech(reply, turn_id=tts_token)
                                                )
                                            finally:
                                                # TURN STATE: Back to IDLE (guaranteed cleanup)
                                                if hasattr(self.parent, '_turn_state'):
                                                    self.parent._turn_state.force_idle("TTS complete")

                                            # Track for correction detection
                                            self.parent._last_user_transcript = transcript
                                            self.parent._last_ava_response = reply

                                            # Record interaction for passive learning
                                            if PASSIVE_LEARNING_AVAILABLE and hasattr(self.parent, 'passive_learning_enabled') and self.parent.passive_learning_enabled:
                                                try:
                                                    record_interaction(transcript, reply, True)
                                                except:
                                                    pass
                                        else:
                                            # No reply - return to IDLE
                                            if hasattr(self.parent, '_turn_state'):
                                                self.parent._turn_state.force_idle("no reply")
                                    else:
                                        # Local intent handled - return to IDLE
                                        if hasattr(self.parent, '_turn_state'):
                                            self.parent._turn_state.force_idle("local intent handled")
                                finally:
                                    loop.close()
                            # In hybrid path, skip legacy buffer/silence logic
                            continue
                        except Exception as e:
                            print(f"[local] Hybrid ASR feed error: {e}")
                    
                    # Accumulate audio
                    with self._buffer_lock:
                        self._audio_buffer.extend(audio_data)
                    
                    # Detect speech/silence
                    if rms > self._silence_threshold:
                        self._last_speech_time = now
                    
                    # Process when silence detected after speech
                    buffer_duration = len(self._audio_buffer) / (16000 * 2)  # seconds
                    silence_elapsed = now - self._last_speech_time if self._last_speech_time > 0 else 0
                    
                    if buffer_duration > 0.8 and silence_elapsed > self._silence_duration:
                        # GUARD: Do not dispatch Whisper during TTS or echo-gate period
                        _tts_up = self.parent.tts_active.is_set()
                        _echo_up = (time.time() - getattr(self.parent, '_tts_last_active', 0)) < self.parent.cfg.get('echo_cancellation', {}).get('grace_period_sec', 3.0)
                        if _tts_up or _echo_up:
                            with self._buffer_lock:
                                self._audio_buffer.clear()
                            self._last_speech_time = 0
                            continue

                        with self._buffer_lock:
                            audio_to_process = bytes(self._audio_buffer)
                            self._audio_buffer.clear()

                        self._last_speech_time = 0

                        # Transcribe
                        transcript = self.transcribe_audio(audio_to_process)
                        if transcript:
                            # Check if AVA is being addressed (wake word detection)
                            is_addressed = self._is_addressed(transcript)

                            if is_addressed:
                                print(f"\n🗣️  You: {transcript}")
                                self._store_overheard(transcript, responded=True)
                            else:
                                # Not addressed - store for learning but don't respond
                                print(f"\n[overheard]: {transcript}")
                                self._store_overheard(transcript, responded=False)
                                continue  # Skip responding, just listen and learn

                            # TURN STATE: Final transcript from local Whisper engine
                            print(f"[FINAL -> DECIDE] '{transcript[:40]}...'")
                            if hasattr(self.parent, '_turn_state'):
                                self.parent._turn_state.transition(TurnState.LISTEN, "user speaking")
                                self.parent._turn_state.transition(TurnState.FINAL, "final transcript")
                                self.parent._turn_state.transition(TurnState.DECIDE, "processing")
                            tts_token = self.parent._turn_state.tts_token if hasattr(self.parent, '_turn_state') else None

                            # Get response from server (only if addressed)
                            loop = asyncio.new_event_loop()
                            try:
                                # Check if this is a correction
                                if hasattr(self.parent, '_detect_correction') and self.parent._detect_correction(transcript):
                                    self.parent._handle_correction(transcript)

                                # Handle local intents first
                                handled = loop.run_until_complete(
                                    self.parent._maybe_handle_local_intent(transcript, turn_id=tts_token)
                                )
                                if not handled:
                                    # Check for past mistakes
                                    enhanced = transcript
                                    if hasattr(self.parent, '_get_enhanced_transcript'):
                                        enhanced = self.parent._get_enhanced_transcript(transcript)

                                    # Get server response
                                    reply = loop.run_until_complete(
                                        self.parent._ask_server_respond(enhanced)
                                    )
                                    if reply:
                                        print(f"🤖 AVA: {reply}")
                                        # TURN STATE: Entering SPEAK phase
                                        if hasattr(self.parent, '_turn_state'):
                                            self.parent._turn_state.transition(TurnState.SPEAK, "TTS starting")
                                        try:
                                            loop.run_until_complete(
                                                self.synthesize_speech(reply, turn_id=tts_token)
                                            )
                                        finally:
                                            # TURN STATE: Back to IDLE (guaranteed cleanup)
                                            if hasattr(self.parent, '_turn_state'):
                                                self.parent._turn_state.force_idle("TTS complete")

                                        # Track for correction detection
                                        self.parent._last_user_transcript = transcript
                                        self.parent._last_ava_response = reply

                                        # Record interaction for passive learning
                                        if PASSIVE_LEARNING_AVAILABLE and hasattr(self.parent, 'passive_learning_enabled') and self.parent.passive_learning_enabled:
                                            try:
                                                record_interaction(transcript, reply, True)
                                            except:
                                                pass
                                    else:
                                        # No reply - return to IDLE
                                        if hasattr(self.parent, '_turn_state'):
                                            self.parent._turn_state.force_idle("no reply")
                                else:
                                    # Local intent handled - return to IDLE
                                    if hasattr(self.parent, '_turn_state'):
                                        self.parent._turn_state.force_idle("local intent handled")
                            finally:
                                loop.close()

                    # Limit buffer size (max 30 seconds)
                    max_buffer = 16000 * 2 * 30
                    with self._buffer_lock:
                        if len(self._audio_buffer) > max_buffer:
                            self._audio_buffer = self._audio_buffer[-max_buffer:]
                            
                except Exception as e:
                    print(f"[local] Loop error: {e}")
                    time.sleep(0.1)
                    
        finally:
            self.running = False
            try:
                mic_stream.stop_stream()
                mic_stream.close()
            except:
                pass
            p.terminate()
            print("[local] Local voice engine stopped")
    
    def stop(self):
        """Stop the local voice engine"""
        self.shutdown.set()
        self.running = False
        try:
            if getattr(self, 'hybrid_asr', None):
                self.hybrid_asr.stop()
        except Exception:
            pass


# Voice Engine State
class VoiceEngineState:
    """Tracks which voice engine is active and manages switching"""
    DEEPGRAM = "deepgram"
    LOCAL = "local"
    SWITCHING = "switching"
    
    def __init__(self):
        self.current = self.DEEPGRAM
        self.lock = threading.Lock()
        self.deepgram_available = True
        self.last_deepgram_check = 0
        self.deepgram_check_interval = 300  # Check every 5 minutes
        self.consecutive_errors = 0
        self.error_threshold = 3  # Switch after 3 consecutive errors




def _normalize_transcript_words(text: str) -> list[str]:
    text = (text or '').lower().strip()
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return [w for w in text.split() if w]


def _normalized_transcript(text: str) -> str:
    return ' '.join(_normalize_transcript_words(text))


def _normalized_wake_phrases(wake_words) -> list[str]:
    phrases = []
    for wake in wake_words or []:
        norm = _normalized_transcript(wake)
        if norm:
            phrases.append(norm)
    return sorted(set(phrases), key=len, reverse=True)


def _transcript_has_wake_phrase(text: str, wake_words) -> bool:
    txt = _normalized_transcript(text)
    if not txt:
        return False
    for wake in _normalized_wake_phrases(wake_words):
        if txt == wake or txt.startswith(wake + ' ') or (' ' + wake + ' ') in (' ' + txt + ' '):
            return True
    return False


class _DeterministicInputStream:
    def __init__(self, wav_path: str, target_rate: int = 16000, channels: int = 1):
        self.wav_path = wav_path
        self.target_rate = int(target_rate)
        self.channels = int(channels)
        self._closed = False
        with wave.open(self.wav_path, 'rb') as wf:
            raw = wf.readframes(wf.getnframes())
            src_rate = int(wf.getframerate())
            src_channels = int(wf.getnchannels())
        if src_channels > 1:
            raw = audioop.tomono(raw, 2, 0.5, 0.5)
        if src_rate != self.target_rate:
            raw, _ = audioop.ratecv(raw, 2, 1, src_rate, self.target_rate, None)
        self._pcm = raw
        self._pos = 0

    def read(self, num_frames: int, exception_on_overflow: bool = False):
        if self._closed:
            return b''
        byte_count = max(1, int(num_frames)) * 2 * self.channels
        chunk = self._pcm[self._pos:self._pos + byte_count]
        self._pos += len(chunk)
        if len(chunk) < byte_count:
            chunk += b'\x00' * (byte_count - len(chunk))
            time.sleep(0.02)
        return chunk

    def stop_stream(self):
        self._closed = True

    def close(self):
        self._closed = True

    def is_active(self):
        return not self._closed and self._pos < len(self._pcm)
class StandaloneRealtimeAVA:
    # Command verbs that signal "do something" — tools require at least one
    COMMAND_VERBS = {
        'open', 'search', 'create', 'type', 'send', 'close', 'start', 'stop',
        'run', 'delete', 'move', 'rename', 'copy', 'paste', 'click', 'scroll',
        'navigate', 'install', 'download', 'upload', 'write', 'edit', 'save',
        'launch', 'kill', 'terminate', 'shutdown', 'restart', 'pause', 'resume',
        'turn', 'set', 'change', 'switch', 'enable', 'disable', 'execute',
        'find', 'show', 'play', 'record', 'capture', 'screenshot', 'take',
        'make', 'build', 'deploy', 'push', 'pull', 'commit', 'format',
        'remember', 'forget',
    }

    def __init__(self):
        load_into_env()

        # Load provider keys (optional; auto-select voice later)
        self.deepgram_key = os.getenv("DEEPGRAM_API_KEY") or self._read_key_file("deepgram key.txt")
        self.gemini_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or self._read_key_file("gemini api key.txt")
        self.claude_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("CLAUDE_API_KEY") or self._read_key_file("claude api key.txt")
        self.openai_key = os.getenv("OPENAI_API_KEY") or self._read_key_file("openai api key.txt")
        self.groq_key = os.getenv("GROQ_API_KEY") or self._read_key_file("groq api key.txt")

        # Set environment variables for available providers (no-ops if missing)
        if self.gemini_key:
            os.environ['GOOGLE_API_KEY'] = self.gemini_key
        if self.claude_key:
            os.environ['ANTHROPIC_API_KEY'] = self.claude_key
        if self.openai_key:
            os.environ['OPENAI_API_KEY'] = self.openai_key
        if self.groq_key:
            os.environ['GROQ_API_KEY'] = self.groq_key

        self.config = Config.from_env()
        self.agent = Agent(self.config)

        # Audio setup
        self.audio = pyaudio.PyAudio()
        self.websocket = None  # unused now; kept for cleanup compatibility
        self.asr_ws = None
        self.running = False

        # Session state
        self.session_id = None

        # Audio playback queue and thread
        self._audio_queue_maxsize = 50
        self.audio_queue = queue.Queue(maxsize=self._audio_queue_maxsize)  # Limit queue to prevent stale audio
        self.playback_thread = None
        self.playback_stream = None
        self._playback_abort_until = 0.0
        # Barge-in / echo gating
        self.tts_active = threading.Event()
        self.user_speaking = threading.Event()
        self.barge_mode = threading.Event()
        # Per-turn suppression of Agent TTS when executing tools to avoid the agent speaking tool names/JSON
        self._drop_agent_tts = threading.Event()
        self._drop_until_ts = 0.0
        self.playback_busy = threading.Event()
        self._last_user_voice_t = 0.0
        self._loud_frames = 0
        self.START_THRESH = 180   # lower start RMS to detect normal speech more easily
        self.STOP_THRESH = 120    # lower stop RMS for quicker end-of-speech detection
        self.SPEECH_HOLD_SEC = 1.0  # Slightly longer hold to prevent choppy audio
        self.playback_rate = PLAYBACK_RATE
        self.output_device_index = None
        self.input_device_index = None
        # EMA of playback RMS to help echo gating across threads
        self._playback_rms_ema = 0.0
        
        # Echo cancellation settings
        self._echo_suppression_enabled = True
        self._tts_active_recently = threading.Event()
        self._tts_cooldown_sec = 2.5  # Seconds to suppress mic after TTS (longer to prevent feedback loops)

        # D005 Barge-in settings (default OFF per D005)
        self._barge_in_enabled = False
        self._barge_in_min_speech_ms = 500
        self._barge_in_require_final = True
        self._barge_in_cancel_tts = True
        self._barge_in_cooldown_ms = 1000
        self._barge_in_last_interrupt_time = 0.0

        # Turn state machine for voice stabilization
        self._turn_state = TurnStateMachine(barge_in_enabled=self._barge_in_enabled)

        # Safe mode support (set by crash supervisor)
        self._safe_mode = os.environ.get('AVA_SAFE_MODE', '0') == '1'
        if self._safe_mode:
            print("[SAFE_MODE] Running in safe mode - fragile features disabled")
            self._barge_in_enabled = False
            self._turn_state.barge_in_enabled = False

        # Validation mode defaults (actual initialization happens after config load)
        self._validation_mode = os.environ.get('VALIDATION_MODE', '0') == '1'
        self._wake_words = []
        self._min_words_without_wake = 0
        self._blocked_tools = set()
        self._require_wake_for_tools = False
        self._wake_followup_until = 0.0
        self._wake_followup_sec = 6.0
        self._wake_followup_silent_reply = '__AVA_WAKE_FOLLOWUP_SILENT__'

        # State file for crash supervisor (written on turn state changes)
        self._state_file_path = Path(__file__).parent / 'logs' / 'runner_state.json'
        self._state_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._write_runner_state()

        # Debug flags (hot‑reloadable via config)
        self.debug_agent = False
        self.debug_tools = False
        self._debug_log_path = str((Path(__file__).with_name('ava_debug.log')).resolve())

        # Correction tracking for pattern learning
        self._last_user_transcript = ""
        self._last_ava_response = ""
        
        # DUPLICATE PREVENTION: Track recent transcripts to prevent repeats
        self._recent_transcripts = {}  # transcript -> timestamp
        self._duplicate_window_sec = 5.0  # Ignore duplicates within 5 seconds
        
        self._correction_patterns = [
            r"^no[,.]?\s",
            r"^that'?s (not|wrong)",
            r"^i (said|meant|asked)",
            r"^actually[,.]?\s",
            r"^not what i",
            r"^wrong[,.]",
            r"^i didn'?t (say|mean|ask)",
            r"^you misunderstood",
            r"^that'?s not (right|correct|what)",
        ]

        # Hot-reloadable runtime config
        self.config_path = Path(__file__).with_name('ava_voice_config.json')
        self.cfg = {
            "speak_symbols": False,                 # if False: strip symbols/punctuation from TTS
            "server_url": "http://127.0.0.1:5051/respond",
            "server_route": "respond",  # 'chat' or 'respond'
            "vad": {"start_rms": self.START_THRESH, "stop_rms": self.STOP_THRESH, "hold_sec": self.SPEECH_HOLD_SEC,
                    "calibrate_noise_floor": True, "calibration_ms": 1000, "calibration_margin_rms": 0,
                    "calibration_scale": 2.5},
            "audio": {"playback_rate": self.playback_rate, "output_device": None, "input_device": None},
            "asr_model": "nova-2",
            "tts_model": "aura-2-andromeda-en",
            "deepgram_api_key": None,
            "debug_asr": False,
            "debug_rms": False,
            "debug_text": False,
            "allow_barge": True,
            "voice_mode": "agent",
            "auto_start_server": True,
            "barge": {"min_tts_ms": 900, "debounce_frames": 6, "dyn_thresh_scale": 0.9},
            "local_fallback": {
                "whisper_model": "small",
                "edge_voice": "en-US-MichelleNeural",
                "auto_switch": True,
                "force_local": False,  # Set to true to skip Deepgram and use local only
                "health_check_interval": 300
            }
        }
        self._cfg_mtime = 0.0
        self._identity_mtime = 0.0
        self._load_config(silent=True)

        # Optional: calibrate VAD thresholds against ambient noise at boot
        try:
            vad_cfg = self.cfg.get('vad') or {}
            if bool(vad_cfg.get('calibrate_noise_floor', True)):
                self._calibrate_noise_floor(
                    duration_ms=int(vad_cfg.get('calibration_ms', 700)),
                    margin_rms=int(vad_cfg.get('calibration_margin_rms', 200)),
                    scale=float(vad_cfg.get('calibration_scale', 2.5)),
                )
        except Exception as e:
            print(f"[vad-cal] Calibration skipped: {e}")

        # Validation mode initialization (AFTER config is loaded)
        val_cfg = self.cfg.get('validation_mode', {})
        if val_cfg.get('enabled', False):
            self._validation_mode = True
        if self._validation_mode:
            print("[VALIDATION_MODE] Running in validation mode - wake word required")
            # Force half-duplex (no barge-in)
            if val_cfg.get('force_half_duplex', True):
                self._barge_in_enabled = False
                self._turn_state.barge_in_enabled = False
            # Load wake words
            self._wake_words = [w.lower() for w in val_cfg.get('wake_words', ['ava', 'eva', 'hey ava'])]
            self._min_words_without_wake = val_cfg.get('min_words_without_wake', 3)
            self._blocked_tools = set(val_cfg.get('blocked_tools', ['camera_ops']))
            self._require_wake_for_tools = val_cfg.get('require_wake_for_tools', True)
            self._wake_followup_sec = float(val_cfg.get('followup_window_sec', 6.0) or 6.0)
            # Vosk ASR frequently misrecognizes "ava" — map known aliases
            self._vosk_wake_aliases = [
                ('hey we\'re', 'hey ava'),
                ('hey we\'ll', 'hey ava'),
                ('hey a were', 'hey ava'),
                ('hey able', 'hey ava'),
                ('the able', 'hey ava'),
                ('be able', 'hey ava'),
                ('hey uber', 'hey ava'),
                ('however', 'hey ava'),
                ('haber', 'ava'),
                ('aber', 'ava'),
                ('abba', 'ava'),
                ('able', 'ava'),
            ]
            print(f"  Wake words: {self._wake_words}")
            print(f"  Min words without wake: {self._min_words_without_wake}")
            print(f"  Blocked tools: {self._blocked_tools}")
            # Phase C: ensure workable VAD in validation regardless of file config
            try:
                # Force calibration in validation even if config disabled
                self._calibrate_noise_floor(duration_ms=1000, margin_rms=0, scale=2.5)
            except Exception as e:
                print(f"[vad-cal] Validation calibration skipped: {e}")
            # If still too high, hard-cap to immediate workable defaults
            if self.START_THRESH and self.START_THRESH > 300:
                print(f"[vad-cal] Validation override: START={self.START_THRESH} too high -> setting START=200 STOP=120")
                self.START_THRESH = 200
                self.STOP_THRESH = 120

        try:
            if self.identity_path.exists():
                self._identity_mtime = self.identity_path.stat().st_mtime
        except Exception:
            self._identity_mtime = 0.0

        # Identity profile
        self.identity_path = Path(__file__).with_name('ava_identity.json')
        self.identity = self._load_identity()
        self.started_at = time.time()
        self.metrics = {
            'asr_messages': 0,
            'asr_finals': 0,
            'tts_utterances': 0,
            'reconnects': 0,
            'last_error': '',
            # Realtime feel metrics
            'last_capture_to_partial_ms': 0,
            'last_eos_to_first_audio_ms': 0,
            'last_barge_stop_ms': 0,
            'playback_queue_frames': 0,
            'last_vad_end_to_first_audio_ms': 0,
            'last_vad_end_to_asr_final_ms': 0,
            'asr_final_to_first_audio_ms': 0,
        }
        self._speech_start_ts = 0.0
        self._speech_end_ts = 0.0
        self._first_partial_ts = 0.0
        self._awaiting_tts_since = 0.0
        self._tts_first_chunk_ts = 0.0
        self._user_speaking_started_ts = 0.0

        # Doctor/apply voice approval state
        self._pending_apply_until = 0.0
        self._apply_reason = ''
        self._apply_hotkey_armed = False
        self._apply_hotkey_armed_until = 0.0

        # Voice Engine State (auto-fallback between Deepgram and Local)
        self.voice_engine_state = VoiceEngineState()
        self.local_voice_engine = None
        if LOCAL_FALLBACK_AVAILABLE:
            local_cfg = self.cfg.get('local_fallback', {})
            self.local_voice_engine = LocalVoiceEngine(
                self,
                whisper_model=local_cfg.get('whisper_model', 'base'),
                edge_voice=local_cfg.get('edge_voice', 'en-US-MichelleNeural')
            )
            print("[voice] Local fallback engine available (Whisper + Edge TTS)")
        else:
            print("[voice] Local fallback NOT available (install faster-whisper and edge-tts)")

        # Personality system
        self.personality = None
        if PERSONALITY_AVAILABLE:
            try:
                self.personality = get_personality()
                print("[personality] Personality system loaded")
            except Exception as e:
                print(f"[personality] Error loading: {e}")
        else:
            print("[personality] Personality system NOT available")

        # Self-modification system
        self.self_mod_enabled = False
        if SELF_MOD_AVAILABLE:
            try:
                # Verify we can diagnose the codebase
                diag = diagnose_codebase()
                if diag.get("status") == "ok":
                    self.self_mod_enabled = True
                    print(f"[self-mod] Self-modification system loaded ({diag.get('files_found', 0)} core files)")
                else:
                    print(f"[self-mod] Codebase diagnosis failed: {diag.get('error', 'unknown')}")
            except Exception as e:
                print(f"[self-mod] Error initializing: {e}")
        else:
            print("[self-mod] Self-modification system NOT available")

        # Self-awareness system
        self.self_awareness = None
        self.self_awareness_enabled = False
        if SELF_AWARENESS_AVAILABLE:
            try:
                self.self_awareness = get_self_awareness()
                diag = self_diagnose()
                self.self_awareness_enabled = True
                status = diag.get("overall_status", "unknown")
                facts_count = diag.get("learning", {}).get("facts_learned", 0)
                print(f"[self-awareness] Self-awareness loaded (status: {status}, {facts_count} facts learned)")
            except Exception as e:
                print(f"[self-awareness] Error initializing: {e}")
        else:
            print("[self-awareness] Self-awareness system NOT available")

        # Server truth: capabilities/explain (refresh periodically)
        self.server_client = None
        self.server_caps = None
        self.server_explain = None
        if SERVER_CLIENT_AVAILABLE:
            try:
                base = self.cfg.get('server_url', 'http://127.0.0.1:5051/respond')
                token = os.getenv('AVA_API_TOKEN')
                self.server_client = AvaServerClient(base_url=base, token=token, timeout=2.0)
                self._refresh_server_truth()
                # Background refresher
                self._server_sync_thread = threading.Thread(target=self._server_sync_loop, daemon=True)
                self._server_sync_thread.start()
                print("[server] Capabilities/explain cache initialized")
            except Exception as e:
                print(f"[server] Truth sync init failed: {e}")

        # Hotkey listener (Windows only)
        if MSVCRT_AVAILABLE and self.cfg.get('hotkeys', {}).get('enabled', True):
            try:
                self._hotkey_thread = threading.Thread(target=self._hotkey_loop, daemon=True)
                self._hotkey_thread.start()
                print("[hotkeys] F9: Doctor report, F10: Apply (double-press to confirm)")
            except Exception as e:
                print(f"[hotkeys] init failed: {e}")

        # Passive learning system (disabled in validation mode)
        self.passive_learning = None
        self.passive_learning_enabled = False
        val_cfg = self.cfg.get('validation_mode', {})
        if self._validation_mode and val_cfg.get('disable_passive_learning', True):
            print("[passive-learning] Passive learning DISABLED (validation mode)")
        elif PASSIVE_LEARNING_AVAILABLE:
            try:
                self.passive_learning = get_passive_learning()
                start_passive_learning()
                self.passive_learning_enabled = True
                summary = get_learning_summary()
                print(f"[passive-learning] Passive learning started ({summary.get('total_observations', 0)} observations)")
            except Exception as e:
                print(f"[passive-learning] Error initializing: {e}")
        else:
            print("[passive-learning] Passive learning NOT available")

        print("=" * 80)
        print("AVA STANDALONE - VOICE (Auto)")
        print("=" * 80)
        print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        # Decide voice mode now (auto if not set)
        self.voice_selected = self._select_voice_mode()
        if self.voice_selected == 'unified':
            # Determine TTS engine for banner
            lf = (self.cfg.get('local_fallback') or {})
            tts_engine = str(lf.get('tts_engine', 'edge')).lower()
            tts_label = 'Piper' if tts_engine == 'piper' else 'Edge'
            print(f"ASR: Hybrid (Vosk streaming + Whisper final) @ {MIC_RATE} Hz | TTS: {tts_label}")
            print(f"Intelligence: AVA Server (/respond)")
            print(f"Mode: Unified Local Voice")
        else:
            print(f"ASR: Deepgram nova-2 @ {MIC_RATE} Hz | TTS: aura-2-andromeda-en @ {PLAYBACK_RATE} Hz")
            print(f"Intelligence: AVA Server / Agent")
            print(f"Mode: Cloud Voice (Deepgram Agent)")
        print(f"Tools Available: 20 JARVIS-level capabilities")
        print("=" * 80)
        print("Features:")
        if self._validation_mode:
            print("  - Wake word required before commands")
            if self._wake_followup_sec > 0:
                print(f"  - {self._wake_followup_sec:g}s silent follow-up window after wake")
            print("  - Half-duplex local voice conversation")
        else:
            print("  - Always listening (no wake word needed)")
            print("  - Bidirectional realtime voice conversation")
        if self._barge_in_enabled:
            print("  - Can interrupt AVA mid-sentence")
        else:
            print("  - Half-duplex playback (barge-in disabled)")
        print("  - Local AVA Server brain over /respond")
        print("  - Full access to all 20 AVA tools")
        print("  - Smart Voice Activity Detection")
        print("=" * 80)

        # Unified voice (scaffold) state
        self._voice_bus = None
        self._voice_provider = None
        self._voice_session = None
        # Brain status for banner
        self._brain_status = 'unknown'
        self._brain_pid = None

        # NEW: Session manager for persistent conversations
        self.voice_session = None
        self.session_manager_enabled = False
        if SESSION_MANAGER_AVAILABLE:
            try:
                self.voice_session = get_session()
                self.session_manager_enabled = True
                print(f"[session] Session manager loaded ({len(self.voice_session.conversation_history)} history items)")
            except Exception as e:
                print(f"[session] Error initializing: {e}")
        else:
            print("[session] Session manager NOT available")

        # NEW: Accuracy monitor for ASR quality tracking
        self.accuracy_monitor = None
        self.accuracy_monitor_enabled = False
        if SESSION_MANAGER_AVAILABLE:
            try:
                self.accuracy_monitor = get_accuracy_monitor()
                self.accuracy_monitor_enabled = True
                stats = self.accuracy_monitor.get_accuracy_stats(days=1)
                print(f"[accuracy] ASR accuracy monitor loaded ({stats['total_corrections']} corrections today)")
            except Exception as e:
                print(f"[accuracy] Error initializing: {e}")
        else:
            print("[accuracy] Accuracy monitor NOT available")

        # NEW: Intent router for command classification
        self.intent_router = None
        self.intent_router_enabled = False
        if INTENT_ROUTER_AVAILABLE:
            try:
                self.intent_router = IntentRouter()
                self.intent_router_enabled = True
                print("[intent] Intent router loaded (13 intent categories)")
            except Exception as e:
                print(f"[intent] Error initializing: {e}")
        else:
            print("[intent] Intent router NOT available")

        # NEW: Proactive mode (disabled in validation mode)
        self.proactive_manager = None
        self.proactive_enabled = False
        val_cfg = self.cfg.get('validation_mode', {})
        if self._validation_mode and val_cfg.get('disable_proactive', True):
            print("[proactive] Proactive assistance DISABLED (validation mode)")
        elif PASSIVE_LEARNING_AVAILABLE:
            try:
                from ava_passive_learning import ProactiveManager
                self.proactive_manager = ProactiveManager()
                # Start proactive monitoring in background
                self.proactive_manager.start()
                self.proactive_enabled = True
                print("[proactive] Proactive assistance enabled")
            except Exception as e:
                print(f"[proactive] Error initializing: {e}")
        else:
            print("[proactive] Proactive assistance NOT available")

        # --- DEFINITIVE VALIDATION MODE SUMMARY (after all systems initialized) ---
        print(f"[VALIDATION_MODE] Active={self._validation_mode} "
              f"wake_required={bool(self._wake_words)} "
              f"require_wake_for_tools={self._require_wake_for_tools} "
              f"barge_in={self._barge_in_enabled} "
              f"proactive={'disabled' if not self.proactive_enabled else 'enabled'} "
              f"passive_learning={'disabled' if not self.passive_learning_enabled else 'enabled'}")

        # Pending confirmation state for destructive actions
        self._pending_confirmation = None
        self._pending_confirmation_until = 0.0

    # ---------------------- Unified Voice ----------------------
    def _cancel_tts_playback(self):
        try:
            # Signal speaking stopped and clear queued audio
            self.tts_active.clear()
            # Abort immediate playback for a short window; playback loop drops frames
            try:
                self._playback_abort_until = time.time() + 0.25  # ~250ms abort window
            except Exception:
                pass
            if hasattr(self, 'audio_queue') and self.audio_queue is not None:
                try:
                    while not self.audio_queue.empty():
                        self.audio_queue.get_nowait()
                except Exception:
                    pass
            # Interrupt TTS generator to clear any decoder state
            try:
                if getattr(self, '_voice_session', None):
                    self._voice_session.stop_speaking()
            except Exception:
                pass
            # Reset utterance playback-rate check so next utterance can adjust rate
            try:
                self._utter_rate_checked = False
            except Exception:
                pass
        except Exception:
            pass

    def _segment_text_for_tts(self, text: str) -> list[str]:
        """Split text into short, speech-friendly segments to enable microstreaming.
        Prefer sentence/phrase boundaries; fall back to fixed-size chunks.
        """
        try:
            # Optional prosody preprocessing before segmentation
            cfg = getattr(self, 'cfg', {}) or {}
            try:
                pp = ProsodyPreprocessor(cfg)
                txt = pp.process(text or '')
            except Exception:
                txt = (text or '').strip()
            if not txt:
                return []
            segmenting_enabled = os.environ.get("AVA_TTS_SEGMENTING", "0").strip().lower() in {"1", "true", "on", "yes"}
            if not segmenting_enabled:
                return [txt]
            # First, split on strong punctuation
            import re as _re
            parts = [p.strip() for p in _re.split(r"(?<=[\.!?])\s+", txt) if p and p.strip()]
            segs: list[str] = []
            for p in parts:
                if len(p) <= 140:
                    segs.append(p)
                else:
                    # Further split long sentences on commas/semicolons
                    subs = [s.strip() for s in _re.split(r"(?<=[,;:])\s+", p) if s and s.strip()]
                    for s in subs:
                        if len(s) <= 140:
                            segs.append(s)
                        else:
                            # Fixed-size fallback
                            for i in range(0, len(s), 120):
                                segs.append(s[i:i+120])
            return segs
        except Exception:
            return [text]

    def _normalize_for_wake(self, text: str) -> str:
        """Normalize known Vosk misrecognitions of 'ava' before wake word detection."""
        lower = text.lower().strip()
        # 1. Exact alias lookup
        aliases = getattr(self, '_vosk_wake_aliases', [])
        for alias, replacement in aliases:
            if lower.startswith(alias):
                lower = replacement + lower[len(alias):]
                print(f"[vosk-alias] '{text[:30]}' -> '{lower[:30]}' (matched '{alias}')")
                return lower
        # 2. Fuzzy match: if first/second word is close to 'ava'/'eva', treat as wake word
        words = lower.split()
        if not words:
            return lower
        wake_targets = ['ava', 'eva']
        for i, word in enumerate(words[:2]):
            clean = word.strip('.,!?')
            if len(clean) < 2 or len(clean) > 5:
                continue
            for target in wake_targets:
                dist = self._edit_distance(clean, target)
                if dist <= 1:  # 1 edit away from ava/eva
                    words[i] = target
                    result = ' '.join(words)
                    print(f"[vosk-fuzzy] '{text[:30]}' -> '{result[:30]}' ('{clean}'~'{target}' dist={dist})")
                    return result
            # Also check "hey/ok X" where X is <=2 edits from ava/eva
            # (looser threshold OK because "hey" prefix narrows context)
            if i == 0 and clean in ('hey', 'ok', 'okay', 'hi', 'hello') and len(words) > 1:
                w2 = words[1].strip('.,!?')
                if len(w2) >= 2 and len(w2) <= 5:
                    for target in wake_targets:
                        dist = self._edit_distance(w2, target)
                        if dist <= 2:
                            words[1] = target
                            result = ' '.join(words)
                            print(f"[vosk-fuzzy] '{text[:30]}' -> '{result[:30]}' ('hey {w2}'~'hey {target}' dist={dist})")
                            return result
        return lower

    @staticmethod
    def _edit_distance(s1: str, s2: str) -> int:
        """Levenshtein edit distance between two strings."""
        if len(s1) < len(s2):
            return StandaloneRealtimeAVA._edit_distance(s2, s1)
        if len(s2) == 0:
            return len(s1)
        prev = list(range(len(s2) + 1))
        for i, c1 in enumerate(s1):
            curr = [i + 1]
            for j, c2 in enumerate(s2):
                curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (0 if c1 == c2 else 1)))
            prev = curr
        return prev[-1]

    def _init_unified_voice(self):
        if not _VOICE_SCAFFOLD_AVAILABLE:
            raise RuntimeError("Unified voice scaffold not available")
        if self._voice_session is not None:
            return

        # Create bus and provider
        self._voice_bus = _VoiceEventBus()
        whisper_model = (self.cfg.get('local_fallback') or {}).get('whisper_model', 'tiny.en')
        wake_words = self._wake_words if self._validation_mode else None
        asr_silence_threshold = int(max(600, self.START_THRESH * 1.5, self.STOP_THRESH * 2.5))
        self._voice_provider = _LocalHybridProvider(
            self._voice_bus,
            whisper_model=whisper_model,
            wake_words=wake_words,
            use_vosk_final_direct=False,
            silence_threshold=asr_silence_threshold,
            silence_duration=0.35,
            min_audio_length=0.45,
            max_utterance_sec=4.5,
        )
        print(f"[voice-unified] ASR silence threshold: {asr_silence_threshold}")
        # Utterance commit tracking
        self._utt_committed = set()
        self._last_asr_final_meta = {}

        # Track when TTS last ended for echo grace period
        self._tts_ended_at = 0.0

        # Bridge: on final user text -> existing respond + TTS path
        def _on_final_user_text(txt: str):
            if not txt:
                return
            # Trace setup (per-final)
            try:
                import uuid as _uuid
            except Exception:
                _uuid = None
            _trace_id = None
            try:
                _trace_id = getattr(self._turn_state, 'tts_token', None)
            except Exception:
                _trace_id = None
            if not _trace_id:
                try:
                    _trace_id = (_uuid.uuid4().hex[:8] if _uuid else f"t{int(time.time()*1000)%100000:05d}")
                except Exception:
                    _trace_id = "trc-unknown"

            def _emit_trace(outcome: str, input_kind: str, gate=None, suppress=None, extra=None):
                try:
                    gate = gate or {}
                    suppress = suppress or {}
                    extra = extra or {}
                    gate_s = ','.join([f"{k}={gate[k]}" for k in sorted(gate.keys())]) if gate else ''
                    sup_s = ','.join([f"{k}={suppress[k]}" for k in sorted(suppress.keys())]) if suppress else ''
                    ext_s = ','.join([f"{k}={extra[k]}" for k in sorted(extra.keys())]) if extra else ''
                    line = "[trace] trc={trc} input={inp} gate={{{gate}}} suppress={{{sup}}} extra={{{ext}}} outcome={out}".format(
                        trc=_trace_id, inp=input_kind, gate=gate_s, sup=sup_s, ext=ext_s, out=outcome
                    )
                    print(line)
                except Exception:
                    pass
            # VOSK ALIAS NORMALIZATION: Replace known misrecognitions before any processing
            # This ensures the corrected text is used downstream (server, LLM, TTS)
            normalized = self._normalize_for_wake(txt)
            if normalized != txt.lower().strip():
                txt = normalized  # Use corrected transcript from here on

            # ECHO GATE: Ignore ASR finals while TTS is being synthesized or queued playback is draining.
            if self.tts_active.is_set() or getattr(self, '_awaiting_playback_end', False):
                print(f"[echo-gate] Ignoring ASR final during TTS/playback: {txt[:30]}...")
                _emit_trace(outcome="IGNORE", input_kind="unknown",
                            gate=dict(wake_ok=None, tool_ok=None, verb_ok=None, echo_blackout=False),
                            suppress=dict(during_tts=True))
                return
            # PLAYBACK-END BLACKOUT: authoritative tail suppression after audio finishes
            import time
            blackout_until = getattr(self, "_asr_blackout_until", 0.0) or 0.0
            if time.time() < blackout_until:
                print(f"[echo-gate] Ignoring ASR final in blackout: {txt[:30]}...")
                _emit_trace(outcome="IGNORE", input_kind="unknown",
                            gate=dict(wake_ok=None, tool_ok=None, verb_ok=None, echo_blackout=True),
                            suppress=dict(blackout=True))
                return

            # VALIDATION MODE: Filter transcripts by wake word and minimum words
            if self._validation_mode:
                import time
                meta = getattr(getattr(self, '_voice_session', None), '_last_user_final_meta', None) or self._last_asr_final_meta or {}
                soft_wake_rescue = bool(meta.get('soft_wake_rescue'))
                has_wake_word = _transcript_has_wake_phrase(txt, self._wake_words)
                wake_followup_active = bool(getattr(self, '_wake_followup_until', 0.0) and time.time() < getattr(self, '_wake_followup_until', 0.0))
                if not has_wake_word and not soft_wake_rescue and not wake_followup_active:
                    word_count = len(_normalize_transcript_words(txt))
                    print(f"[validation-mode] Ignoring short transcript without wake word: '{txt}' ({word_count} words)")
                    self._store_overheard(txt, responded=False)
                    return
                if soft_wake_rescue:
                    print(f"[validation-mode] Accepting transcript via ASR soft wake rescue: '{txt[:60]}'")
                if wake_followup_active:
                    self._wake_followup_until = 0.0
            # TURN STATE: Final transcript from unified voice session
            print(f"[FINAL -> DECIDE] '{txt[:40]}...'")
            try:
                # Reflect actual gate state for visibility
                _gate_wake = True
                try:
                    _gate_wake = bool(locals().get('_wake_ok', True))
                except Exception:
                    _gate_wake = True
                _emit_trace(outcome="DECIDE", input_kind="chat",
                            gate=dict(wake_ok=_gate_wake, tool_ok=None, verb_ok=None, echo_blackout=False))
            except Exception:
                pass
            self._turn_state.transition(TurnState.LISTEN, "user speaking")
            self._turn_state.transition(TurnState.FINAL, "final transcript")
            self._turn_state.transition(TurnState.DECIDE, "processing")
            tts_token = self._turn_state.tts_token

            # Mirror correction/local-intent/enhancement + respond flow
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                # Reset utterance rate check for new TTS
                try:
                    self._utter_rate_checked = False
                except Exception:
                    pass
                # Track correction
                if self._detect_correction(txt):
                    self._handle_correction(txt)
                # Local intents first
                handled = loop.run_until_complete(self._maybe_handle_local_intent(txt, turn_id=tts_token))
                if not handled:
                    enhanced = self._get_enhanced_transcript(txt)
                    # Utterance commit handling
                    meta = getattr(getattr(self, '_voice_session', None), '_last_user_final_meta', None) or self._last_asr_final_meta or {}
                    utt_id = meta.get('utterance_id')
                    if utt_id and utt_id in getattr(self, '_utt_committed', set()):
                        self._turn_state.force_idle("duplicate utterance")
                        return
                    # Mark ASR final timestamp for metrics
                    asr_final_ts = time.time()
                    self._asr_final_ts = asr_final_ts
                    self._write_latency_log_entry({
                        "stage": "asr_final",
                        "ts": asr_final_ts,
                        "utterance_id": utt_id,
                    })
                    reply = loop.run_until_complete(self._ask_server_respond(enhanced))
                    self._write_latency_log_entry({
                        "stage": "llm_done",
                        "ts": time.time(),
                        "utterance_id": utt_id,
                    })
                    if reply:
                        # TURN STATE: Entering SPEAK phase
                        self._turn_state.transition(TurnState.SPEAK, "TTS starting")
                        # Speak via unified TTS (Edge TTS streaming)
                        try:
                            self._awaiting_tts_since = time.time()
                            self._tts_first_chunk_ts = 0.0
                            try:
                                if self._speech_end_ts:
                                    self.metrics['last_vad_end_to_asr_final_ms'] = int((asr_final_ts - self._speech_end_ts) * 1000)
                            except Exception:
                                pass
                            print(f"[tts-debug] speak() called with: {reply[:50]}...")
                            # TURN-SCOPED TTS GATE for unified path
                            active_token = self._turn_state.tts_token
                            if tts_token != active_token:
                                print(f"[tts.blocked_background] Rejected (unified): turn_id={tts_token} active={active_token}")
                                # No TTS will fire, so no tts.end event - force cleanup
                                self._turn_state.force_idle("TTS blocked (unified)")
                            else:
                                # Phase 2: microstream gateway - split reply into short segments
                                segs = self._segment_text_for_tts(reply)
                                for idx, seg in enumerate(segs):
                                    try:
                                        if not seg.strip():
                                            continue
                                        # Start playing segment as soon as it is synthesized by the underlying engine
                                        self._voice_session.speak(seg)
                                    except Exception:
                                        pass
                                if utt_id:
                                    self._utt_committed.add(utt_id)
                        except Exception:
                            # TTS failed - force cleanup to prevent leaked SPEAK state
                            self._turn_state.force_idle("TTS error (unified)")
                        # Note: On success, TURN STATE -> IDLE handled by voice session's tts.end event
                        # Record interaction for passive learning
                        try:
                            self._last_user_transcript = txt
                            self._last_ava_response = reply
                            if self.passive_learning_enabled and PASSIVE_LEARNING_AVAILABLE:
                                record_interaction(txt, reply, True)
                        except Exception:
                            pass
                    else:
                        # No reply - return to IDLE
                        self._turn_state.force_idle("no reply")
                else:
                    # Local intent handled - return to IDLE
                    self._turn_state.force_idle("local intent handled")
            except Exception:
                self._turn_state.force_idle("error")
            finally:
                try:
                    loop.close()
                except Exception:
                    pass

        # Create session after subscribing handler
        self._voice_session = _VoiceSession(self._voice_provider)
        self._voice_session.on_user_final(_on_final_user_text)

        # Enable barge-in in unified mode (configurable)
        try:
            aud_cfg = self.cfg.get('audio') or {}
            self._barge_in_enabled = bool(aud_cfg.get('barge_in_enabled', True))
            # Optional cancellation + cooldown defaults
            self._barge_in_cancel_tts = bool(aud_cfg.get('barge_in_cancel_tts', True))
            self._barge_in_cooldown_ms = int(aud_cfg.get('barge_in_cooldown_ms', 400))
        except Exception:
            self._barge_in_enabled = True
            self._barge_in_cancel_tts = True
            self._barge_in_cooldown_ms = 400

        # Attach TTS engine (Piper or Edge) and route chunks to playback queue
        try:
            lf = (self.cfg.get('local_fallback') or {})
            tts_engine = str(lf.get('tts_engine', 'edge')).lower()
            if tts_engine == 'piper':
                p = lf.get('piper') or {}
                exe = p.get('exe') or str((Path(__file__).resolve().parent / 'vendor' / 'piper' / 'piper.exe'))
                model = p.get('model') or str((Path(__file__).resolve().parent / 'voices' / 'piper' / 'en_US-lessac-medium.onnx'))
                tts = _PiperBinTTS(exe_path=exe, model_path=model)
                self._voice_session.set_tts(tts, self._playback_enqueue_sync)
                print(f"[voice-unified] TTS engine: piper (all TTS routes through local, no remote API)")
                # Playback rate will be adjusted on first chunk via tts.current_sample_rate
            else:
                edge_voice = lf.get('edge_voice', 'en-US-MichelleNeural')
                tts = _EdgeStreamTTS(voice=edge_voice, output_format="audio-24khz-16bit-mono-pcm")
                self._voice_session.set_tts(tts, self._playback_enqueue_sync)
                # Ensure playback device matches TTS PCM format for Edge (24kHz)
                assert int(self.playback_rate) == 24000, f"Playback rate mismatch for Edge PCM: {self.playback_rate}"
        except Exception as e:
            print(f"[voice-unified] TTS init unavailable: {e}")

        # Initialize latency profiler
        try:
            self._lat_prof = _LatencyProfiler()
        except Exception:
            self._lat_prof = None

        # Subscribe for barge-in / VAD and asr.final meta capture
        def _bus_handler(ev):
            try:
                if ev.type == 'vad.start':
                    # Mark speaking; mic loop applies debounce to prevent echo loops
                    self.user_speaking.set()
                    self._speech_start_ts = time.time()
                    self._first_partial_ts = 0.0
                elif ev.type == 'vad.end':
                    self.user_speaking.clear()
                    self._speech_start_ts = 0.0
                    self._speech_end_ts = time.time()
                elif ev.type == 'barge_in':
                    # Use same debounce path; do not hard-stop here to avoid oscillation
                    self.user_speaking.set()
                elif ev.type == 'asr.partial':
                    # ECHO GATE: Drop partials during TTS to prevent echo feedback
                    if self.tts_active.is_set():
                        return
                    # ECHO GRACE: Also drop partials shortly after TTS ends
                    if self._tts_ended_at and (time.time() - self._tts_ended_at) < 2.0:
                        return
                    # First partial timing
                    if self._speech_start_ts and not self._first_partial_ts:
                        self._first_partial_ts = time.time()
                        try:
                            self.metrics['last_capture_to_partial_ms'] = int((self._first_partial_ts - self._speech_start_ts) * 1000)
                        except Exception:
                            pass
                elif ev.type == 'asr.final':
                    # Capture meta so callback can enforce utterance commit rules
                    self._last_asr_final_meta = ev.meta or {}
                elif ev.type == 'tts.start':
                    # HALF-DUPLEX: Set runner tts_active flag so echo gate blocks ASR
                    self.tts_active.set()
                    self._tts_synthesis_active = True
                    self._tts_last_active = time.time()
                    print("[half-duplex] MIC MUTED (unified) - TTS starting")
                    # Prepare playback-end detection for blackout authority
                    try:
                        self._awaiting_playback_end = True
                        self._playback_end_fired = False
                    except Exception:
                        pass
                    # Clear audio queue when new TTS starts to prevent overlap
                    try:
                        if hasattr(self, 'audio_queue') and self.audio_queue is not None:
                            drained = 0
                            while not self.audio_queue.empty():
                                try:
                                    self.audio_queue.get_nowait()
                                    drained += 1
                                except Exception:
                                    break
                            if drained > 0:
                                print(f"[echo-gate] Drained {drained} old audio chunks on TTS start")
                    except Exception:
                        pass
                    # Reset sample rate tracking for new TTS
                    try:
                        self._utter_rate_checked = False
                        self._tts_source_rate = None
                    except Exception:
                        pass
                    # Clear ASR buffer when TTS starts to prevent TTS audio from being transcribed
                    try:
                        if hasattr(self, '_voice_provider') and self._voice_provider:
                            asr = getattr(self._voice_provider, 'asr', None)
                            if asr and hasattr(asr, 'clear_buffer'):
                                asr.clear_buffer()
                                print(f"[echo-gate] Cleared ASR buffer on TTS start")
                    except Exception:
                        pass
                elif ev.type == 'tts.end':
                    # TTS synthesis finished; keep mic gated until playback queue drains in the playback worker.
                    self._tts_synthesis_active = False
                    self._tts_ended_at = time.time()
                    print("[half-duplex] TTS synthesis complete (unified) - waiting for playback to finish")
                    # LATENCY: Consolidated per-turn latency line
                    try:
                        _asr_ts = getattr(self, '_asr_final_ts', 0.0)
                        _vad_end = getattr(self, '_speech_end_ts', 0.0)
                        _llm_start = _asr_ts
                        _llm_end = getattr(self, '_awaiting_tts_since', 0.0)
                        _first_chunk = getattr(self, '_tts_first_chunk_ts', 0.0)
                        _tts_end = self._tts_ended_at
                        asr_ms = int((_asr_ts - _vad_end) * 1000) if _asr_ts and _vad_end else 0
                        llm_ms = int((_llm_end - _llm_start) * 1000) if _llm_end and _llm_start else 0
                        tts_synth_ms = int((_first_chunk - _llm_end) * 1000) if _first_chunk and _llm_end else 0
                        playback_ms = int((_tts_end - _first_chunk) * 1000) if _tts_end and _first_chunk else 0
                        total_ms = asr_ms + llm_ms + tts_synth_ms + playback_ms
                        print(f"[latency] asr={asr_ms}ms llm={llm_ms}ms tts_synth={tts_synth_ms}ms playback={playback_ms}ms total={total_ms}ms")
                        try:
                            if getattr(self, '_lat_prof', None):
                                self._lat_prof.record('asr_ms', asr_ms)
                                self._lat_prof.record('llm_ms', llm_ms)
                                self._lat_prof.record('tts_synth_ms', tts_synth_ms)
                                self._lat_prof.record('playback_ms', playback_ms)
                                self._lat_prof.record('total_ms', total_ms)
                                self._lat_prof.maybe_report()
                        except Exception:
                            pass
                    except Exception:
                        pass
                    # Playback worker owns final DECIDE -> IDLE transition after queued audio drains.
                    # Clear ASR buffer to prevent accumulated TTS audio from being transcribed
                    try:
                        if hasattr(self, '_voice_provider') and self._voice_provider:
                            asr = getattr(self._voice_provider, 'asr', None)
                            if asr and hasattr(asr, 'clear_buffer'):
                                asr.clear_buffer()
                                print(f"[echo-gate] Cleared ASR buffer on TTS end")
                    except Exception:
                        pass
                    # Do not drain self.audio_queue here: playback may still have queued speech chunks.
                    # The playback worker raises the final playback-finished transition after the queue empties.
                    try:
                        if getattr(self, '_awaiting_playback_end', False) and hasattr(self, 'audio_queue') and self.audio_queue.empty():
                            self._asr_blackout_until = time.time() + 0.8
                            self._awaiting_playback_end = False
                            self._playback_end_fired = True
                            self.tts_active.clear()
                            print(f"[echo-gate] ASR blackout until {self._asr_blackout_until:.3f}")
                            print("[half-duplex] MIC UNMUTED (unified) - playback finished (empty queue)")
                            try:
                                if hasattr(self, '_turn_state') and self._turn_state:
                                    self._turn_state.force_idle("TTS playback finished (empty queue)")
                            except Exception:
                                pass
                    except Exception:
                        pass
            except Exception:
                pass

        self._voice_bus.subscribe(_bus_handler)

    def run_unified_voice(self):
        """Start unified local voice (Hybrid ASR + server respond + streamed TTS)."""
        self._init_unified_voice()

        # KEEP-ALIVE: unified mode must own the process lifetime
        self.running = True

        # Ensure playback worker for our streamed TTS
        if not (self.playback_thread and self.playback_thread.is_alive()):
            self.playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
            self.playback_thread.start()

        # Start provider/session
        try:
            self._voice_session.start()
        except Exception as e:
            print(f"[voice-unified] Failed to start provider: {e}")
            return

        # Mic capture -> session.push_audio
        deterministic_input_wav = os.getenv('AVA_INPUT_WAV')
        p = None if deterministic_input_wav else pyaudio.PyAudio()
        if deterministic_input_wav:
            mic_stream, sel_idx, actual_mic_rate, chunk_frames = self._open_deterministic_input_stream(deterministic_input_wav, target_rate=16000)
        else:
            mic_stream, sel_idx, actual_mic_rate, chunk_frames = self._open_ranked_input_stream(
                p,
                format=pyaudio.paInt16,
                channels=1,
                target_rate=16000,
                mode_label='input',
            )
        if mic_stream is None:
            tried_dev = self.input_device_index
            print(f"[voice-unified] Mic open failed — device={tried_dev}")
            import sys as _sys
            _sys.exit(2)
        _need_mic_resample = (actual_mic_rate != 16000)
        if _need_mic_resample:
            print(f"[audio] Will resample mic audio: {actual_mic_rate} Hz -> 16000 Hz for ASR")

        def _open_mic_with_fallback():
            return self._open_ranked_input_stream(
                p,
                format=pyaudio.paInt16,
                channels=1,
                target_rate=16000,
                mode_label='input',
            )

        def _mic_loop():
            nonlocal mic_stream, sel_idx, actual_mic_rate, chunk_frames, _need_mic_resample
            print(f"[mic] loop entered frames_per_chunk={chunk_frames} rate={actual_mic_rate} device={sel_idx}")
            fail_count = 0
            last_ok = time.time()
            last_frame_bytes = None
            identical_frame_run = 0
            flatline_rms_run = 0
            # Barge-in gate state
            speaking_frames = 0
            required_frames_when_tts = 8  # ~160ms at 20ms frames
            prev_speaking = False
            gate_pos_frames = 0

            while self.running:
                try:
                    data = mic_stream.read(chunk_frames, exception_on_overflow=False)

                    now = time.time()
                    self._last_mic_frame_ts = now
                    try:
                        mic_rms = self._rms_int16(data)
                    except Exception:
                        mic_rms = 0

                    current_frame_bytes = bytes(data)
                    if last_frame_bytes is not None and current_frame_bytes == last_frame_bytes:
                        identical_frame_run += 1
                    else:
                        identical_frame_run = 0
                    last_frame_bytes = current_frame_bytes

                    if mic_rms <= 1:
                        flatline_rms_run += 1
                    else:
                        flatline_rms_run = 0

                    frame_looks_healthy = bool(identical_frame_run < 8)
                    if frame_looks_healthy:
                        last_ok = now
                        fail_count = 0
                    elif (now - last_ok) > 2.0 and identical_frame_run >= 8:
                        raise RuntimeError(f"mic flatline detected identical_run={identical_frame_run} flatline_rms_run={flatline_rms_run} rms={int(mic_rms)}")

                    # lightweight debug every ~2s
                    if not hasattr(self, "_micdbg_next"):
                        self._micdbg_next = 0.0
                    if now >= self._micdbg_next:
                        self._micdbg_next = now + 2.0
                        try:
                            print(f"[micdbg] rx frames={chunk_frames} rms={int(mic_rms)} thresh={self.START_THRESH} identical_run={identical_frame_run} flatline_rms_run={flatline_rms_run}")
                        except Exception as e:
                            print(f"[micdbg] rms error: {e}")

                    # Half-duplex echo gate: do not feed playback/tail audio into ASR.
                    suppress_asr_for_echo = False
                    try:
                        suppress_asr_for_echo = bool(
                            self.tts_active.is_set()
                            or getattr(self, '_awaiting_playback_end', False)
                            or now < float(getattr(self, '_asr_blackout_until', 0.0) or 0.0)
                        )
                    except Exception:
                        suppress_asr_for_echo = False

                    if suppress_asr_for_echo and not getattr(self, '_barge_in_enabled', False):
                        if not hasattr(self, '_echo_skip_log_next'):
                            self._echo_skip_log_next = 0.0
                        if now >= self._echo_skip_log_next:
                            self._echo_skip_log_next = now + 1.0
                            print("[echo-gate] Suppressing mic->ASR during playback/blackout")
                        continue

                    try:
                        if self._validation_mode:
                            followup_until = float(getattr(self, '_wake_followup_until', 0.0) or 0.0)
                            asr_engine = getattr(getattr(self, '_voice_provider', None), 'asr', None)
                            if asr_engine and getattr(asr_engine, 'capture_enabled', False) and followup_until and now >= followup_until:
                                asr_engine.set_capture_enabled(False)
                                self._wake_followup_until = 0.0
                                print("[wake-followup] Follow-up window expired; ASR capture gate re-armed")
                        asr_data = _resample_audio(data, actual_mic_rate, 16000) if _need_mic_resample else data
                        self._voice_session.push_audio(asr_data)
                    except Exception as e:
                        print(f"[mic] push_audio error: {e}")

                    # Barge-in: detect user speech during TTS and cancel playback
                    try:
                        if getattr(self, '_barge_in_enabled', False) and self.tts_active.is_set():
                            # Compute RMS if not already
                            try:
                                mic_rms
                            except NameError:
                                try:
                                    mic_rms = self._rms_int16(data)
                                except Exception:
                                    mic_rms = 0
                            # Dynamic threshold using playback RMS EMA if available
                            dyn_thresh = int(max(self.START_THRESH, int(getattr(self, '_playback_rms_ema', 0) * 2.0)))
                            if mic_rms >= dyn_thresh:
                                gate_pos_frames += 1
                                if gate_pos_frames >= 2:
                                    speaking_frames += 1
                                    if speaking_frames >= required_frames_when_tts:
                                        print(f"[barge] user speech detected -> cancel TTS (rms={int(mic_rms)} thr={dyn_thresh})")
                                        self._cancel_tts_playback()
                                        speaking_frames = 0
                                        gate_pos_frames = 0
                            else:
                                # decay
                                speaking_frames = 0
                                gate_pos_frames = 0
                    except Exception:
                        pass

                except Exception as e:
                    fail_count += 1
                    if fail_count <= 5 or (fail_count % 50 == 0):
                        print(f"[mic] read failed (count={fail_count}): {e}")

                    # If we've had no good frames for >2s, try reopening
                    if (time.time() - last_ok) > 2.0:
                        print("[mic] no frames for >2s -> attempting mic reopen")
                        try:
                            try:
                                mic_stream.stop_stream()
                                mic_stream.close()
                            except Exception:
                                pass

                            mic_stream, sel_idx, actual_mic_rate, chunk_frames = _open_mic_with_fallback()
                            if mic_stream is None:
                                print("[mic] reopen failed: no suitable input device")
                                time.sleep(0.2)
                                continue

                            _need_mic_resample = (actual_mic_rate != 16000)
                            last_frame_bytes = None
                            identical_frame_run = 0
                            flatline_rms_run = 0
                            if _need_mic_resample:
                                print(f"[audio] Will resample mic audio: {actual_mic_rate} Hz -> 16000 Hz for ASR")
                            print(f"[mic] reopen success: device={sel_idx} rate={actual_mic_rate} frames={chunk_frames}")
                            last_ok = time.time()
                            fail_count = 0
                        except Exception as e2:
                            print(f"[mic] reopen exception: {e2}")
                            time.sleep(0.2)
                    else:
                        time.sleep(0.02)

        # Start microphone capture loop
        try:
            mic_thread = threading.Thread(target=_mic_loop, name="unified_mic", daemon=True)
            mic_thread.start()
            print("[voice-unified] Mic loop started")
        except Exception as e:
            print(f"[voice-unified] Failed to start mic loop: {e}")
            return

        # Block process lifetime here until shutdown
        # Heartbeat and lifetime block
        try:
            _hb_last = 0.0
            while self.running:
                time.sleep(0.2)
                try:
                    now = time.time()
                    if now - _hb_last >= 2.0:
                        _hb_last = now
                        state = None
                        try:
                            state = self._turn_state.state
                        except Exception:
                            state = "?"
                        try:
                            qsz = self.audio_queue.qsize()
                        except Exception:
                            qsz = -1
                        try:
                            lm = getattr(self, '_last_mic_frame_ts', 0.0) or 0.0
                        except Exception:
                            lm = 0.0
                        print(f"[hb] unified state={state} tts={self.tts_active.is_set()} q={qsz} last_mic={lm:.3f}")
                except Exception:
                    pass
        finally:
            self.running = False
            try:
                while self.running:
                    try:
                        data = mic_stream.read(chunk_frames, exception_on_overflow=False)
                        if _need_mic_resample:
                            data = _resample_audio(data, actual_mic_rate, 16000)
                    except Exception:
                        time.sleep(0.01)
                        continue
                    # Compute mic RMS for adaptive debounce
                    try:
                        mic_rms = self._rms_int16(data)
                    except Exception:
                        mic_rms = 0.0

                    # ECHO CANCELLATION: Suppress mic input while TTS is active or in playback-end blackout
                    try:
                        if self._echo_suppression_enabled:
                            # Check if TTS is currently active
                            if self.tts_active.is_set():
                                # Mic is likely picking up TTS output - skip this frame entirely
                                continue

                            # Check authoritative playback-end blackout window
                            blackout_until = float(getattr(self, '_asr_blackout_until', 0.0) or 0.0)
                            if time.time() < blackout_until:
                                # Within blackout window - skip ALL frames to prevent tail residue
                                continue
                    except Exception:
                        pass

                    # --- DEBUG: prove mic frames exist and RMS changes ---
                    if not hasattr(self, "_dbg_mic_frames"):
                        self._dbg_mic_frames = 0
                        self._dbg_mic_last = time.time()
                        self._dbg_max_rms = 0.0
                    self._dbg_mic_frames += 1
                    self._dbg_max_rms = max(self._dbg_max_rms, mic_rms)
                    now_dbg = time.time()
                    if now_dbg - self._dbg_mic_last >= 1.0:
                        # Show raw RMS (compare to START_THRESH=1600)
                        print(f"[micdbg] frames={self._dbg_mic_frames} bytes={len(data)} rms={int(mic_rms)} max={int(self._dbg_max_rms)} thresh={self.START_THRESH}")
                        self._dbg_mic_frames = 0
                        self._dbg_max_rms = 0.0
                        self._dbg_mic_last = now_dbg
                    # --- END DEBUG ---

                    # Optional RMS debug output to verify mic capture
                    try:
                        if bool(self.cfg.get('debug_rms', False)):
                            if int(time.time()*2) % 10 == 0:
                                print(f"[mic] rms={int(mic_rms)}")
                    except Exception:
                        pass
                    # Feed ASR
                    try:
                        self._voice_session.push_audio(data)
                        # DEBUG disabled for stability
                        # if hasattr(self, '_voice_provider') and hasattr(self._voice_provider, 'asr'):
                        #     asr = self._voice_provider.asr
                        #     if hasattr(asr, 'vosk_recognizer') and asr.vosk_recognizer:
                        #         part = asr.vosk_recognizer.PartialResult()
                        #         if part and '"partial"' in part and len(part) > 20:
                        #             print(f"[voskdbg] {part[:100]}")
                    except Exception as e:
                        print(f"[micdbg] push_audio error: {e}")
                    # Barge-in: if user is speaking while TTS active, cancel TTS
                    try:
                        asr = getattr(self._voice_provider, 'asr', None)
                        is_spk = bool(asr and hasattr(asr, 'is_speaking') and asr.is_speaking())
                        if is_spk:
                            self.user_speaking.set()
                            # Adaptive threshold while TTS is active to avoid echo loops
                            if self.tts_active.is_set():
                                dyn_thresh = max(self.START_THRESH, int(self._playback_rms_ema * 2.0))
                                if mic_rms < dyn_thresh:
                                    # below threshold, do not count as speech during TTS
                                    speaking_frames = 0
                                    gate_pos_frames = 0
                                    prev_speaking = True
                                    continue
                                # require two consecutive positive frames past threshold
                                gate_pos_frames += 1
                                if gate_pos_frames < 2:
                                    continue
                                speaking_frames += 1
                                if speaking_frames >= required_frames_when_tts:
                                    # Record barge stop latency since speaking detected
                                    start_ts = self._user_speaking_started_ts or time.time()
                                    self._user_speaking_started_ts = time.time()
                                    self._cancel_tts_playback()
                                    try:
                                        self.metrics['last_barge_stop_ms'] = int((time.time() - start_ts) * 1000)
                                    except Exception:
                                        pass
                                    speaking_frames = 0
                                    gate_pos_frames = 0
                            # Track speech start timestamp for metrics
                            if not prev_speaking:
                                self._speech_start_ts = time.time()
                                prev_speaking = True
                        else:
                            self.user_speaking.clear()
                            speaking_frames = 0
                            gate_pos_frames = 0
                            if prev_speaking:
                                self._speech_end_ts = time.time()
                                prev_speaking = False
                    except Exception:
                        pass
            finally:
                try:
                    mic_stream.stop_stream(); mic_stream.close()
                    if p is not None:
                        p.terminate()
                except Exception:
                    pass

        threading.Thread(target=_mic_loop, name="unified_mic", daemon=True).start()

        # HUD loop for realtime metrics (every ~2s)
        def _hud_loop():
            last = 0
            while self.running:
                try:
                    time.sleep(2.0)
                    m = self.metrics
                    line = (
                        f"[rt] cap->partial={m.get('last_capture_to_partial_ms',0)}ms  "
                        f"vadEnd->ASR={m.get('last_vad_end_to_asr_final_ms',0)}ms  "
                        f"vadEnd->audio={m.get('last_vad_end_to_first_audio_ms',0)}ms  "
                        f"ASR->audio={m.get('asr_final_to_first_audio_ms',0)}ms  "
                        f"bargeStop={m.get('last_barge_stop_ms',0)}ms  "
                        f"q={m.get('playback_queue_frames',0)}/{getattr(self, '_audio_queue_maxsize', 50)}"
                    )
                    print("\r" + line, end="", flush=True)
                except Exception:
                    pass
            # newline when stopping
            try:
                print()
            except Exception:
                pass

        threading.Thread(target=_hud_loop, name="voice_hud", daemon=True).start()

        # Idle loop while running
        print("[voice-unified] Unified voice session active (Hybrid ASR)")
        # Speak degraded-mode notice once if needed
        try:
            if getattr(self, '_announce_degraded', False):
                self._announce_degraded = False
                time.sleep(0.2)
                try:
                    print("[voice-unified] Brain server isn't reachable. Running voice only. (no TTS — no active turn)")
                except Exception:
                    pass
        except Exception:
            pass
        while self.running:
            time.sleep(0.2)

    def _has_cloud_voice(self) -> bool:
        # Import deepgram lazily only for cloud mode availability check
        try:
            import importlib
            importlib.import_module('deepgram')
        except Exception:
            return False
        if not self.deepgram_key:
            return False
        if not any([self.gemini_key, self.claude_key, self.openai_key, self.groq_key]):
            return False
        return True

    def _has_unified_voice(self) -> bool:
        if not _VOICE_SCAFFOLD_AVAILABLE:
            return False
        asr_ok = HYBRID_ASR_AVAILABLE
        # TTS: Piper available or edge-tts
        tts_ok = False
        try:
            lf = (self.cfg.get('local_fallback') or {})
            if (lf.get('tts_engine', 'edge').lower() == 'piper'):
                p = lf.get('piper') or {}
                exe = p.get('exe') or str((Path(__file__).resolve().parent / 'vendor' / 'piper' / 'piper.exe'))
                model = p.get('model') or str((Path(__file__).resolve().parent / 'voices' / 'piper' / 'en_US-lessac-medium.onnx'))
                tts_ok = os.path.exists(exe) and os.path.exists(model)
            else:
                tts_ok = EDGE_TTS_AVAILABLE
        except Exception:
            tts_ok = False
        return bool(asr_ok and tts_ok)

    def _select_voice_mode(self) -> str:
        # Read desired mode: auto (default), unified, cloud; VOICE_UNIFIED legacy support
        mode = str((self.cfg.get('voice') or {}).get('mode', 'auto')).lower()
        cloud_ok = self._has_cloud_voice()
        unified_ok = self._has_unified_voice()
        if mode == 'cloud':
            if cloud_ok:
                return 'cloud'
            print('[voice] Cloud forced but unavailable, falling back to unified')
            return 'unified' if unified_ok else 'cloud'
        if mode == 'unified' or VOICE_UNIFIED:
            if unified_ok:
                return 'unified'
            print('[voice] Unified forced but unavailable, falling back to cloud')
            return 'cloud' if cloud_ok else 'unified'
        # auto
        return 'cloud' if cloud_ok else 'unified'

    def _playback_enqueue_sync(self, pcm_bytes: bytes):
        """Enqueue PCM at ~20ms frames and cap buffer to ~400ms.
        Assumes 24kHz, 16-bit mono (960 bytes per 20ms frame).
        Resamples audio if TTS produces a different sample rate (e.g., Piper at 22050 Hz).
        """
        # If TTS reports a different sample rate (Piper), resample instead of reopening stream
        try:
            if getattr(self, '_utter_rate_checked', False) is False:
                sr = None
                try:
                    sr = int(getattr(self._voice_session.tts, 'current_sample_rate', 0) or 0)
                except Exception:
                    sr = None
                if sr and sr != int(self.playback_rate):
                    # Store source rate for resampling, don't change playback_rate
                    self._tts_source_rate = sr
                    print(f"[audio] TTS source rate {sr} Hz, will resample to {int(self.playback_rate)} Hz")
                else:
                    self._tts_source_rate = None
                self._utter_rate_checked = True
        except Exception:
            pass

        # Resample audio if needed (Piper outputs 22050 Hz, we play at 24000 Hz)
        src_rate = getattr(self, '_tts_source_rate', None)
        if src_rate and src_rate != int(self.playback_rate):
            pcm_bytes = _resample_audio(pcm_bytes, src_rate, int(self.playback_rate))

        try:
            frame_ms = int(os.environ.get("AVA_PLAYBACK_FRAME_MS", "100") or "100")
        except Exception:
            frame_ms = 100
        frame_ms = max(20, min(frame_ms, 200))
        FRAME_BYTES = max(2, int(int(self.playback_rate) * (frame_ms / 1000.0)) * 2)
        MAX_FRAMES = 500  # ~10 seconds for Piper (synthesizes entire file first)
        try:
            # Slice into ~20ms frames for snappy playback
            i = 0
            n = len(pcm_bytes)
            while i < n:
                chunk = pcm_bytes[i:i+FRAME_BYTES]
                i += FRAME_BYTES
                if not chunk:
                    break
                # Block if queue is full (don't drop frames for Piper)
                try:
                    self.audio_queue.put(chunk, block=True, timeout=5.0)
                except queue.Full:
                    # Only drop if truly stuck
                    pass
                try:
                    self.metrics['playback_queue_frames'] = self.audio_queue.qsize()
                except Exception:
                    pass
                # First-chunk latency measurement
                if self._awaiting_tts_since and not self._tts_first_chunk_ts:
                    self._tts_first_chunk_ts = time.time()
                    try:
                        self.metrics['last_eos_to_first_audio_ms'] = int((self._tts_first_chunk_ts - self._awaiting_tts_since) * 1000)
                        if self._speech_end_ts:
                            self.metrics['last_vad_end_to_first_audio_ms'] = int((self._tts_first_chunk_ts - self._speech_end_ts) * 1000)
                        if getattr(self, '_asr_final_ts', 0.0):
                            self.metrics['asr_final_to_first_audio_ms'] = int((self._tts_first_chunk_ts - self._asr_final_ts) * 1000)
                    except Exception:
                        pass
        except Exception as e:
            try:
                print(f"Audio queue error: {e}")
            except Exception:
                pass

    def _dbg(self, tag: str, msg: str, data: dict | None = None):
        try:
            if not (self.debug_agent or self.debug_tools):
                return
            ts = time.strftime('%H:%M:%S')
            s = f"[DBG {tag} {ts}] {msg}"
            if data:
                try:
                    import json as _json
                    snippet = _json.dumps(data, ensure_ascii=False)
                    if len(snippet) > 300:
                        snippet = snippet[:300] + '…'
                    s += f" | {snippet}"
                except Exception:
                    pass
            print(s)
            try:
                with open(self._debug_log_path, 'a', encoding='utf-8') as lf:
                    lf.write(s + "\n")
            except Exception:
                pass
        except Exception:
            pass

    def get_tool_definitions(self):
        """Get tool definitions for function calling during voice chat - CORRECTED ACTIONS"""
        # TEMPORARY: Test with NO tools
        # return []
        from corrected_tool_definitions import CORRECTED_TOOLS
        return CORRECTED_TOOLS

    def _desktop_path(self) -> str:
        try:
            return str((Path.home() / 'Desktop').resolve())
        except Exception:
            return str(Path.home())

    def _check_confirmation(self, command: str) -> bool:
        """Check if a destructive command has been confirmed by user.
        Returns True if confirmed or no confirmation needed.
        """
        # If there's a pending confirmation, check if this is the response
        if self._pending_confirmation and time.time() < self._pending_confirmation_until:
            response = command.lower().strip()
            if response in ['yes', 'yeah', 'sure', 'confirm', 'go ahead', 'do it']:
                # User confirmed
                self._pending_confirmation = None
                self._pending_confirmation_until = 0
                return True
            elif response in ['no', 'nope', 'cancel', 'don\'t', 'dont', 'stop']:
                # User cancelled
                self._pending_confirmation = None
                self._pending_confirmation_until = 0
                return False
            else:
                # Still waiting for yes/no
                return False
        
        # No pending confirmation, allow the command
        return True

    def _request_confirmation(self, command: str) -> str:
        """Request confirmation for a destructive command.
        Returns the confirmation prompt message.
        """
        self._pending_confirmation = command
        self._pending_confirmation_until = time.time() + 30  # 30 second timeout
        
        # Generate contextual confirmation message
        action_words = ['delete', 'remove', 'send', 'restart', 'shutdown', 'format', 'kill']
        action = 'do this'
        for word in action_words:
            if word in command.lower():
                action = word
                break
        
        return f"You want me to {action}. Should I proceed? Say 'yes' to confirm or 'no' to cancel."

    def _try_tool_dispatch(self, text: str) -> str | None:
        """Lightweight intent → tool router using corrected tools via cmpuse Agent.
        Returns a user-facing reply if a tool was executed, else None.
        """
        t = (text or '').strip()
        low = t.lower()
        # POLICY GATE: Tools require explicit command verb (+ wake word in validation mode)
        if not self._should_allow_tools(t):
            print(f"[tool-gate] Blocked — no command verb (or missing wake word): '{t[:40]}'")
            return None
        # Voice control for on-screen automation
        try:
            if 'pause automation' in low or (low.startswith('pause') and 'automation' in low):
                _ = asyncio.run(self.handle_tool_call('computer_use_control', { 'action': 'pause' }))
                return "Pausing automation. Say 'resume automation' to continue."
            if 'resume automation' in low or 'continue automation' in low:
                _ = asyncio.run(self.handle_tool_call('computer_use_control', { 'action': 'resume' }))
                return "Resuming automation."
            if 'stop automation' in low or 'abort automation' in low:
                _ = asyncio.run(self.handle_tool_call('computer_use_control', { 'action': 'stop' }))
                return "Stopping automation."
        except Exception:
            pass
        try:
            # Create/make a file intent
            if ('create' in low or 'make' in low) and 'file' in low:
                name = None
                content = None
                m_name = re.search(r"named\s+([\w\-. ]+?)(?:\s+(?:that|with|containing)|$)", t, re.IGNORECASE)
                if m_name:
                    name = m_name.group(1).strip()
                m_content = re.search(r"(?:that|with|containing)\s+(?:says|say|text(?:\s+of)?|content)\s+(.+)$", t, re.IGNORECASE)
                if m_content:
                    content = m_content.group(1).strip()
                if not content:
                    # Fallback: use the whole request as content
                    content = t
                if not name:
                    name = f"ava_note_{int(time.time())}.txt"
                # Default to Desktop
                full_path = str(Path(self._desktop_path()) / name)
                res = asyncio.run(self.handle_tool_call('fs_ops', {
                    'operation': 'write',
                    'path': full_path,
                    'content': content
                }))
                if isinstance(res, dict) and res.get('status') == 'ok':
                    return f"I created the file {full_path}."
                return f"I tried to create {full_path} but something went wrong."

            # Remember that ... → memory store
            if low.startswith('remember that '):
                value = t[len('remember that '):].strip()
                if value:
                    res = asyncio.run(self.handle_tool_call('memory_system', {
                        'action': 'store',
                        'key': f'note_{int(time.time())}',
                        'value': value
                    }))
                    return "Got it. I stored that in memory." if isinstance(res, dict) else "Stored."

            # Send email to ... subject ... body ... (very basic)
            if ('email' in low or 'send an email' in low) and ' to ' in low:
                to = None; subject = None; body = None
                m_to = re.search(r"to\s+([\w\-.+@]+)", t, re.IGNORECASE)
                if m_to: to = m_to.group(1)
                m_sub = re.search(r"subject\s*[:\-]\s*(.+?)(?:\s+body\s*[:\-]|$)", t, re.IGNORECASE)
                if m_sub: subject = m_sub.group(1).strip()
                m_body = re.search(r"body\s*[:\-]\s*(.+)$", t, re.IGNORECASE)
                if m_body: body = m_body.group(1).strip()
                if to and (subject or body):
                    res = asyncio.run(self.handle_tool_call('comm_ops', {
                        'action': 'send_email', 'to': to, 'subject': subject or '', 'body': body or ''
                    }))
                    return "Email sent." if isinstance(res, dict) else "Sent."

            # Open/navigate browser
            if ('open' in low or 'navigate' in low or 'go to' in low) and ('http://' in low or 'https://' in low or ' www.' in low or 'browser' in low):
                m_url = re.search(r"(https?://\S+|www\.[^\s]+)", t, re.IGNORECASE)
                url = m_url.group(1) if m_url else None
                if url and url.startswith('www.'): url = 'https://' + url
                res = asyncio.run(self.handle_tool_call('browser_automation', {
                    'action': 'launch'
                }))
                if url:
                    _ = asyncio.run(self.handle_tool_call('browser_automation', {
                        'action': 'navigate', 'url': url
                    }))
                return f"Opening the browser{(' to ' + url) if url else ''}."

            # Turn on/off lights/devices
            if ('turn on' in low or 'turn off' in low) and ('light' in low or 'lights' in low or 'device' in low):
                action = 'turn_on' if 'turn on' in low else 'turn_off'
                # crude room extraction
                m_room = re.search(r"in the ([a-zA-Z0-9 _-]+)", t, re.IGNORECASE)
                room = m_room.group(1).strip() if m_room else None
                res = asyncio.run(self.handle_tool_call('iot_ops', {
                    'action': action,
                    'room': room or ''
                }))
                return f"Okay, {action.replace('_',' ')} the lights{(' in ' + room) if room else ''}."

            # System info
            if 'system info' in low or 'computer info' in low or 'device info' in low:
                res = asyncio.run(self.handle_tool_call('sys_ops', { 'action': 'get_info' }))
                return "Here is the system information." if isinstance(res, dict) else "Done."

            # HTTP get
            if low.startswith('fetch ') or low.startswith('get ') or 'http' in low:
                m = re.search(r"(https?://\S+)", t)
                if m:
                    url = m.group(1)
                    res = asyncio.run(self.handle_tool_call('net_ops', { 'url': url }))
                    return f"Fetched {url}." if isinstance(res, dict) else "Fetched."

            # Calendar create event (very basic)
            if ('calendar' in low or 'event' in low) and ('create' in low or 'add' in low):
                m_sum = re.search(r"(?:event|calendar)\s*(?:called|named|for)?\s*([\w \-]{3,100})", t, re.IGNORECASE)
                summary = m_sum.group(1).strip() if m_sum else 'New Event'
                res = asyncio.run(self.handle_tool_call('calendar_ops', { 'action': 'create_event', 'summary': summary }))
                return "Event created." if isinstance(res, dict) else "Done."

            # Window list/focus
            if 'list windows' in low or 'what windows' in low:
                res = asyncio.run(self.handle_tool_call('window_ops', { 'action': 'list' }))
                return "Listing windows." if isinstance(res, dict) else "Done."
            if 'focus' in low and ('window' in low or 'app' in low):
                m_app = re.search(r"focus\s+(.*)$", t, re.IGNORECASE)
                app = (m_app.group(1).strip() if m_app else '')
                res = asyncio.run(self.handle_tool_call('window_ops', { 'action': 'focus', 'app': app }))
                return f"Focusing {app}." if app else "Focusing the window."

            # Camera capture
            if 'camera' in low and ('capture' in low or 'take a picture' in low or 'take a photo' in low or 'what do you see' in low):
                save_path = str(Path(self._desktop_path()) / f"ava_capture_{int(time.time())}.png")
                res = asyncio.run(self.handle_tool_call('camera_ops', { 'action': 'capture', 'save_path': save_path }))
                return f"Captured an image to {save_path}." if isinstance(res, dict) else "Captured."

            # NEW: Mouse control commands
            if 'mouse' in low or 'click' in low or 'move' in low:
                # Extract coordinates
                coords = re.search(r'(\d+)[,\s]+(\d+)', t)
                if coords:
                    x, y = int(coords.group(1)), int(coords.group(2))
                    if 'click' in low:
                        res = asyncio.run(self.handle_tool_call('computer_use', { 
                            'action': 'click', 'x': x, 'y': y 
                        }))
                        return f"Clicked at {x}, {y}." if isinstance(res, dict) else "Clicked."
                    else:
                        res = asyncio.run(self.handle_tool_call('computer_use', { 
                            'action': 'move', 'x': x, 'y': y 
                        }))
                        return f"Moved mouse to {x}, {y}." if isinstance(res, dict) else "Moved."
                elif 'click' in low:
                    # Click at current position
                    res = asyncio.run(self.handle_tool_call('computer_use', { 'action': 'click' }))
                    return "Clicked." if isinstance(res, dict) else "Click failed."

            # NEW: Keyboard/type commands
            if 'type' in low and ('type' in low[:10] or 'write' in low):
                # Extract text to type
                type_match = re.search(r'(?:type|write)\s+[\'"]?(.+?)[\'"]?$', t, re.IGNORECASE)
                if type_match:
                    text_to_type = type_match.group(1)
                    res = asyncio.run(self.handle_tool_call('computer_use', { 
                        'action': 'type', 'text': text_to_type 
                    }))
                    return f"Typed '{text_to_type}'." if isinstance(res, dict) else "Typed."

            # NEW: Screenshot commands
            if 'screenshot' in low or 'screen shot' in low or 'capture screen' in low:
                save_path = str(Path(self._desktop_path()) / f"ava_screenshot_{int(time.time())}.png")
                res = asyncio.run(self.handle_tool_call('vision_ops', { 
                    'action': 'analyze_screen', 'save_path': save_path 
                }))
                return f"Captured screenshot to {save_path}." if isinstance(res, dict) else "Screenshot captured."

            # NEW: Security scan commands
            if 'scan' in low and ('port' in low or 'network' in low):
                res = asyncio.run(self.handle_tool_call('security_ops', { 'action': 'status' }))
                return "Security scan initiated." if isinstance(res, dict) else "Scan started."

            # NEW: Read emails
            if 'read' in low and 'email' in low:
                res = asyncio.run(self.handle_tool_call('comm_ops', { 'action': 'read_emails', 'max_results': 5 }))
                return "Reading your emails." if isinstance(res, dict) else "Email check initiated."

            # Generic fallback: detect tool names and actions from corrected tools
            try:
                tools = self.get_tool_definitions()
                for td in tools:
                    name = str(td.get('name','')).strip()
                    if not name:
                        continue
                    # If the user explicitly mentions the tool name or a dotted alias, try it
                    if name in low or low.replace(' ', '_').find(name) >= 0:
                        params = td.get('parameters') or {}
                        props = (params.get('properties') or {})
                        args = {}
                        # Try to infer 'action' from enum by substring match
                        act = None
                        if isinstance(props.get('action',{}).get('enum',[]), list):
                            for a in props['action']['enum']:
                                if isinstance(a, str) and a in low:
                                    act = a; break
                        if act:
                            args['action'] = act
                        # Common parameter heuristics
                        # path/url/text/query/room/entity_id/brightness/temperature
                        m = re.search(r"(https?://\S+)", t)
                        if m and 'url' in props:
                            args['url'] = m.group(1)
                        m = re.search(r"(?:file|path)\s*[:\-]?\s*(\S+)", t, re.IGNORECASE)
                        if m and 'path' in props:
                            args['path'] = m.group(1)
                        m = re.search(r"(?:text|content)\s*[:\-]?\s*(.+)$", t, re.IGNORECASE)
                        if m and 'content' in props:
                            args['content'] = m.group(1)
                        m = re.search(r"room\s*[:\-]?\s*([\w\s-]+)", t, re.IGNORECASE)
                        if m and 'room' in props:
                            args['room'] = m.group(1).strip()
                        m = re.search(r"brightness\s*[:\-]?\s*(\d+)", t, re.IGNORECASE)
                        if m and 'brightness' in props:
                            args['brightness'] = int(m.group(1))
                        m = re.search(r"temperature\s*[:\-]?\s*(\d+(?:\.\d+)?)", t, re.IGNORECASE)
                        if m and 'temperature' in props:
                            args['temperature'] = float(m.group(1))
                        # Run tool if we have at least an action or common args
                        if args or 'action' in props:
                            res = asyncio.run(self.handle_tool_call(name, args))
                            if isinstance(res, dict):
                                msg = res.get('message') or res.get('status') or 'Done.'
                                return msg
            except Exception:
                pass
        except Exception:
            pass
        return None

    def _extract_tool_call(self, content: str):
        """Try to extract a tool call JSON from assistant text. Returns (name, args) or (None,None)."""
        try:
            if not content:
                return (None, None)
            s = content.strip()
            # Try fenced JSON
            m = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", s, re.IGNORECASE)
            if m:
                s = m.group(1)
            # If still not a pure JSON object, try to locate a {"tool":{...}} object substring
            if not (s.startswith('{') and s.endswith('}')):
                m2 = re.search(r"(\{\s*\"tool\"\s*:\s*\{[\s\S]*?\}\s*\})", s)
                if m2:
                    s = m2.group(1)
            # Parse JSON object (best effort)
            j = json.loads(s)
            if isinstance(j, dict):
                if 'tool' in j and isinstance(j['tool'], dict):
                    name = j['tool'].get('name')
                    args = j['tool'].get('arguments') or {}
                    if isinstance(name, str):
                        # Normalize tool name via synonyms
                        name = self._normalize_tool_name(name)
                        return (name, args if isinstance(args, dict) else {})
                # Alternate keys
                name = j.get('tool_name') or j.get('name')
                args = j.get('tool_args') or j.get('arguments') or {}
                if isinstance(name, str):
                    name = self._normalize_tool_name(name)
                    return (name, args if isinstance(args, dict) else {})
        except Exception:
            pass
        return (None, None)

    def _normalize_tool_name(self, name: str) -> str:
        n = (name or '').strip().lower()
        synonyms = {
            'file_write':'fs_ops','file_ops':'fs_ops','filegen':'fs_ops','file_gen':'fs_ops','filesystem':'fs_ops',
            'email':'comm_ops','gmail':'comm_ops','sms':'comm_ops','communications':'comm_ops','comm':'comm_ops',
            'http':'net_ops','fetch':'net_ops','network':'net_ops','net':'net_ops',
            'system':'sys_ops','sysinfo':'sys_ops','system_info':'sys_ops',
            'browser':'browser_automation','web_automation':'browser_automation','web':'browser_automation',
            'lights':'iot_ops','home':'iot_ops','mqtt':'iot_ops','iot':'iot_ops',
            'camera':'camera_ops','vision':'vision_ops','ocr':'vision_ops','screen':'screen_ops',
            'calendar':'calendar_ops','schedule':'calendar_ops',
            'windows':'window_ops','window':'window_ops',
            'mouse':'mouse_ops','keyboard':'key_ops','keys':'key_ops',
            'learning':'learning_db','memory':'memory_system','analysis':'analysis_ops','security':'security_ops',
            'remote':'remote_ops'
        }
        return synonyms.get(n, n)

    async def handle_tool_call(self, function_name, arguments):
        """Execute AVA tool calls through the Node boundary layer.

        ARCHITECTURE: Python components NEVER execute tools directly.
        All tool execution flows through the Node /tools/:name/execute endpoint
        which handles:
        - Idempotency (prevents duplicate commands within TTL)
        - Security validation
        - Logging with full audit trail
        - Rate limiting

        This method sends intent + metadata to Node; it does NOT execute tools.
        """
        # POLICY GATE: Tools require explicit command verb (+ wake word in validation mode)
        last_txt = getattr(self, '_last_user_transcript', '') or ''
        if not self._should_allow_tools(last_txt):
            print(f"[tool-gate] BLOCKED tool '{function_name}' — transcript lacks command verb or wake word: '{last_txt[:40]}'")
            return {
                "status": "blocked",
                "message": f"Tool '{function_name}' requires explicit command phrase",
                "tool": function_name
            }
        # VALIDATION MODE: Block certain tools entirely
        if self._validation_mode:
            if function_name in self._blocked_tools:
                print(f"[validation-mode] BLOCKED tool '{function_name}' - not allowed in validation mode")
                return {
                    "status": "blocked",
                    "message": f"Tool '{function_name}' is blocked in validation mode",
                    "tool": function_name
                }
            # If require_wake_for_tools, check last transcript had wake word
            if self._require_wake_for_tools:
                last_txt_lower = self._normalize_for_wake(last_txt)
                has_wake = any(last_txt_lower.startswith(w) or f" {w}" in last_txt_lower for w in self._wake_words)
                if not has_wake:
                    print(f"[validation-mode] Tool '{function_name}' requires wake word - skipping")
                    return {
                        "status": "blocked",
                        "message": f"Tool '{function_name}' requires wake word in validation mode",
                        "tool": function_name
                    }

        print(f"\n[tool-boundary] Tool intent: {function_name}({arguments})")

        # Record attempt for accuracy monitoring
        if self.accuracy_monitor_enabled and self.accuracy_monitor:
            try:
                self.accuracy_monitor.record_transcription(
                    f"Tool: {function_name}",
                    context=json.dumps(arguments)
                )
            except Exception:
                pass

        try:
            # Add default provider for email
            if function_name == "comm_ops" and arguments.get("action") == "send_email":
                arguments.setdefault("provider", "gmail")

            # BOUNDARY ENFORCEMENT: Route through Node server
            if not getattr(self, 'server_client', None):
                return {
                    "status": "error",
                    "message": "Node boundary not available - server_client is None",
                    "tool": function_name
                }

            # Execute tool through Node boundary (single execution point)
            result = self.server_client.execute_tool(
                tool_name=function_name,
                args=arguments,
                confirmed=True,
                source='voice_standalone'
            )

            # Handle boundary response
            if result is None:
                return {
                    "status": "error",
                    "message": "No response from Node boundary",
                    "tool": function_name
                }

            # Check for idempotency block
            if result.get('reason') == 'idempotency_blocked':
                return {
                    "status": "blocked",
                    "message": result.get('error', 'Command already executed recently'),
                    "hint": "Say 'do it again' to retry"
                }

            # Process successful execution
            if result.get('ok'):
                # Record success in session
                if self.session_manager_enabled and self.voice_session:
                    self.voice_session.context.last_tool_used = function_name

                # Extract result data
                inner_result = result.get('result', result)
                status = inner_result.get('status', 'ok') if isinstance(inner_result, dict) else 'ok'

                return {
                    "status": status,
                    "message": inner_result.get('message', 'Operation completed') if isinstance(inner_result, dict) else str(inner_result),
                    "data": {k: v for k, v in inner_result.items() if k not in ['status', 'message']} if isinstance(inner_result, dict) else {}
                }

            # Handle errors from boundary
            error_msg = result.get('error', 'Unknown error from boundary')

            # Self-healing attempt for recoverable errors
            if self._should_attempt_heal(function_name, error_msg):
                heal_result = await self._attempt_self_heal(function_name, arguments, error_msg)
                if heal_result:
                    return heal_result

            return {
                "status": "error",
                "message": error_msg,
                "reason": result.get('reason', 'unknown'),
                "tool": function_name
            }

        except Exception as e:
            error_str = str(e)
            # Self-healing on exception
            if self._should_attempt_heal(function_name, error_str):
                heal_result = await self._attempt_self_heal(function_name, arguments, error_str)
                if heal_result:
                    return heal_result

            return {
                "status": "error",
                "message": f"Tool boundary error: {error_str}",
                "tool": function_name
            }

    def _should_attempt_heal(self, function_name: str, error_msg: str) -> bool:
        """Determine if we should attempt self-healing for this error"""
        # Don't heal certain errors
        non_healable = ['not found', 'permission denied', 'does not exist', 'unauthorized']
        if any(x in error_msg.lower() for x in non_healable):
            return False
        
        # Heal connection/API errors
        healable = ['connection', 'timeout', 'quota', 'rate limit', 'temporarily', 
                    'unavailable', 'failed to', 'error executing']
        return any(x in error_msg.lower() for x in healable)

    async def _attempt_self_heal(self, function_name: str, arguments: dict, error_msg: str) -> dict:
        """Attempt to self-heal a tool failure through the Node boundary.

        ARCHITECTURE: Even self-healing retries go through the Node boundary.
        We use bypass_idempotency=True since these are intentional retries.
        """
        try:
            print(f"[self-heal] Attempting to heal {function_name} failure: {error_msg[:100]}")

            if not getattr(self, 'server_client', None):
                print("[self-heal] Node boundary not available")
                return None

            # Strategy 1: Retry with modified arguments for common issues
            if 'camera' in function_name.lower() and 'index' in error_msg.lower():
                # Try camera index 1 if 0 failed
                new_args = {**arguments, 'camera_index': 1}
                print(f"[self-heal] Retrying camera with index 1 via Node boundary")
                result = self.server_client.execute_tool(
                    tool_name=function_name,
                    args=new_args,
                    confirmed=True,
                    bypass_idempotency=True,  # Intentional retry
                    source='voice_self_heal'
                )
                if result and result.get('ok'):
                    inner = result.get('result', {})
                    return {"status": "ok", "message": "Camera operation succeeded after retry", "data": inner}

            # Strategy 2: Retry with simplified args
            if len(arguments) > 2:
                minimal_args = {'action': arguments.get('action', 'list')}
                if 'path' in arguments:
                    minimal_args['path'] = arguments['path']
                print(f"[self-heal] Retrying with minimal args via Node boundary: {minimal_args}")
                result = self.server_client.execute_tool(
                    tool_name=function_name,
                    args=minimal_args,
                    confirmed=True,
                    bypass_idempotency=True,  # Intentional retry
                    source='voice_self_heal'
                )
                if result and result.get('ok'):
                    inner = result.get('result', {})
                    return {"status": "ok", "message": "Operation succeeded with simplified parameters", "data": inner}

            # Strategy 3: Check if tool exists via self-diagnosis (read-only, no tool execution)
            if SELF_MOD_AVAILABLE and hasattr(self, 'self_mod_enabled') and self.self_mod_enabled:
                try:
                    from ava_self_modification import diagnose_error
                    diag = diagnose_error(function_name, error_msg)
                    if diag.get('can_fix'):
                        print(f"[self-heal] Self-modification suggests: {diag.get('suggestion')}")
                except Exception:
                    pass

            return None  # Healing failed
        except Exception as e:
            print(f"[self-heal] Healing attempt failed: {e}")
            return None

    # ---------------------- Deepgram + Helpers ----------------------
    def _read_key_file(self, filename: str) -> str:
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except FileNotFoundError:
            return ''

    def _get_available_think_providers(self):
        """Returns list of available think providers in priority order.

        Priority: Gemini → Claude → Groq → OpenAI
        Returns list of tuples: (provider_name, provider_class, model_name)
        """
        # Import Deepgram socket provider classes lazily
        try:
            from deepgram.extensions.types.sockets import (
                AgentV1GoogleThinkProvider,
                AgentV1AnthropicThinkProvider,
                AgentV1GroqThinkProvider,
                AgentV1OpenAiThinkProvider,
            )
        except Exception:
            return []

        providers = []

        # Use Gemini first - matches avas_voice.py which works perfectly
        if self.gemini_key:
            providers.append(("Gemini", AgentV1GoogleThinkProvider, "gemini-2.5-flash"))

        if self.claude_key:
            # Deepgram supports Claude via Anthropic provider (has issues with cutoffs)
            providers.append(("Claude", AgentV1AnthropicThinkProvider, "claude-sonnet-4-20250514"))

        if self.groq_key:
            # Groq typically runs Llama models
            providers.append(("Groq", AgentV1GroqThinkProvider, "llama-3.3-70b-versatile"))

        if self.openai_key:
            providers.append(("OpenAI", AgentV1OpenAiThinkProvider, "gpt-4o"))

        return providers

    def _rms_int16(self, frame: bytes) -> float:
        if not frame:
            return 0.0
        n = len(frame) // 2
        if n <= 0:
            return 0.0
        import struct, math
        samples = struct.unpack('<' + 'h' * n, frame)
        acc = 0.0
        for s in samples:
            acc += s * s
        return math.sqrt(acc / n)

    def _calibrate_noise_floor(self, duration_ms: int = 700, margin_rms: int = 200, scale: float = 2.5):
        """
        Best-effort ambient noise RMS calibration.
        MUST NOT block unified startup. If mic open fails, log and return with no changes.
        """
        stream = None
        p = None

        try:
            # Optional kill-switch for instant rollback
            if str(os.getenv("AVA_AUDIO_SAFE_MODE", "0")).strip() == "1":
                print("[vad-cal] AVA_AUDIO_SAFE_MODE=1 -> skipping calibration")
                return

            p = pyaudio.PyAudio()
            aud_cfg = self.cfg.get('audio') or {}

            # Prefer configured device, else whatever PyAudio thinks is default.
            target_idx = self.input_device_index if self.input_device_index is not None else aud_cfg.get('input_device')
            try:
                target_idx = int(target_idx) if target_idx is not None else None
            except Exception:
                target_idx = None

            # Use a rate ladder. 16k often fails on Windows devices; 48k/44.1k usually work.
            # Try configured rate too, but don't assume it's valid.
            cfg_rate = aud_cfg.get('input_sample_rate')
            try:
                cfg_rate = int(cfg_rate) if cfg_rate else None
            except Exception:
                cfg_rate = None

            rate_candidates = []
            for r in (cfg_rate, 48000, 44100, 16000):
                if isinstance(r, int) and r > 0 and r not in rate_candidates:
                    rate_candidates.append(r)

            # Device ladder: configured -> None (default) -> explicit default index (if available) -> 0
            dev_candidates = []
            if target_idx is not None:
                dev_candidates.append(target_idx)
            dev_candidates.append(None)

            try:
                di = p.get_default_input_device_info()
                default_idx = int(di.get("index")) if di and "index" in di else None
                if default_idx is not None and default_idx not in dev_candidates:
                    dev_candidates.append(default_idx)
            except Exception:
                pass

            if 0 not in dev_candidates:
                dev_candidates.append(0)

            # Buffer ladder
            # Keep your "20ms" intent, but if rate is high we still want reasonable fpb.
            def fpb_for_rate(r: int) -> int:
                return max(int(r * 0.02), 160)

            last_err = None
            opened = False

            for dev in dev_candidates:
                for rate in rate_candidates:
                    for fpb in (fpb_for_rate(rate), 960, 1024, 640, 320):
                        try:
                            kw = dict(
                                format=pyaudio.paInt16,
                                channels=1,
                                rate=rate,
                                input=True,
                                frames_per_buffer=fpb,
                            )
                            if dev is not None:
                                kw["input_device_index"] = dev

                            stream = p.open(**kw)
                            opened = True
                            if dev is None:
                                dev_label = "default(None)"
                            else:
                                dev_label = str(dev)
                            print(f"[vad-cal] Opened for calibration: dev={dev_label} rate={rate} fpb={fpb}")
                            break
                        except Exception as e:
                            last_err = e
                            stream = None
                    if opened:
                        break
                if opened:
                    break

            if not opened or stream is None:
                print(f"[vad-cal] Skipping calibration (mic open failed): {last_err}")
                return

            # Warm-up a couple frames (non-fatal)
            for _ in range(3):
                try:
                    _ = stream.read(stream._frames_per_buffer, exception_on_overflow=False)
                except Exception:
                    pass

            # Measure RMS
            rate = stream._rate if hasattr(stream, "_rate") else rate_candidates[0]
            fpb = stream._frames_per_buffer if hasattr(stream, "_frames_per_buffer") else fpb_for_rate(rate)

            total_frames = max(int((duration_ms / 1000.0) * rate / fpb), 3)
            acc = 0.0
            n = 0

            for _ in range(total_frames):
                try:
                    data = stream.read(fpb, exception_on_overflow=False)
                except Exception:
                    continue
                rms = self._rms_int16(data)
                acc += rms
                n += 1

            if n <= 0:
                print("[vad-cal] Skipping calibration (no readable frames)")
                return

            noise_floor = acc / n
            # Phase C: dynamic threshold = max(120, noise_floor * scale)
            # Use config-provided scale; ignore margin to avoid over-inflating the floor
            new_start = int(max(120, noise_floor * float(scale)))
            new_stop = int(max(80, new_start * 0.6))

            if new_start != self.START_THRESH or new_stop != self.STOP_THRESH:
                print(f"[vad-cal] noise_floor_rms={int(noise_floor)} -> START={new_start} STOP={new_stop} "
                      f"(old START={self.START_THRESH} STOP={self.STOP_THRESH})")
                self.START_THRESH = new_start
                self.STOP_THRESH = new_stop

        except Exception as e:
            # Absolute guarantee: never crash or stall boot because of calibration.
            print(f"[vad-cal] Skipping calibration (error): {e}")
            return

        finally:
            try:
                if stream:
                    stream.stop_stream()
                    stream.close()
            except Exception:
                pass
            try:
                if p:
                    p.terminate()
            except Exception:
                pass

    def _cancel_tts(self):
        try:
            while not self.audio_queue.empty():
                _ = self.audio_queue.get_nowait()
        except Exception:
            pass

    def _load_config(self, silent: bool = False):
        try:
            if self.config_path.exists():
                st = self.config_path.stat()
                if st.st_mtime != self._cfg_mtime:
                    with open(self.config_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    if isinstance(data, dict):
                        self.cfg.update(data)
                        vad = self.cfg.get('vad') or {}
                        # In validation mode, ignore file-driven VAD thresholds to avoid re-raising too high
                        _apply_vad_from_cfg = True
                        try:
                            if getattr(self, '_validation_mode', False) and \
                               (('start_rms' in vad) or ('stop_rms' in vad)):
                                _apply_vad_from_cfg = False
                        except Exception:
                            _apply_vad_from_cfg = True
                        if _apply_vad_from_cfg:
                            self.START_THRESH = int(vad.get('start_rms', self.START_THRESH))
                            self.STOP_THRESH = int(vad.get('stop_rms', self.STOP_THRESH))
                        else:
                            print(f"[vad-cal] Validation mode: ignoring config VAD (start_rms/stop_rms); keeping START={self.START_THRESH} STOP={self.STOP_THRESH}")
                        self.SPEECH_HOLD_SEC = float(vad.get('hold_sec', self.SPEECH_HOLD_SEC))
                        # Audio updates
                        aud = self.cfg.get('audio') or {}
                        cal_cfg = aud.get('calibration') or {}
                        if bool(cal_cfg.get('prefer_saved_pair', True)):
                            saved = self._load_voice_calibration_state() or {}
                            saved_out_rate = saved.get('output_rate')
                            saved_in_rate = saved.get('input_rate')
                            if saved_out_rate:
                                aud['playback_rate'] = saved_out_rate
                                print(f"[audio] Preferring calibrated output rate: {saved_out_rate}")
                            if saved_in_rate:
                                aud['input_sample_rate'] = saved_in_rate
                                print(f"[audio] Preferring calibrated input rate: {saved_in_rate}")
                            if saved.get('output_device_name') and not aud.get('output_device_name'):
                                aud['output_device_name'] = saved.get('output_device_name')
                            if saved.get('input_device_name'):
                                if not aud.get('input_device_name'):
                                    aud['input_device_name'] = saved.get('input_device_name')
                                print(f"[audio] Preferring calibrated input device: {saved.get('input_device_name')}")
                        env_input_name = os.getenv('AVA_INPUT_DEVICE_NAME')
                        env_input_idx = os.getenv('AVA_INPUT_DEVICE_INDEX')
                        env_input_rate = os.getenv('AVA_INPUT_SAMPLE_RATE')
                        env_output_name = os.getenv('AVA_OUTPUT_DEVICE_NAME')
                        env_output_idx = os.getenv('AVA_OUTPUT_DEVICE_INDEX')
                        env_output_rate = os.getenv('AVA_OUTPUT_SAMPLE_RATE')
                        self._forced_input_device_name = str(env_input_name).strip() if env_input_name else None
                        self._forced_input_device_index = None
                        self._forced_input_sample_rate = None
                        self._forced_output_device_name = str(env_output_name).strip() if env_output_name else None
                        self._forced_output_device_index = None
                        self._forced_output_sample_rate = None
                        if env_input_name:
                            aud['input_device_name'] = env_input_name
                            if not env_input_idx:
                                aud['input_device'] = None
                            print(f"[audio-env] Overriding input device name from AVA_INPUT_DEVICE_NAME={env_input_name}")
                        if env_input_idx:
                            try:
                                self._forced_input_device_index = int(env_input_idx)
                                aud['input_device'] = self._forced_input_device_index
                                print(f"[audio-env] Overriding input device index from AVA_INPUT_DEVICE_INDEX={aud['input_device']}")
                            except Exception:
                                print(f"[audio-env] Ignoring invalid AVA_INPUT_DEVICE_INDEX={env_input_idx!r}")
                        if env_input_rate:
                            try:
                                self._forced_input_sample_rate = int(env_input_rate)
                                aud['input_sample_rate'] = self._forced_input_sample_rate
                                print(f"[audio-env] Overriding input sample rate from AVA_INPUT_SAMPLE_RATE={aud['input_sample_rate']}")
                            except Exception:
                                print(f"[audio-env] Ignoring invalid AVA_INPUT_SAMPLE_RATE={env_input_rate!r}")
                        if env_output_name:
                            aud['output_device_name'] = env_output_name
                            if not env_output_idx:
                                aud['output_device'] = None
                            print(f"[audio-env] Overriding output device name from AVA_OUTPUT_DEVICE_NAME={env_output_name}")
                        if env_output_idx:
                            try:
                                self._forced_output_device_index = int(env_output_idx)
                                aud['output_device'] = self._forced_output_device_index
                                print(f"[audio-env] Overriding output device index from AVA_OUTPUT_DEVICE_INDEX={aud['output_device']}")
                            except Exception:
                                print(f"[audio-env] Ignoring invalid AVA_OUTPUT_DEVICE_INDEX={env_output_idx!r}")
                        if env_output_rate:
                            try:
                                self._forced_output_sample_rate = int(env_output_rate)
                                aud['playback_rate'] = self._forced_output_sample_rate
                                print(f"[audio-env] Overriding output sample rate from AVA_OUTPUT_SAMPLE_RATE={aud['playback_rate']}")
                            except Exception:
                                print(f"[audio-env] Ignoring invalid AVA_OUTPUT_SAMPLE_RATE={env_output_rate!r}")

                        try:
                            pr = int(aud.get('playback_rate', self.playback_rate) or self.playback_rate)
                        except Exception:
                            pr = self.playback_rate
                        if pr != self.playback_rate:
                            self.playback_rate = pr
                            setattr(self, '_reopen_playback', True)
                        resolved_out = self._resolve_audio_device_index('output', aud.get('output_device'), aud.get('output_device_name'))
                        if resolved_out is not None and resolved_out != self.output_device_index:
                            self.output_device_index = resolved_out
                            setattr(self, '_reopen_playback', True)
                        resolved_in = self._resolve_audio_device_index('input', aud.get('input_device'), aud.get('input_device_name'))
                        if resolved_in is not None and resolved_in != self.input_device_index:
                            self.input_device_index = resolved_in
                            setattr(self, '_reopen_mic', True)
                        # Deepgram key update
                        dgk = self.cfg.get('deepgram_api_key')
                        if dgk and dgk != self.deepgram_key:
                            self.deepgram_key = dgk
                            try:
                                if self.asr_ws:
                                    self.asr_ws.close()
                            except Exception:
                                pass
                        # Debug flags
                        self.debug_agent = bool(self.cfg.get('debug_agent', False))
                        self.debug_tools = bool(self.cfg.get('debug_tools', False))
                        if self.debug_agent or self.debug_tools:
                            print(f"[cfg] Debug enabled: agent={self.debug_agent} tools={self.debug_tools}")

                        # D005 Barge-in: HARD DISABLED for turn-state stability
                        # Config value is ignored — barge-in stays off until proven stable
                        barge_cfg = self.cfg.get('barge_in', {})
                        self._barge_in_enabled = False
                        self._barge_in_min_speech_ms = int(barge_cfg.get('min_speech_ms', 500))
                        self._barge_in_require_final = bool(barge_cfg.get('require_final_to_interrupt', True))
                        self._barge_in_cancel_tts = bool(barge_cfg.get('cancel_tts_on_interrupt', True))
                        self._barge_in_cooldown_ms = int(barge_cfg.get('cooldown_after_interrupt_ms', 1000))

                        if not silent:
                            print(f"[cfg] Reloaded {self.config_path}")
                    self._cfg_mtime = st.st_mtime
        except Exception as e:
            if not silent:
                print(f"[cfg] Reload failed: {e}")

    def _write_runner_state(self):
        """Write current state to file for crash supervisor to read."""
        try:
            state = {
                "timestamp": datetime.now().isoformat(),
                "turn_state": self._turn_state.state if hasattr(self, '_turn_state') else "UNKNOWN",
                "safe_mode": getattr(self, '_safe_mode', False),
                "barge_in_enabled": getattr(self, '_barge_in_enabled', False),
                "running": getattr(self, 'running', False),
                "audio_backend": {
                    "playback_rate": getattr(self, 'playback_rate', 22050),
                    "input_device": getattr(self, 'input_device_index', None),
                    "output_device": getattr(self, 'output_device_index', None),
                },
            }
            with open(self._state_file_path, 'w') as f:
                json.dump(state, f, indent=2, default=str)
        except Exception:
            pass  # Non-critical

    def _ensure_playback_thread(self):
        try:
            if not (self.playback_thread and self.playback_thread.is_alive()):
                self.playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
                self.playback_thread.start()
                print("🔊 Audio playback thread started\n")
        except Exception:
            pass

    def _deepgram_functions_from_corrected_tools(self):
        """Convert OpenAI-style CORRECTED_TOOLS into Deepgram function schema.
        Expected CORRECTED_TOOLS item shape: {"type":"function","function":{name,description,parameters}}
        """
        funcs = []
        try:
            for t in CORRECTED_TOOLS:
                if not isinstance(t, dict):
                    continue
                fn = t.get("function") if "function" in t else None
                if not fn:
                    # fallback if already flat
                    fn = t
                name = (fn or {}).get("name")
                if not name:
                    continue
                funcs.append({
                    "name": name,
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
                })
        except Exception:
            pass
        return funcs

    def _config_watcher(self):
        while True:
            try:
                self._load_config(silent=True)
            except Exception:
                pass
            # Also hot-reload identity if it changes
            try:
                if self.identity_path.exists():
                    st = self.identity_path.stat()
                    if st.st_mtime != self._identity_mtime:
                        self.identity = self._load_identity()
                        self._identity_mtime = st.st_mtime
                        print(f"[identity] Reloaded {self.identity_path}")
            except Exception:
                pass
            # Write state file for crash supervisor (every 2s)
            try:
                self._write_runner_state()
            except Exception:
                pass
            time.sleep(2.0)

    def _prepare_tts_text(self, text: str) -> str:
        # Preserve time expressions before stripping punctuation so "3:51 PM" doesn't become "351 PM".
        t = str(text or "")

        def _expand_clock_time(match):
            try:
                hour = int(match.group(1))
                minute = int(match.group(2))
                suffix = (match.group(3) or "").strip().upper()
                if minute == 0:
                    spoken = f"{hour} o'clock"
                elif minute < 10:
                    spoken = f"{hour} oh {minute}"
                else:
                    spoken = f"{hour} {minute}"
                if suffix:
                    spoken = f"{spoken} {suffix}"
                return spoken
            except Exception:
                return match.group(0)

        t = re.sub(r"\b(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\b", _expand_clock_time, t)
        if not self.cfg.get('speak_symbols', False):
            t = t.replace('_', ' ').replace('-', ' ')
            t = re.sub(r"[^\w\s]", "", t, flags=re.UNICODE)
            t = re.sub(r"\s+", " ", t).strip()
            return t
        return t

    async def queue_audio_output(self, pcm_bytes: bytes):
        try:
            max_sz = getattr(self, '_audio_queue_maxsize', 50)
            overflow_threshold = int(max_sz * 0.8)  # 80% full = overflow
            qsz = self.audio_queue.qsize()
            if qsz >= overflow_threshold:
                # Drop oldest chunks to make room and prevent stale audio buildup
                dropped = 0
                while self.audio_queue.qsize() > overflow_threshold // 2:
                    try:
                        _ = self.audio_queue.get_nowait()
                        dropped += 1
                    except queue.Empty:
                        break
                if dropped > 0:
                    print(f"[audio-queue] Overflow protection: dropped {dropped} stale chunks (was q={qsz}/{max_sz})")
            self.audio_queue.put_nowait(pcm_bytes)
        except queue.Full:
            # Queue is at maxsize — drop oldest to make room
            try:
                _ = self.audio_queue.get_nowait()
                self.audio_queue.put_nowait(pcm_bytes)
                print(f"[audio-queue] Queue full, dropped oldest chunk to make room")
            except (queue.Empty, queue.Full):
                pass
        except Exception as e:
            print(f"Audio queue error: {e}")

    async def _ask_server_respond(self, text: str) -> str:
        headers = { 'Content-Type': 'application/json' }
        tools_allowed = self._should_allow_tools(text)
        if not tools_allowed:
            print(f"[tool-gate] Server run_tools=False — no command verb in: '{text[:40]}'")

        configured_route = str(self.cfg.get('server_route', 'respond')).lower()
        configured_url = str(self.cfg.get('server_url', 'http://127.0.0.1:5051/respond'))
        if configured_route != 'respond' or configured_url.rstrip('/').endswith('/chat'):
            print(f"[route] Live voice forcing /respond (configured server_route={configured_route}, server_url={configured_url})")

        spoken_reply_budget = {
            "max_sentences": 2,
            "max_words": 28,
            "prefer_brief": True
        }

        pctx = ""
        if PERSONALITY_AVAILABLE:
            try:
                pctx = get_personality_context()
            except Exception:
                pctx = ""

        payload = {
            "sessionId": "voice-default",
            "messages": [ { "role": "user", "content": text } ],
            "freshSession": True,
            "run_tools": tools_allowed,
            "allow_write": tools_allowed,
            "voice_mode": "spoken",
            "spoken_reply_budget": spoken_reply_budget,
            "persona": "AVA",
            "style": "first_person",
            "context": self._build_context(pctx)
        }
        if self._validation_mode:
            payload["memory_filter"] = "facts_only"

        url = self._voice_server_endpoint('respond')
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url=url, data=body, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                j = json.loads(raw.decode('utf-8', errors='ignore'))
                response_text = (j.get('output_text') or j.get('text') or (j.get('content') or [{}])[0].get('text') or '').strip()
                if self._is_step_status_message(response_text):
                    print(f"[filter] Blocked step status from /respond: {response_text[:60]}...")
                    return ''
                _sha1 = hashlib.sha1(response_text.encode()).hexdigest()[:12]
                print(f"[respond-out] sha1={_sha1} len={len(response_text)} preview='{response_text[:60]}...'")
                return response_text
        except urllib.error.HTTPError as he:
            print(f"[route] Server HTTP error on /respond: {he}")
            return ''
        except Exception as e:
            print(f"[route] Server error: {e}")
            return ''

    def _is_step_status_message(self, text: str) -> bool:
        """Detect if response is an internal agent-loop status message instead of natural language.

        These messages must NEVER reach TTS. They are internal scaffolding from the
        agent loop (step counters, tool traces, waiting states, idempotency messages).
        """
        if not text:
            return False

        # Strip common punctuation for pattern matching
        text_clean = text.strip().rstrip('.!?').strip()
        text_lower = text_clean.lower()

        # Exact match blacklists - phrases that should NEVER be spoken
        exact_blacklist = {
            'done', 'ready', 'ok', 'okay', 'success', 'complete', 'completed',
            'finished', 'executing', 'running', 'working', 'processing',
            'acknowledged', 'noted', 'confirmed', 'roger', 'copy',
            'on it', 'will do', 'got it', 'understood',
        }

        # Check exact matches (case insensitive)
        if text_lower in exact_blacklist:
            return True

        # Check for very short responses (likely status codes)
        if len(text_clean) <= 3:
            return True

        # Substring blacklist - if ANY of these appear anywhere in the response, block it
        blocked_substrings = [
            'partially completed',
            'waiting for user input',
            'waiting_user',
            'idempotency',
            'tool execution',
            'agent loop',
            'agent_loop',
            'max steps reached',
            'max_steps_reached',
            'step limit',
            'execution trace',
            'tool trace',
            'internal tool',
            'tool call result',
            'function_call',
            'tool_code',
        ]
        for sub in blocked_substrings:
            if sub in text_lower:
                return True

        # Pattern-based detection
        step_patterns = [
            r'Reached step \d+ of \d+',
            r'currently running without any further actions',
            r'Executing step \d+',
            r'Plan step \d+',
            r'Completed \d+ of \d+ steps',
            r'No further actions? to execute',
            r'Step \d+ complete',
            r'Task (complete|completed|finished|done)',
            r'Operation (complete|completed|finished|done)',
            r'Action (complete|completed|finished|done)',
            r'I will execute',
            r'I am (executing|running|processing)',
            r'Tool (executed|called|invoked)',
            r'Function (executed|called|invoked)',
            r'API (call|response)',
            r'Step \d+ of \d+:',
            r'\d+\) Step \d+',
            r'(working on|processing) step \d+',
            r'step \d+ (done|finished|complete)',
            r'(awaiting|waiting for) next step',
            r'Automation (complete|completed|finished)',
            r'Plan (complete|completed|finished)',
            r'\d+ steps (complete|completed|finished)',
            r'step \d+ in progress',
            r'has been partially completed',
            r'partially completed',
            r'waiting for user',
            r'waiting for input',
        ]

        # Check for repetitive word patterns (e.g., "step step step" or "done done")
        words = text_clean.split()
        if len(words) >= 2:
            # Check for immediate repetition of same word
            for i in range(len(words) - 1):
                if words[i].lower() == words[i+1].lower() and len(words[i]) > 2:
                    return True

        for pattern in step_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return True

        return False

    def _build_context(self, personality_context: str = "") -> dict:
        """Build comprehensive context for server including memory, session, and awareness"""
        context = {
            "identity": self.identity,
            "uptime": self._uptime_hms(),
            "platform": platform.system(),
            "personality": personality_context,
            "server": {
                "llm": (self.server_caps or {}).get('llmProvider') if isinstance(self.server_caps, dict) else None,
                "write": (self.server_caps or {}).get('write') if isinstance(self.server_caps, dict) else None,
                "bridge": (self.server_caps or {}).get('bridge') if isinstance(self.server_caps, dict) else None
            }
        }
        
        # Add session history if available
        if self.session_manager_enabled and self.voice_session:
            try:
                recent_history = self.voice_session.get_recent_context(n=5)
                if recent_history:
                    context["conversation_history"] = recent_history
                    context["pending_tasks"] = len([t for t in self.voice_session.context.pending_tasks if t.get("status") == "pending"])
            except Exception:
                pass
        
        # Add self-awareness context
        if SELF_AWARENESS_AVAILABLE:
            try:
                awareness_ctx = get_prompt_context()
                if awareness_ctx:
                    context["self_awareness"] = awareness_ctx
            except Exception:
                pass
        
        # Add passive learning context
        if PASSIVE_LEARNING_AVAILABLE:
            try:
                passive_ctx = get_passive_context()
                if passive_ctx:
                    context["environment"] = passive_ctx
            except Exception:
                pass
        
        # Add corrections/past mistakes guidance
        if SELF_AWARENESS_AVAILABLE:
            try:
                corrections = check_past_mistakes(self._last_user_transcript)
                if corrections:
                    context["corrections_guidance"] = corrections
            except Exception:
                pass
        
        return context

    # ---------------------- Server supervision (when not using hot runner) ----------------------
    def _server_up(self, url: str, timeout: float = 2.0) -> bool:
        try:
            base = url.rsplit('/', 1)[0] if url.endswith('/respond') or url.endswith('/chat') else url
            # Prefer /health endpoint if available
            health = base.rstrip('/') + '/health'
            req = urllib.request.Request(health, method='GET')
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                code = getattr(resp, 'status', None) or getattr(resp, 'code', None) or 200
                return 200 <= code < 500
        except Exception:
            # Fallback to /self/capabilities (known-good endpoint that returns 200)
            try:
                base = url.rsplit('/', 1)[0] if url.endswith('/respond') or url.endswith('/chat') else url
                caps_url = base.rstrip('/') + '/self/capabilities'
                req = urllib.request.Request(caps_url, method='GET')
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    code = getattr(resp, 'status', None) or getattr(resp, 'code', None) or 200
                    return 200 <= code < 500
            except Exception:
                return False

    def _server_base(self) -> str:
        url = self.cfg.get('server_url', "http://127.0.0.1:5051/respond")
        return url.rsplit('/', 1)[0] if url.endswith('/respond') or url.endswith('/chat') else url

    def _voice_server_endpoint(self, route: str = 'respond') -> str:
        route = str(route or 'respond').lower()
        if route not in {'respond', 'chat'}:
            route = 'respond'
        url = str(self.cfg.get('server_url', "http://127.0.0.1:5051/respond")).rstrip('/')
        if url.endswith('/respond') or url.endswith('/chat'):
            return url.rsplit('/', 1)[0] + f'/{route}'
        return url + f'/{route}'

    def _write_latency_log_entry(self, entry: dict) -> None:
        path = os.getenv('AVA_LATENCY_LOG')
        if not path:
            return
        try:
            payload = dict(entry or {})
            payload.setdefault('ts', time.time())
            with open(path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(payload) + "\n")
        except Exception:
            pass

    def _voice_calibration_state_path(self) -> Path:
        aud = self.cfg.get('audio') or {}
        cal = aud.get('calibration') or {}
        state_path = cal.get('state_path') or 'logs/voice_calibration.json'
        path = Path(state_path)
        if not path.is_absolute():
            path = Path(__file__).parent / path
        return path

    def _load_voice_calibration_state(self):
        path = self._voice_calibration_state_path()
        try:
            if path.exists():
                return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            pass
        return {}

    def _save_voice_calibration_state(self, state: dict) -> None:
        path = self._voice_calibration_state_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state or {}, indent=2), encoding='utf-8')
            print(f"[audio] Saved calibrated voice pair: {path}")
        except Exception as e:
            print(f"[audio] Failed to save calibrated voice pair: {e}")

    def _resolve_audio_device_index(self, kind: str, configured_idx=None, configured_name=None):
        pa = getattr(self, 'audio', None) or pyaudio.PyAudio()
        is_input = str(kind).lower().startswith('input')
        channel_key = 'maxInputChannels' if is_input else 'maxOutputChannels'
        if configured_idx is not None:
            try:
                idx = int(configured_idx)
                info = pa.get_device_info_by_index(idx)
                if int(info.get(channel_key, 0)) > 0:
                    return idx
                print(f"[audio] Ignoring configured {kind} device index {idx}: {channel_key}=0")
            except Exception:
                try:
                    return int(configured_idx)
                except Exception:
                    pass
        target_name = str(configured_name or '').strip().lower()
        if not target_name:
            return None
        try:
            for idx in range(pa.get_device_count()):
                info = pa.get_device_info_by_index(idx)
                if int(info.get(channel_key, 0)) <= 0:
                    continue
                label = str(info.get('name') or '')
                if label.lower() == target_name or target_name in label.lower():
                    return idx
        except Exception:
            pass
        return None

    def _preferred_input_device_terms(self):
        aud_cfg = self.cfg.get('audio') or {}
        return [str(x).lower() for x in (aud_cfg.get('input_device_preferences') or []) if str(x).strip()]

    def _avoided_input_device_terms(self):
        aud_cfg = self.cfg.get('audio') or {}
        return [str(x).lower() for x in (aud_cfg.get('input_device_avoid') or []) if str(x).strip()]

    def _score_input_candidate(self, candidate: dict, target_idx=None) -> float:
        idx = candidate.get('idx')
        label = str(candidate.get('label') or '')
        label_l = label.lower()
        idle_rms = float(candidate.get('idle_rms', 0.0))
        target_bonus = -120.0 if target_idx is not None and idx == target_idx else 0.0
        penalty = 0.0
        if idle_rms == 0.0:
            penalty += 240.0
        elif idle_rms < 20.0:
            penalty += 120.0
        elif 'sound mapper' in label_l:
            penalty += 600.0
        preference_bonus = 0.0
        for term in self._preferred_input_device_terms():
            if term and term in label_l:
                preference_bonus += 60.0
        for term in self._avoided_input_device_terms():
            if term and term in label_l:
                penalty += 400.0
        if 'webcam' in label_l:
            penalty += 800.0
        return idle_rms + penalty - preference_bonus + target_bonus

    def _should_run_loopback_probe(self, mode_label='input') -> bool:
        probe_cfg = ((self.cfg.get('audio') or {}).get('loopback_probe') or {})
        env_probe = os.getenv('AVA_LOOPBACK_PROBE')
        if env_probe is not None:
            return str(env_probe).strip().lower() in {'1', 'true', 'yes', 'on'}
        if not bool(probe_cfg.get('enabled', False)):
            return False
        if bool(probe_cfg.get('validation_only', False)) and not getattr(self, '_validation_mode', False):
            return False
        return True

    def _normalize_probe_text(self, text: str) -> str:
        return _normalized_transcript(text)

    def _synthesize_loopback_probe_speech(self, probe_text: str = 'Hey Eva say hello there.'):
        return probe_text.encode('utf-8', errors='ignore')

    def _transcribe_loopback_probe_capture(self, wav_path: str) -> str:
        return ''

    def _score_loopback_probe_transcript(self, transcript: str, expected_text: str) -> float:
        actual = set(self._normalize_probe_text(transcript).split())
        expected = set(self._normalize_probe_text(expected_text).split())
        if not expected:
            return 0.0
        return len(actual & expected) / float(len(expected))

    def _probe_input_loopback_candidate(self, candidate: dict, mode_label='input', probe_expected_text='Hey Eva say hello there.'):
        transcript = str(candidate.get('probe_transcript') or '')
        text_score = self._score_loopback_probe_transcript(transcript, probe_expected_text)
        candidate['probe_transcript'] = transcript
        candidate['probe_text_score'] = text_score
        candidate['probe_detected'] = bool(candidate.get('probe_detected'))
        candidate['probe_calibrated'] = bool(text_score >= float((((self.cfg.get('audio') or {}).get('loopback_probe') or {}).get('speech_calibration_min', 0.6)) or 0.6))
        print(f"[audio] {mode_label} loopback probe: {candidate.get('label')} transcript='{transcript}' score={text_score:.2f} calibrated={int(bool(candidate['probe_calibrated']))}")
        return candidate

    def _apply_input_loopback_probe(self, accepted_candidates, hot_candidates, mode_label='input'):
        probe_cfg = ((self.cfg.get('audio') or {}).get('loopback_probe') or {})
        if not self._should_run_loopback_probe(mode_label=mode_label):
            return accepted_candidates, hot_candidates
        probe_mode = str(probe_cfg.get('mode', 'speech') or 'speech').lower()
        require_probe_calibration = bool(probe_cfg.get('require_speech_calibration', False))
        fail_closed_without_calibration = bool(probe_cfg.get('fail_closed_without_calibration', False))
        seen_devices = set()
        for group in (accepted_candidates, hot_candidates):
            for candidate in group:
                dev_key = (candidate.get('idx'), str(candidate.get('label') or '').lower())
                if dev_key in seen_devices:
                    continue
                seen_devices.add(dev_key)
                self._probe_input_loopback_candidate(candidate, mode_label=mode_label)
        if any(bool(candidate.get('probe_detected')) for candidate in accepted_candidates):
            pass
        if any(bool(candidate.get('probe_detected')) for candidate in hot_candidates):
            pass
        for candidate in accepted_candidates:
            probe_text_score = float(candidate.get('probe_text_score', 0.0))
            candidate['probe_text_score'] = probe_text_score
        if require_probe_calibration and probe_mode == 'speech':
            calibrated = [c for c in accepted_candidates if bool(c.get('probe_calibrated'))]
            if calibrated:
                return calibrated, hot_candidates
            print(f"[audio] Calibration failed: no {mode_label} candidate reproduced probe speech above threshold")
            enforce_calibration_block = bool(
                require_probe_calibration and probe_mode == 'speech' and fail_closed_without_calibration
            )
            if enforce_calibration_block:
                return [], []
            print(f"[audio] Continuing with best available {mode_label} fallback after calibration miss")
        return accepted_candidates, hot_candidates

    def _candidate_sort_key(self, candidate: dict):
        return (
            0 if bool(candidate.get('target_config_rate_match')) else 1,
            float(candidate.get('score', 0.0)),
            -float(candidate.get('probe_text_score', 0.0)),
            int(candidate.get('idx', 0)),
        )

    def _probe_input_stream_health(self, stream, chunk_frames: int, sample_reads: int = 8) -> dict:
        rms_values = []
        chunks = []
        try:
            sample_reads = max(2, int(sample_reads))
        except Exception:
            sample_reads = 8
        for _ in range(sample_reads):
            data = stream.read(chunk_frames, exception_on_overflow=False)
            chunks.append(data)
            try:
                rms_values.append(float(self._rms_int16(data)))
            except Exception:
                rms_values.append(0.0)
        mean_rms = sum(rms_values) / float(len(rms_values) or 1)
        rms_min = min(rms_values) if rms_values else 0.0
        rms_max = max(rms_values) if rms_values else 0.0
        rms_span = rms_max - rms_min
        all_identical = len({bytes(chunk) for chunk in chunks}) <= 1
        return {
            'idle_rms': mean_rms,
            'rms_min': rms_min,
            'rms_max': rms_max,
            'rms_span': rms_span,
            'all_identical': all_identical,
            'flatline': bool(all_identical),
        }

    def _open_ranked_input_stream(self, pa_instance, format, channels, target_rate, mode_label='input'):
        aud_cfg = self.cfg.get('audio') or {}
        config_sr = int(aud_cfg.get('input_sample_rate', target_rate) or target_rate)
        forced_idx = getattr(self, '_forced_input_device_index', None)
        forced_name = str(getattr(self, '_forced_input_device_name', '') or '').strip()
        forced_rate = getattr(self, '_forced_input_sample_rate', None)
        try:
            forced_rate = int(forced_rate) if forced_rate is not None else None
        except Exception:
            forced_rate = None
        if forced_rate is not None and (forced_idx is not None or forced_name):
            rates = [forced_rate]
        else:
            rates = list(dict.fromkeys([r for r in (forced_rate, config_sr, 48000, 44100, 16000) if isinstance(r, int) and r > 0]))
        max_idle_rms = float(aud_cfg.get('max_idle_rms', 1000) or 1000)
        if forced_idx is not None:
            try:
                target_idx = int(forced_idx)
            except Exception:
                target_idx = None
        elif forced_name:
            target_idx = self._resolve_audio_device_index('input', None, forced_name)
        elif self.input_device_index is not None:
            target_idx = self._resolve_audio_device_index('input', self.input_device_index, None)
        else:
            target_idx = self._resolve_audio_device_index('input', aud_cfg.get('input_device'), aud_cfg.get('input_device_name'))
        forced_override_active = bool(forced_name) or (forced_idx is not None)
        if forced_override_active and target_idx is None:
            print(f"[audio] Explicit {mode_label} override could not be resolved; refusing ranked fallback")
            return None, None, None, None
        configured_input_name = str(aud_cfg.get('input_device_name') or '').strip().lower()
        blocklist_terms = [str(term).strip().lower() for term in (aud_cfg.get('input_device_blocklist') or []) if str(term).strip()]
        candidates = []
        device_count = int(pa_instance.get_device_count())
        device_indices = [target_idx] if forced_override_active else list(range(device_count))
        for idx in device_indices:
            try:
                info = pa_instance.get_device_info_by_index(idx)
            except Exception:
                continue
            if int(info.get('maxInputChannels', 0)) <= 0:
                continue
            label = str(info.get('name') or f'Input {idx}')
            label_lower = label.lower()
            configured_name_match = bool(
                configured_input_name
                and (
                    label_lower == configured_input_name
                    or configured_input_name in label_lower
                    or label_lower in configured_input_name
                )
            )
            if blocklist_terms and not forced_override_active and any(term in label_lower for term in blocklist_terms):
                print(f"[audio] Skipping blocked input device: {label} (idx={idx})")
                continue
            for rate in rates:
                try:
                    chunk_frames = max(int(rate * 0.02), 160)
                    stream = pa_instance.open(format=format, channels=channels, rate=rate, input=True, frames_per_buffer=chunk_frames, input_device_index=idx)
                    probe_stats = self._probe_input_stream_health(stream, chunk_frames, sample_reads=8)
                    stream.stop_stream(); stream.close()
                    if bool(probe_stats.get('flatline')):
                        print(f"[audio] Rejecting flatline input: {label} (idx={idx}) @ {rate} Hz rms={int(probe_stats.get('idle_rms', 0))} span={int(probe_stats.get('rms_span', 0))} identical={int(bool(probe_stats.get('all_identical')))}")
                        continue
                    candidate = {
                        'idx': idx,
                        'label': label,
                        'rate': rate,
                        'chunk_frames': chunk_frames,
                        'idle_rms': float(probe_stats.get('idle_rms', 0.0)),
                        'probe_rms_span': float(probe_stats.get('rms_span', 0.0)),
                        'probe_detected': False,
                        'probe_calibrated': False,
                        'probe_text_score': 0.0,
                    }
                    candidate['configured_input_match'] = bool(
                        (target_idx is not None and idx == target_idx) or configured_name_match
                    )
                    candidate['target_config_rate_match'] = bool(
                        rate == config_sr and bool(candidate.get('configured_input_match'))
                    )
                    candidate['score'] = self._score_input_candidate(candidate, target_idx=target_idx)
                    candidates.append(candidate)
                except Exception:
                    continue
        candidates = sorted(candidates, key=self._candidate_sort_key)
        hot_candidates = [candidate for candidate in candidates if candidate['idle_rms'] > max_idle_rms]
        accepted_candidates = [candidate for candidate in candidates if candidate['idle_rms'] <= max_idle_rms]
        accepted_candidates, hot_candidates = self._apply_input_loopback_probe(accepted_candidates, hot_candidates, mode_label=mode_label)
        selected_tag = 'Selected input'
        if mode_label != 'input':
            selected_tag = mode_label
        min_live_rms = float(aud_cfg.get('min_live_rms', 20) or 20)
        for candidate in accepted_candidates + hot_candidates:
            idx = candidate['idx']
            rate = int(candidate['rate'])
            chunk_frames = int(candidate['chunk_frames'])
            try:
                stream = pa_instance.open(format=format, channels=channels, rate=rate, input=True, frames_per_buffer=chunk_frames, input_device_index=idx)
                reopen_stats = self._probe_input_stream_health(stream, chunk_frames, sample_reads=6)
                reopen_rms = float(reopen_stats.get('idle_rms', 0.0))
                if bool(reopen_stats.get('flatline')):
                    print(f"[audio] Rejecting flatline reopen: {candidate['label']} (idx={idx}) @ {rate} Hz rms={int(reopen_rms)} span={int(reopen_stats.get('rms_span', 0))} identical={int(bool(reopen_stats.get('all_identical')))}")
                    stream.stop_stream(); stream.close()
                    continue
                near_silent = candidate['idle_rms'] < min_live_rms and reopen_rms < min_live_rms
                has_live_alternative = any(
                    (c['idx'] != candidate['idx']) and (float(c.get('idle_rms', 0.0)) >= min_live_rms)
                    for c in accepted_candidates
                )
                if near_silent and has_live_alternative and not forced_override_active and not bool(candidate.get('configured_input_match')):
                    print(f"[audio] Skipping near-silent candidate: {candidate['label']} (idx={idx}) @ {rate} Hz")
                    stream.stop_stream(); stream.close()
                    continue
                self.input_device_index = idx
                print(f"[audio] {selected_tag}: {candidate['label']} (idx={idx}) @ {rate} Hz rms={int(candidate['idle_rms'])} reopen_rms={int(reopen_rms)} score={int(candidate['score'])}")
                return stream, idx, rate, chunk_frames
            except Exception:
                continue
        return None, None, None, None

    def _open_deterministic_input_stream(self, wav_path: str | None = None, target_rate: int = 16000):
        wav_path = wav_path or os.getenv('AVA_INPUT_WAV')
        if not wav_path:
            return None, None, None, None
        print(f"[audio] Deterministic input file: {wav_path}")
        stream = _DeterministicInputStream(wav_path, target_rate=target_rate)
        return stream, None, target_rate, max(int(target_rate * 0.02), 160)

    def _refresh_server_truth(self):
        if not getattr(self, 'server_client', None):
            return
        try:
            caps = self.server_client.capabilities()
            if caps and caps.get('ok'):
                self.server_caps = caps.get('capabilities')
        except Exception:
            pass
        try:
            exp = self.server_client.explain()
            if exp and exp.get('ok'):
                self.server_explain = exp
        except Exception:
            pass

    def _server_sync_loop(self):
        while True:
            try:
                self._refresh_server_truth()
            except Exception:
                pass
            time.sleep(60)

    def _hotkey_loop(self):
        # Windows console hotkeys (non-blocking). F9=doctor propose, F10=apply (double-press to confirm)
        if not MSVCRT_AVAILABLE:
            return
        while True:
            try:
                if msvcrt.kbhit():
                    ch = msvcrt.getwch()
                    if ch in ('\x00', '\xe0') and msvcrt.kbhit():
                        k = msvcrt.getwch()
                        code = ord(k)
                        now = time.time()
                        if code == 67:  # F9
                            print("[hotkeys] F9 → Doctor propose")
                            try:
                                if getattr(self, 'server_client', None):
                                    res = self.server_client.doctor(mode='propose', reason='hotkey')
                                    ok = bool(res and res.get('ok'))
                                    print("[doctor] Propose:", 'ok' if ok else 'failed')
                            except Exception as e:
                                print(f"[doctor] Propose error: {e}")
                        elif code == 68:  # F10
                            if self._apply_hotkey_armed and now < self._apply_hotkey_armed_until:
                                print("[hotkeys] F10 confirm → Apply")
                                token = f"YES_APPLY_{int(now)}"
                                try:
                                    if getattr(self, 'server_client', None):
                                        res = self.server_client.doctor(mode='apply', reason='hotkey', confirm_token=token)
                                        ok = bool(res and res.get('ok'))
                                        rb = bool((res or {}).get('applyResult', {}).get('rolledBack'))
                                        print("[doctor] Apply:", 'ok' if ok and not rb else 'rolled back' if rb else 'failed')
                                except Exception as e:
                                    print(f"[doctor] Apply error: {e}")
                                finally:
                                    self._apply_hotkey_armed = False
                            else:
                                self._apply_hotkey_armed = True
                                self._apply_hotkey_armed_until = now + 5.0
                                print("[hotkeys] Press F10 again within 5s to confirm apply")
                time.sleep(0.05)
            except Exception:
                time.sleep(0.2)

    def _spawn_server(self) -> subprocess.Popen | None:
        # Start node src/server.js in ../ava-server if present
        try:
            base = Path(__file__).resolve().parent
            server_dir = base.parent / "ava-server"
            if not server_dir.exists():
                print(f"[server] Directory not found: {server_dir}")
                return None
            env = os.environ.copy()
            proc = subprocess.Popen(["node", "src/server.js"], cwd=str(server_dir), env=env)
            print(f"[server] Started src/server.js (PID {proc.pid})")
            return proc
        except Exception as e:
            print(f"[server] Failed to start: {e}")
            return None

    def _ensure_server_started(self):
        try:
            url = self.cfg.get('server_url', "http://127.0.0.1:5051/respond")
            if self._server_up(url):
                print(f"[server] Up: {url}")
                self._brain_status = 'up'
                return
            print("[server] Down. Attempting to start…")
            sp = self._spawn_server()
            try:
                if sp is not None:
                    self._brain_pid = sp.pid
            except Exception:
                pass
            # Immediate re-health in case port already bound or fast-exit
            time.sleep(1.0)
            if self._server_up(url):
                print(f"[server] Up after start: {url}")
                self._brain_status = 'started'
                return
            try:
                if sp is not None and (sp.poll() is not None):
                    print("[server] Spawn exited quickly; server still unreachable.")
            except Exception:
                pass
            try:
                if sp is not None:
                    self._brain_pid = sp.pid
            except Exception:
                pass
            # Wait up to ~15s for it to come up
            for _ in range(15):
                time.sleep(1.0)
                if self._server_up(url):
                    print(f"[server] Up after start: {url}")
                    self._brain_status = 'started'
                    return
            print("[server] Still down after start attempts. Running in degraded mode (voice only).")
            self._brain_status = 'degraded'
        except Exception:
            pass

    async def _speak_text(self, text: str, turn_id=None):
        if not text:
            return
        # TURN-SCOPED TTS GATE: Only user-turn responses may speak
        active_token = getattr(self._turn_state, 'tts_token', None)
        if turn_id is None or turn_id != active_token:
            print(f"[tts.blocked_background] Rejected: turn_id={turn_id} active={active_token} text='{(text or '')[:40]}...'")
            return
        # CHOKEPOINT FILTER: Block internal agent-loop status from ALL voice paths
        if self._is_step_status_message(text):
            print(f"[tts-filter] Blocked agent-loop status: {text[:60]}...")
            return
        # TTS SOURCE OF TRUTH: sha1 proves no hidden rewrite between /respond and TTS
        _sha1 = hashlib.sha1(text.encode()).hexdigest()[:12]
        print(f"[tts-in] TTS_SOURCE=respond turn_id={turn_id} sha1={_sha1} preview='{text[:60]}...'")
        speak_text = self._prepare_tts_text(text)
        if not speak_text:
            return
        # UNIFIED MODE: Route through local TTS (Piper/Edge) instead of Deepgram remote
        if getattr(self, '_voice_session', None) and getattr(self, 'voice_selected', None) == 'unified':
            lf = self.cfg.get('local_fallback') or {}
            engine = lf.get('tts_engine', 'edge')
            print(f"[tts-route] Unified mode -> local TTS (engine={engine}): '{speak_text[:50]}...'")
            self._voice_session.speak(speak_text)
            return
        # SPEAK->SPEAK PREVENTION: Drop new speak calls if already speaking
        if self.tts_active.is_set():
            print(f"[speak-guard] Dropping speak call - already speaking: '{speak_text[:30]}...'")
            return
        # HALF-DUPLEX: Mute mic while speaking (set tts_active flag)
        # Mic loop checks this flag and suppresses audio input during TTS
        self.tts_active.set()
        self._tts_last_active = time.time()
        print("[half-duplex] MIC MUTED - TTS starting")
        speak_url = f"{DG_SPEAK_BASE}&encoding=linear16&sample_rate={self.playback_rate}"
        req = urllib.request.Request(
            url=speak_url,
            data=json.dumps({"text": speak_text}).encode('utf-8'),
            headers={
                'Authorization': f'Token {self.deepgram_key}',
                'Content-Type': 'application/json',
                'Accept': 'audio/wav'
            },
            method='POST'
        )
        ctx = ssl.create_default_context()
        try:
            # Stream audio chunks directly to playback for lower latency
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                # Skip WAV header
                _ = resp.read(44)
                while True:
                    if self.user_speaking.is_set():
                        break
                    chunk = resp.read(32768)
                    if not chunk:
                        break
                    await self.queue_audio_output(chunk)

        except Exception as e:
            print(f"TTS error: {e}")
        finally:
            # HALF-DUPLEX: Unmute mic after TTS completes
            self.tts_active.clear()
            self._tts_ended_at = time.time()
            print("[half-duplex] MIC UNMUTED - TTS complete (grace period active)")
            try:
                self.metrics['tts_utterances'] += 1
            except Exception:
                pass

    def _listen_url(self) -> str:
        model = self.cfg.get('asr_model') or 'nova-2'
        return (
            "wss://api.deepgram.com/v1/listen?encoding=linear16"
            f"&sample_rate={MIC_RATE}&channels=1&model={model}&smart_format=true"
        )

    async def connect_asr(self):
        print("\n🎤 Connecting to Deepgram Live (ASR)...")
        headers = { 'Authorization': f'Token {self.deepgram_key}' }
        url = self._listen_url()
        try:
            self.asr_ws = await websockets.connect(
                url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=20,
                max_queue=None,
                close_timeout=10,
            )
        except TypeError:
            self.asr_ws = await websockets.connect(
                url,
                additional_headers=headers,
                ping_interval=20,
                ping_timeout=20,
                max_queue=None,
                close_timeout=10,
            )
        print("✅ ASR connected")

    async def close_asr(self):
        try:
            if self.asr_ws:
                await self.asr_ws.close()
        except:
            pass
        self.asr_ws = None

    async def asr_receiver(self):
        print("👂 Listening for ASR events...\n")
        try:
            async for message in self.asr_ws:
                if isinstance(message, (bytes, bytearray)):
                    continue
                try:
                    event = json.loads(message)
                except Exception:
                    continue
                if self.cfg.get('debug_asr'):
                    try:
                        js = json.dumps(event)
                        preview = (js[:400] + '...') if len(js) > 400 else js
                        print(f"[ASR] {preview}")
                    except Exception:
                        pass
                alt = None
                is_final = False
                try:
                    # Deepgram ASR has is_final and channel at top level
                    is_final = bool(event.get('is_final', False))
                    ch = event.get('channel')
                    if ch and isinstance(ch, dict):
                        alts = ch.get('alternatives')
                        if alts and isinstance(alts, list) and len(alts) > 0:
                            alt = alts[0]
                except Exception:
                    pass
                transcript = ''
                if isinstance(alt, dict):
                    transcript = alt.get('transcript', '')
                    try:
                        self._last_asr_confidence = float(alt.get('confidence', 1.0))
                    except Exception:
                        self._last_asr_confidence = 1.0
                try:
                    self.metrics['asr_messages'] += 1
                except Exception:
                    pass
                if transcript:
                    if is_final:
                        # CRITICAL: Filter false activations
                        # 1. Check confidence - ignore low confidence finals
                        confidence = getattr(self, '_last_asr_confidence', 1.0) or 1.0
                        if confidence < 0.6:
                            print(f"[asr-filter] Low confidence final ignored: '{transcript}' (conf={confidence:.2f})")
                            continue
                        
                        # 2. Check minimum length - ignore very short garbage
                        word_count = len(transcript.split())
                        if word_count < 1 or len(transcript.strip()) < 2:
                            print(f"[asr-filter] Too short, ignored: '{transcript}'")
                            continue
                        
                        # 3. Check if TTS was recently active (echo protection)
                        if hasattr(self, '_tts_last_active'):
                            time_since_tts = time.time() - self._tts_last_active
                            if time_since_tts < 3.0:  # 3 second echo protection
                                print(f"[asr-filter] Ignored (echo protection): '{transcript}'")
                                continue
                        
                        # 4. Check for common ASR hallucinations (garbage words)
                        hallucination_patterns = ['uh', 'um', 'eh', 'ah', 'oh', 'mm', 'hm']
                        if transcript.lower().strip() in hallucination_patterns:
                            print(f"[asr-filter] Hallucination ignored: '{transcript}'")
                            continue
                        
                        # 5. DUPLICATE DETECTION: Ignore same transcript within 5 seconds
                        now = time.time()
                        transcript_key = transcript.lower().strip()
                        if hasattr(self, '_recent_transcripts'):
                            last_time = self._recent_transcripts.get(transcript_key, 0)
                            if now - last_time < self._duplicate_window_sec:
                                print(f"[asr-filter] Duplicate ignored: '{transcript}'")
                                continue
                            # Clean old entries and add current
                            self._recent_transcripts = {k: v for k, v in self._recent_transcripts.items() if now - v < self._duplicate_window_sec}
                            self._recent_transcripts[transcript_key] = now
                        
                        print(f"\n🗣️  You: {transcript}")
                        try:
                            self.metrics['asr_finals'] += 1
                        except Exception:
                            pass

                        # D005 BARGE-IN: Check if we should interrupt current speech
                        if self._barge_in_enabled and self._turn_state.state == TurnState.SPEAK:
                            # User is speaking while AVA is speaking - potential barge-in
                            now_ms = time.time() * 1000
                            cooldown_ok = (now_ms - self._barge_in_last_interrupt_time) > self._barge_in_cooldown_ms

                            if cooldown_ok:
                                print(f"[D005] Barge-in detected: user interrupted TTS")
                                # Interrupt the current speech
                                if self._turn_state.interrupt_speaking(f"user said: {transcript[:30]}"):
                                    self._barge_in_last_interrupt_time = now_ms
                                    # Cancel TTS if configured
                                    if self._barge_in_cancel_tts:
                                        self._cancel_tts()
                                        self.tts_active.clear()
                                        print(f"[D005] TTS cancelled due to barge-in")
                                    # Continue to process the new transcript below
                                else:
                                    # Interrupt failed - skip this transcript
                                    print(f"[D005] Barge-in interrupt failed, skipping transcript")
                                    continue
                            else:
                                print(f"[D005] Barge-in blocked: cooldown active ({self._barge_in_cooldown_ms}ms)")
                                continue

                        # TURN STATE: FINAL transcript received
                        print(f"[FINAL -> DECIDE] '{transcript[:40]}...'")
                        self._turn_state.transition(TurnState.LISTEN, "user speaking")
                        self._turn_state.transition(TurnState.FINAL, "final transcript")
                        self._turn_state.transition(TurnState.DECIDE, "processing")
                        tts_token = self._turn_state.tts_token

                        # Check if this is a correction of AVA's last response
                        if self._detect_correction(transcript):
                            self._handle_correction(transcript)

                        # Intercept local intents (doctor/capabilities/approval)
                        handled = await self._maybe_handle_local_intent(transcript, turn_id=tts_token)
                        if handled:
                            self._turn_state.force_idle("local intent handled")
                            continue

                        # Check for past mistakes and enhance transcript if needed
                        enhanced_transcript = self._get_enhanced_transcript(transcript)

                        reply = await self._ask_server_respond(enhanced_transcript)
                        if reply:
                            # Final safety filter - block step status (don't replace with canned text)
                            if self._is_step_status_message(reply):
                                print(f"[filter] Blocked step status at ASR receiver: {reply[:60]}...")
                                reply = ''
                        if reply:
                            print(f"🤖 AVA: {reply}")

                            # TURN STATE: Entering SPEAK phase
                            self._turn_state.transition(TurnState.SPEAK, "TTS starting")
                            try:
                                await self._speak_text(reply, turn_id=tts_token)
                            finally:
                                # TURN STATE: Back to IDLE after speaking (guaranteed cleanup)
                                self._turn_state.force_idle("TTS complete")

                            # Track for correction detection
                            self._last_user_transcript = transcript
                            self._last_ava_response = reply

                            # Record interaction for passive learning
                            if self.passive_learning_enabled and PASSIVE_LEARNING_AVAILABLE:
                                try:
                                    record_interaction(transcript, reply, True)
                                except:
                                    pass
                        else:
                            # No reply or blocked status - return to IDLE
                            self._turn_state.force_idle("no reply")
                    else:
                        # PARTIAL TRANSCRIPT: Display only, NEVER trigger tools
                        # This is a critical safety gate - partials are unreliable
                        if transcript.strip():
                            print(f"[PARTIAL -> NO_TOOL] '{transcript[:50]}...' (interim, display only)")

                            # D005 BARGE-IN: Allow partials to interrupt TTS if configured
                            # Note: Even with partial interrupt, tools still require FINAL (preserved invariant)
                            if (self._barge_in_enabled and
                                not self._barge_in_require_final and
                                self._turn_state.state == TurnState.SPEAK):
                                now_ms = time.time() * 1000
                                cooldown_ok = (now_ms - self._barge_in_last_interrupt_time) > self._barge_in_cooldown_ms
                                if cooldown_ok:
                                    print(f"[D005] Barge-in on partial: interrupting TTS (tools still gated)")
                                    if self._turn_state.interrupt_speaking(f"partial: {transcript[:20]}"):
                                        self._barge_in_last_interrupt_time = now_ms
                                        if self._barge_in_cancel_tts:
                                            self._cancel_tts()
                                            self.tts_active.clear()
                                            print(f"[D005] TTS cancelled due to partial barge-in")
                                        # Note: We do NOT process the partial - just interrupted TTS
                                        # User must say a final transcript to trigger tools
        except WS_ClosedGeneral as e:
            print(f"\n🔌 ASR connection closed: {e}")
            try:
                self.metrics['reconnects'] += 1
            except Exception:
                pass
        except Exception as e:
            print(f"\n❌ ASR receiver error: {e}")
            try:
                self.metrics['last_error'] = str(e)
            except Exception:
                pass

    async def stream_microphone_input(self):
        """Stream microphone input to Deepgram ASR"""
        aud_cfg = self.cfg.get('audio') or {}
        _dg_config_sr = int(aud_cfg.get('input_sample_rate', MIC_RATE))
        _dg_rates = list(dict.fromkeys([_dg_config_sr, 48000, 44100, 16000]))
        _dg_mic_rate = MIC_RATE
        _dg_chunk = CHUNK_SAMPLES

        def _open_dg_mic():
            return self._open_ranked_input_stream(
                self.audio,
                format=FORMAT,
                channels=CHANNELS,
                target_rate=MIC_RATE,
                mode_label='DG mic',
            )

        stream = _open_dg_mic()
        _dg_sel_idx = None
        if isinstance(stream, tuple):
            stream, _dg_sel_idx, _dg_mic_rate, _dg_chunk = stream
        if stream is None:
            raise RuntimeError(f"No mic available (tried rates {_dg_rates})")
        _dg_need_resample = (_dg_mic_rate != MIC_RATE)
        if _dg_need_resample:
            print(f"[audio] DG mic will resample: {_dg_mic_rate} Hz -> {MIC_RATE} Hz")

        if self._validation_mode:
            print("🎤 Microphone active - wake word required in validation mode")
        else:
            print("🎤 Microphone active - AVA is always listening!")

        try:
            while self.running:
                # Reopen mic on config changes
                if getattr(self, '_reopen_mic', False):
                    try:
                        stream.stop_stream(); stream.close()
                    except Exception:
                        pass
                    stream = open_mic()
                    _dg_need_resample = (_dg_mic_rate != MIC_RATE)
                    setattr(self, '_reopen_mic', False)
                audio_data = stream.read(_dg_chunk, exception_on_overflow=False)
                if _dg_need_resample:
                    audio_data = _resample_audio(audio_data, _dg_mic_rate, MIC_RATE)
                # VAD gating during active TTS
                rms = self._rms_int16(audio_data)
                if self.cfg.get('debug_rms'):
                    if int(time.time()*2) % 10 == 0:
                        print(f"[mic] rms={int(rms)}")
                now = time.time()
                # HALF-DUPLEX ENFORCEMENT: Skip mic frames when TTS is active
                if self.tts_active.is_set():
                    if not self.user_speaking.is_set():
                        if rms >= self.START_THRESH:
                            self._loud_frames += 1
                            if self._loud_frames >= 3:
                                self.user_speaking.set()
                                self._last_user_voice_t = now
                                self._cancel_tts()
                        else:
                            self._loud_frames = 0
                    else:
                        if rms >= self.STOP_THRESH:
                            self._last_user_voice_t = now
                        elif (now - self._last_user_voice_t) > self.SPEECH_HOLD_SEC:
                            self.user_speaking.clear()
                    # HALF-DUPLEX: Don't send mic audio to ASR while TTS is playing
                    if not self.user_speaking.is_set():
                        await asyncio.sleep(CHUNK_SAMPLES / MIC_RATE)
                        continue

                if self.asr_ws is not None:
                    try:
                        await self.asr_ws.send(audio_data)
                    except Exception:
                        await asyncio.sleep(0.02)
                await asyncio.sleep(CHUNK_SAMPLES / MIC_RATE)

        finally:
            stream.stop_stream()
            stream.close()

    def _audio_playback_worker(self):
        """Worker thread for continuous audio playback"""
        # Open persistent playback stream (with dynamic re-open support)
        def open_playback():
            try:
                open_kwargs = dict(format=FORMAT, channels=CHANNELS, rate=self.playback_rate, output=True, frames_per_buffer=4096)
                if self.output_device_index is not None:
                    open_kwargs['output_device_index'] = self.output_device_index
                # Log selected output device
                try:
                    if 'output_device_index' in open_kwargs:
                        info = self.audio.get_device_info_by_index(open_kwargs['output_device_index'])
                    else:
                        info = self.audio.get_default_output_device_info()
                    print(f"[audio] Using output device: {info.get('name')} (idx={info.get('index')}) @ {self.playback_rate} Hz")
                except Exception:
                    pass
                return self.audio.open(**open_kwargs)
            except Exception:
                try:
                    self.playback_rate = 48000
                    open_kwargs = dict(format=FORMAT, channels=CHANNELS, rate=self.playback_rate, output=True, frames_per_buffer=4096)
                    if self.output_device_index is not None:
                        open_kwargs['output_device_index'] = self.output_device_index
                    print(f"[audio] Fallback playback rate {self.playback_rate} Hz")
                    try:
                        if 'output_device_index' in open_kwargs:
                            info = self.audio.get_device_info_by_index(open_kwargs['output_device_index'])
                        else:
                            info = self.audio.get_default_output_device_info()
                        print(f"[audio] Using output device: {info.get('name')} (idx={info.get('index')}) @ {self.playback_rate} Hz")
                    except Exception:
                        pass
                    return self.audio.open(**open_kwargs)
                except Exception as e:
                    print(f"Playback open error: {e}")
                    # Auto-select a viable output device
                    try:
                        dev_count = self.audio.get_device_count()
                        for idx in range(dev_count):
                            try:
                                info = self.audio.get_device_info_by_index(idx)
                                if int(info.get('maxOutputChannels', 0)) <= 0:
                                    continue
                                test_kwargs = dict(format=FORMAT, channels=CHANNELS, rate=self.playback_rate, output=True, frames_per_buffer=2048, output_device_index=idx)
                                stream = self.audio.open(**test_kwargs)
                                print(f"[audio] Auto-selected output: {info.get('name')} (idx={idx}) @ {self.playback_rate} Hz")
                                return stream
                            except Exception:
                                continue
                        print("[audio] No suitable output device found.")
                    except Exception:
                        pass
                    return None

        self.playback_stream = open_playback()
        if self.playback_stream is None:
            return

        try:
            while self.running:
                try:
                    # Reopen playback if requested by config changes
                    # BUT only when queue is empty and TTS is not active (prevents segfaults)
                    if getattr(self, '_reopen_playback', False):
                        if self.audio_queue.empty() and not self.tts_active.is_set():
                            try:
                                self.playback_stream.stop_stream()
                                self.playback_stream.close()
                            except Exception:
                                pass
                            self.playback_stream = open_playback()
                            setattr(self, '_reopen_playback', False)
                            if self.playback_stream is None:
                                time.sleep(0.5)
                                continue
                        # else: defer reopen until queue is empty and TTS is done
                    # Get audio chunk from queue with timeout
                    audio_data = self.audio_queue.get(timeout=0.1)

                    if audio_data is None:  # Poison pill to stop thread
                        break

                    # Write audio chunk to stream
                    try:
                        # Drop immediately during abort window to ensure snappy barge-in
                        if time.time() < getattr(self, '_playback_abort_until', 0.0):
                            continue
                        self.playback_busy.set()
                        # Debug: log playback activity periodically
                        pc = getattr(self, '_playback_chunk_count', 0) + 1
                        self._playback_chunk_count = pc
                        if pc % 50 == 1:
                            print(f"[playback] Writing chunk #{pc}, size={len(audio_data)}, q={self.audio_queue.qsize()}")
                        # Make a copy to avoid any potential memory issues
                        audio_copy = bytes(audio_data)
                        self.playback_stream.write(audio_copy)
                    except Exception as write_err:
                        print(f"[playback] Write error: {write_err}")
                    finally:
                        self.playback_busy.clear()
                    # Update global playback RMS EMA for echo gating
                    try:
                        pr = self._rms_int16(audio_data)
                        self._playback_rms_ema = (self._playback_rms_ema * 0.85) + (pr * 0.15)
                    except Exception:
                        pass

                    # Detect end-of-playback to start ASR blackout window
                    try:
                        synthesis_active = bool(getattr(self, '_tts_synthesis_active', False))
                        if getattr(self, '_awaiting_playback_end', False) and not synthesis_active and self.audio_queue.empty():
                            import time as _t
                            self._asr_blackout_until = _t.time() + 0.8
                            self._awaiting_playback_end = False
                            self._playback_end_fired = True
                            self.tts_active.clear()
                            print(f"[echo-gate] ASR blackout until {self._asr_blackout_until:.3f}")
                            try:
                                if hasattr(self, '_voice_provider') and self._voice_provider:
                                    asr = getattr(self._voice_provider, 'asr', None)
                                    if asr and hasattr(asr, 'clear_buffer'):
                                        asr.clear_buffer()
                                        print("[echo-gate] Cleared ASR buffer on playback end")
                            except Exception:
                                pass
                            print("[half-duplex] MIC UNMUTED (unified) - playback finished")
                            try:
                                if hasattr(self, '_turn_state') and self._turn_state:
                                    self._turn_state.force_idle("TTS playback finished (playback.end)")
                            except Exception:
                                pass
                    except Exception:
                        pass

                except queue.Empty:
                    continue
                except Exception as e:
                    import traceback
                    print(f"Playback error: {e}")
                    traceback.print_exc()

        except Exception as fatal_error:
            import traceback
            print(f"[playback] FATAL ERROR in playback worker: {fatal_error}")
            traceback.print_exc()
        finally:
            print("[playback] Worker thread exiting")
            if self.playback_stream:
                try:
                    self.playback_stream.stop_stream()
                    self.playback_stream.close()
                except Exception:
                    pass

    # ---------------------- Voice Engine Switching ----------------------

    def _switch_to_local_voice(self):
        """Switch from Deepgram to local Whisper + Edge TTS"""
        with self.voice_engine_state.lock:
            if self.voice_engine_state.current == VoiceEngineState.LOCAL:
                return  # Already on local
            if not self.local_voice_engine:
                print("[voice] Cannot switch to local - engine not available")
                return
            
            self.voice_engine_state.current = VoiceEngineState.SWITCHING
            print("[voice] ⚡ Switching to LOCAL voice engine (Whisper + Edge TTS)...")
        
        # Update state
        with self.voice_engine_state.lock:
            self.voice_engine_state.current = VoiceEngineState.LOCAL
            self.voice_engine_state.deepgram_available = False
            self.voice_engine_state.last_deepgram_check = time.time()
        
        # Start local voice engine in a thread
        threading.Thread(target=self.local_voice_engine.run, name="local_voice", daemon=True).start()
        
        print("[voice] ✅ Now using LOCAL voice engine")

    def _switch_to_deepgram(self):
        """Switch from local back to Deepgram"""
        with self.voice_engine_state.lock:
            if self.voice_engine_state.current == VoiceEngineState.DEEPGRAM:
                return  # Already on Deepgram
            
            self.voice_engine_state.current = VoiceEngineState.SWITCHING
            print("[voice] ⚡ Switching to DEEPGRAM voice engine...")
        
        # Stop local engine
        if self.local_voice_engine:
            self.local_voice_engine.stop()
        
        # Wait for clean handoff
        time.sleep(0.5)
        
        with self.voice_engine_state.lock:
            self.voice_engine_state.current = VoiceEngineState.DEEPGRAM
            self.voice_engine_state.deepgram_available = True
            self.voice_engine_state.consecutive_errors = 0
        
        print("[voice] ✅ Now using DEEPGRAM voice engine")

    def _check_deepgram_available(self) -> bool:
        """Check if Deepgram API is available (not quota exhausted)"""
        try:
            import urllib.request
            import urllib.error
            
            # Simple API check - get project info
            url = "https://api.deepgram.com/v1/projects"
            req = urllib.request.Request(url)
            req.add_header("Authorization", f"Token {self.deepgram_key}")
            req.add_header("Content-Type", "application/json")
            
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
                if response.status == 200:
                    print("[deepgram] API check passed - quota available")
                    return True
                    
        except urllib.error.HTTPError as e:
            if e.code == 402:
                print(f"[deepgram] ⚠️ Quota exhausted (HTTP 402)")
                return False
            elif e.code == 401:
                print(f"[deepgram] ⚠️ Invalid API key (HTTP 401)")
                return False
            else:
                print(f"[deepgram] HTTP error {e.code}: {e.reason}")
                # Other errors might be transient, assume available
                return True
        except Exception as e:
            print(f"[deepgram] Check failed: {e}")
            # Network error, assume available and let it fail later
            return True
        
        return True

    def _handle_deepgram_quota_error(self):
        """Handle Deepgram quota exceeded - switch to local if available"""
        self.voice_engine_state.consecutive_errors += 1
        errors = self.voice_engine_state.consecutive_errors
        threshold = self.voice_engine_state.error_threshold
        
        print(f"[voice] Deepgram quota error ({errors}/{threshold})")
        
        if errors >= threshold and self.local_voice_engine:
            self._switch_to_local_voice()
            return True  # Signal to stop Deepgram loop
        
        return False

    # ---------------------- Deepgram Agent Voice (proven path) ----------------------

    def run_agent_voice(self):
        # Import Deepgram and socket types inside cloud branch
        try:
            from deepgram import DeepgramClient
            from deepgram.core.events import EventType as _DGEventType
            from deepgram.extensions.types.sockets import (
                AgentV1Agent,
                AgentV1AudioConfig,
                AgentV1AudioInput,
                AgentV1AudioOutput,
                AgentV1DeepgramSpeakProvider,
                AgentV1Endpoint,
                AgentV1GoogleThinkProvider,
                AgentV1AnthropicThinkProvider,
                AgentV1OpenAiThinkProvider,
                AgentV1GroqThinkProvider,
                AgentV1Listen,
                AgentV1ListenProvider,
                AgentV1SettingsMessage,
                AgentV1SocketClientResponse,
                AgentV1SpeakProviderConfig,
                AgentV1Think,
            )
        except Exception as e:
            print(f"[agent] Deepgram SDK not available: {e}")
            return

        client = DeepgramClient(api_key=self.deepgram_key)
        p = pyaudio.PyAudio()
        out_kwargs = dict(format=pyaudio.paInt16, channels=1, rate=24000, output=True)
        if self.output_device_index is not None:
            out_kwargs['output_device_index'] = self.output_device_index
        # Open speaker with fallbacks and logging
        try:
            try:
                if 'output_device_index' in out_kwargs:
                    info = p.get_device_info_by_index(out_kwargs['output_device_index'])
                else:
                    info = p.get_default_output_device_info()
                print(f"[audio] Agent using output device: {info.get('name')} (idx={info.get('index')}) @ {out_kwargs['rate']} Hz")
            except Exception:
                pass
            speaker_stream = p.open(**out_kwargs)
        except Exception:
            try:
                out_kwargs['rate'] = 48000
                if 'output_device_index' in out_kwargs:
                    info = p.get_device_info_by_index(out_kwargs['output_device_index'])
                else:
                    info = p.get_default_output_device_info()
                print(f"[audio] Agent fallback device: {info.get('name')} (idx={info.get('index')}) @ {out_kwargs['rate']} Hz")
                speaker_stream = p.open(**out_kwargs)
            except Exception as e:
                print(f"Agent speaker open error: {e}")
                # Try auto-selecting any viable output device
                speaker_stream = None
                try:
                    dev_count = p.get_device_count()
                    for idx in range(dev_count):
                        try:
                            info = p.get_device_info_by_index(idx)
                            if int(info.get('maxOutputChannels', 0)) <= 0:
                                continue
                            test_kwargs = dict(format=pyaudio.paInt16, channels=1, rate=48000, output=True, frames_per_buffer=1920, output_device_index=idx)
                            speaker_stream = p.open(**test_kwargs)
                            print(f"[audio] Agent auto-selected output: {info.get('name')} (idx={idx}) @ 48000 Hz")
                            break
                        except Exception:
                            continue
                except Exception:
                    pass
                if speaker_stream is None:
                    raise RuntimeError("No suitable output device for agent speech")
        # Agent mic open with rate cascade
        _agent_aud_cfg = self.cfg.get('audio') or {}
        _agent_config_sr = int(_agent_aud_cfg.get('input_sample_rate', MIC_RATE))
        _agent_rates = list(dict.fromkeys([_agent_config_sr, 48000, 44100, 16000]))
        _agent_mic_rate = MIC_RATE
        _agent_mic_chunk = 1024

        def _open_agent_mic():
            return self._open_ranked_input_stream(
                p,
                format=FORMAT,
                channels=CHANNELS,
                target_rate=MIC_RATE,
                mode_label='Agent mic',
            )

        mic_stream = _open_agent_mic()
        _agent_target = None
        if isinstance(mic_stream, tuple):
            mic_stream, _agent_target, _agent_mic_rate, _agent_mic_chunk = mic_stream
        if mic_stream is None:
            raise RuntimeError(f"No mic available for agent voice (tried rates {_agent_rates})")
        _agent_need_resample = (_agent_mic_rate != MIC_RATE)
        if _agent_need_resample:
            print(f"[audio] Agent mic will resample: {_agent_mic_rate} Hz -> {MIC_RATE} Hz")

        shutdown = threading.Event()
        connection_active = threading.Event()
        conn_ref = {"conn": None}
        wav_stripper = WavToPcmStripper()
        agent_tts_fallback = threading.Event()
        non_audio_ctr = {"n": 0}  # Counter for debugging non-audio messages

        # Agent audio playback queue for non-blocking writes
        agent_audio_queue = queue.Queue()
        agent_playback_active = threading.Event()

        # Shared state for echo/interrupt control
        playback_rms = {"v": 0.0}
        tts_start_time = {"t": 0.0}
        last_tts_pcm_time = {"t": 0.0}
        barge_cfg = self.cfg.get('barge') or {}
        debounce_frames = int(barge_cfg.get('debounce_frames', 3))
        dyn_scale = float(barge_cfg.get('dyn_thresh_scale', 0.6))
        min_tts_ms = int(barge_cfg.get('min_tts_ms', 300))
        # Stricter barge-in while TTS is playing to avoid echo trigger from speakers
        strict_dyn_scale = float(barge_cfg.get('strict_dyn_scale', 2.2))
        strict_debounce_frames = int(barge_cfg.get('strict_debounce_frames', max(6, debounce_frames + 4)))

        # Audio send counter for debugging
        audio_send_ctr = {"n": 0}

        # Connection health tracking for watchdog
        last_rx_time = {"t": time.time()}
        last_tx_time = {"t": time.time()}

        # Local barge mode flag for agent voice
        barge_mode = threading.Event()

        # Watchdog to clear stuck TTS state if AgentAudioDone is missed
        def tts_watchdog():
            while not shutdown.is_set():
                try:
                    if self.tts_active.is_set():
                        now = time.time()
                        base = max(tts_start_time.get("t", 0.0), last_tts_pcm_time.get("t", 0.0))
                        if base and (now - base) > 3.0:
                            self.tts_active.clear()
                            tts_start_time["t"] = 0.0
                            last_tts_pcm_time["t"] = 0.0
                            playback_rms["v"] = 0.0
                            self.user_speaking.clear()
                            barge_mode.clear()
                            wav_stripper.reset()
                            agent_tts_fallback.clear()
                            # Clear playback queue
                            try:
                                while not agent_audio_queue.empty():
                                    agent_audio_queue.get_nowait()
                            except Exception:
                                pass
                except Exception:
                    pass
                time.sleep(0.5)

        def connection_watchdog():
            """Force reconnect if idle >25s (no RX or TX activity)"""
            IDLE_TIMEOUT = 25.0
            while not shutdown.is_set():
                time.sleep(5.0)
                if connection_active.is_set():
                    now = time.time()
                    idle_for = now - max(last_rx_time["t"], last_tx_time["t"])
                    if idle_for > IDLE_TIMEOUT:
                        print(f"[watchdog] Idle {idle_for:.1f}s, forcing reconnect")
                        try:
                            conn = conn_ref["conn"]
                            if conn is not None:
                                conn.close()
                        except Exception as ex:
                            print(f"[watchdog] Close error: {ex}")
                        connection_active.clear()

        def agent_playback_thread():
            """Non-blocking playback thread for agent TTS audio"""
            agent_playback_active.set()

            try:
                while not shutdown.is_set():
                    try:
                        # Get audio from queue with timeout
                        pcm_data = agent_audio_queue.get(timeout=0.05)

                        if pcm_data is None:  # Poison pill to stop thread
                            break

                        # Handle barge-in: drop audio if user is speaking
                        if barge_mode.is_set():
                            print(f"[PLAYBACK] Dropping audio chunk (barge_mode active)")
                            continue

                        # Write to speaker stream (non-blocking for message handler)
                        try:
                            speaker_stream.write(pcm_data)
                        except Exception as e:
                            # If write fails, try to continue with next chunk
                            pass
                    except queue.Empty:
                        # Just wait for more audio - don't clear tts_active here
                        # The message handler will clear it when AgentAudioDone arrives
                        continue
                    except Exception:
                        pass
            finally:
                agent_playback_active.clear()

        def microphone_thread():
            nonlocal mic_stream
            loud_frames = 0
            while not shutdown.is_set():
                try:
                    # Hot-reopen mic if config changed
                    if getattr(self, '_reopen_mic', False):
                        try:
                            mic_stream.stop_stream(); mic_stream.close()
                        except Exception:
                            pass
                        try:
                            _reopened = False
                            _rtgt = self.input_device_index
                            for _rr in _agent_rates:
                                try:
                                    _rcf = max(int(_rr * 0.02), 160)
                                    _rkw = dict(format=FORMAT, channels=CHANNELS, rate=_rr, input=True, frames_per_buffer=_rcf)
                                    if _rtgt is not None:
                                        _rkw['input_device_index'] = _rtgt
                                    mic_stream = p.open(**_rkw)
                                    _agent_mic_rate = _rr
                                    _agent_mic_chunk = _rcf
                                    _agent_need_resample = (_rr != MIC_RATE)
                                    print(f"[audio] Reopened agent mic @ {_rr} Hz (resample={_agent_need_resample})")
                                    _reopened = True
                                    break
                                except Exception:
                                    continue
                            if not _reopened:
                                print(f"[audio] Agent mic reopen failed for all rates")
                        except Exception as _e:
                            print(f"[audio] Mic reopen failed: {_e}")
                        setattr(self, '_reopen_mic', False)
                except Exception:
                    pass
                try:
                    data = mic_stream.read(_agent_mic_chunk, exception_on_overflow=False)
                    if _agent_need_resample:
                        data = _resample_audio(data, _agent_mic_rate, MIC_RATE)
                except Exception:
                    time.sleep(0.01)
                    continue
                # Half-duplex echo control with dynamic threshold and debounce
                rms = self._rms_int16(data)
                # Optional RMS debug output to verify mic capture
                try:
                    if bool(self.cfg.get('debug_rms', False)):
                        if int(time.time()*2) % 10 == 0:
                            print(f"[mic] rms={int(rms)}")
                except Exception:
                    pass
                now = time.time()
                # Echo-aware barge-in policy during playback (matching avas_voice.py pattern)
                if self.tts_active.is_set():
                    if not self.user_speaking.is_set():
                        # Dynamic threshold based on far-end playback level
                        prms = max(self._playback_rms_ema, playback_rms["v"])
                        dyn_thresh = max(self.START_THRESH, prms * dyn_scale)  # Use config variable
                        if rms >= dyn_thresh:
                            loud_frames += 1
                            if loud_frames >= debounce_frames:
                                self.user_speaking.set()
                                barge_mode.set()  # Drop TTS while user speaks
                                self._last_user_voice_t = now
                        else:
                            loud_frames = 0
                    else:
                        # Maintain speaking state with hysteresis and hold
                        if rms >= self.STOP_THRESH:
                            self._last_user_voice_t = now
                        elif (now - self._last_user_voice_t) > self.SPEECH_HOLD_SEC:
                            self.user_speaking.clear()
                            barge_mode.clear()
                            loud_frames = 0
                    # If TTS is active and user isn't speaking, drop mic frames (like avas_voice.py)
                    if not self.user_speaking.is_set():
                        # Send periodic keepalive silence to prevent timeout
                        if (now - last_tx_time.get("t", 0)) > 5.0:
                            silent = b"\x00" * 480 * 2  # 480 samples at 16kHz, 16-bit mono
                            if connection_active.is_set():
                                try:
                                    c = conn_ref["conn"]
                                    if c is not None:
                                        c.send_media(silent)
                                        last_tx_time["t"] = now
                                except Exception:
                                    pass
                        continue  # Drop this frame, don't send it
                else:
                    # No TTS; reset state
                    barge_mode.clear()
                    self.user_speaking.clear()
                    loud_frames = 0

                # Send real audio upstream
                if connection_active.is_set():
                    try:
                        c = conn_ref["conn"]
                        if c is not None:
                            c.send_media(data)
                            last_tx_time["t"] = time.time()
                            audio_send_ctr["n"] += 1
                    except Exception as e:
                        pass
                else:
                    time.sleep(0.01)

        threading.Thread(target=tts_watchdog, name="tts_watch", daemon=True).start()
        threading.Thread(target=connection_watchdog, name="conn_watchdog", daemon=True).start()
        threading.Thread(target=agent_playback_thread, name="agent_playback", daemon=True).start()
        threading.Thread(target=microphone_thread, name="agent_mic", daemon=True).start()

        # Pre-build settings message ONCE before connection loop to minimize delay
        ident = self.identity
        name = ident.get('name', 'AVA')
        dev = ident.get('developer', 'your developer')
        purpose = ident.get('purpose', 'your assistant on this laptop')
        
        # Get personality context if available
        personality_context = ""
        if PERSONALITY_AVAILABLE:
            try:
                personality_context = get_personality_context()
            except Exception as e:
                print(f"[personality] Error loading context: {e}")
        
        # Get self-awareness learning context if available
        learning_context = ""
        if SELF_AWARENESS_AVAILABLE and self.self_awareness_enabled:
            try:
                learning_context = get_prompt_context()
            except Exception as e:
                print(f"[self-awareness] Error loading context: {e}")
        
        prompt_text = (
            f"You are {name}, my on-device assistant built by {dev}. "
            f"You run locally on this laptop and operate as the AVA agent. "
            f"Purpose: {purpose}. "
        )
        
        # Add personality context if available
        if personality_context:
            prompt_text += f" {personality_context} "
        
        # Add self-awareness learning context if available
        if learning_context:
            prompt_text += f" LEARNED CONTEXT: {learning_context} "
        
        # Add passive context (current screen/environment awareness)
        if PASSIVE_LEARNING_AVAILABLE and self.passive_learning_enabled:
            try:
                passive_ctx = get_passive_context()
                if passive_ctx.get("active_app") and passive_ctx["active_app"] != "unknown":
                    prompt_text += f" CURRENT CONTEXT: User is in {passive_ctx['active_app']} ({passive_ctx.get('context_type', 'general')} activity). "
            except:
                pass
        
        prompt_text += (
            f"Behavioral contract: You are the voice for the AVA agent runtime. "
            f"Self-awareness: You can describe your identity, uptime, platform, and install location. "
            f"Tool calling: NEVER output JSON tool calls in your assistant text. "
            f"Use the function calling interface provided by the system instead. "
            f"When you need to call a tool, use the native function calling mechanism - do NOT print JSON. "
            f"If no tool is needed, respond concisely in first person. "
            f"Never claim an action is complete unless the tool result confirms it. "
            f"CRITICAL - NEVER speak these types of messages: "
            f"'step X of Y', 'completed step', 'reached step', 'executing step', 'plan step', "
            f"'task complete', 'operation complete', 'running', 'processing', 'working on'. "
            f"These are internal status messages - NEVER say them aloud. "
            f"Wait for the user to speak first before responding. Do not speak unprompted. "
            f"Speech policy: Do not read punctuation or decorative symbols aloud. "
            f"Treat characters like *, #, _, ~, backticks, code fences, and emoji as silent unless explicitly asked to read them. "
            f"If text includes markup or formatting symbols, convey the meaning in natural speech instead of pronouncing symbols."
        )
        dg_functions = self._deepgram_functions_from_corrected_tools()

        # Get available think providers for fallback
        available_providers = self._get_available_think_providers()
        if not available_providers:
            print("[agent] ERROR: No LLM providers available for think!")
            return

        current_provider_idx = {"idx": 0}  # Track which provider we're using

        def build_settings_with_provider(provider_name, provider_class, model_name):
            """Helper to build settings with a specific think provider"""
            # Determine provider type string based on class
            if provider_class == AgentV1GoogleThinkProvider:
                provider_type = "google"
            elif provider_class == AgentV1AnthropicThinkProvider:
                provider_type = "anthropic"
            elif provider_class == AgentV1OpenAiThinkProvider:
                provider_type = "open_ai"
            elif provider_class == AgentV1GroqThinkProvider:
                provider_type = "groq"
            else:
                provider_type = "unknown"

            # Deepgram manages all providers natively - no custom endpoints needed
            # This avoids INVALID_SETTINGS errors from endpoint conflicts
            think_config = AgentV1Think(
                provider=provider_class(type=provider_type, model=model_name),
                prompt=prompt_text,
                functions=dg_functions
            )

            return AgentV1SettingsMessage(
                audio=AgentV1AudioConfig(
                    input=AgentV1AudioInput(encoding="linear16", sample_rate=MIC_RATE),
                    output=AgentV1AudioOutput(encoding="linear16", sample_rate=24000, container="wav")
                ),
                agent=AgentV1Agent(
                    language="en",
                    listen=AgentV1Listen(
                        provider=AgentV1ListenProvider(type="deepgram", model="nova-2")
                    ),
                    think=think_config,
                    speak=AgentV1SpeakProviderConfig(
                        provider=AgentV1DeepgramSpeakProvider(type="deepgram", model="aura-2-andromeda-en")
                    )
                )
            )

        # Start with the first provider
        provider_name, provider_class, model_name = available_providers[current_provider_idx["idx"]]
        settings_obj = build_settings_with_provider(provider_name, provider_class, model_name)
        print(f"[agent] Settings object built: ASR={self.cfg.get('asr_model','nova-2')}, TTS={self.cfg.get('tts_model','aura-2-andromeda-en')}, Think={provider_name} ({model_name})")

        try:
            while not shutdown.is_set():
                try:
                    with client.agent.v1.connect() as connection:
                        conn_ref["conn"] = connection  # Store connection immediately

                        suppress_agent_tts = bool(self.cfg.get('suppress_agent_tts', True))

                        def on_message(message: AgentV1SocketClientResponse):
                            if isinstance(message, bytes):
                                # Strip WAV header and get PCM data (like avas_voice.py)
                                pcm = wav_stripper.feed(message)
                                if pcm:
                                    self.tts_active.set()
                                    self._tts_last_active = time.time()
                                    if tts_start_time["t"] == 0.0:
                                        tts_start_time["t"] = time.time()
                                    # Update far-end playback RMS (EMA) for echo detection
                                    try:
                                        frame_rms = self._rms_int16(pcm)
                                        playback_rms["v"] = (playback_rms["v"] * 0.85) + (frame_rms * 0.15)
                                        self._playback_rms_ema = (self._playback_rms_ema * 0.85) + (frame_rms * 0.15)
                                    except Exception:
                                        pass
                                    last_tts_pcm_time["t"] = time.time()
                                    last_rx_time["t"] = time.time()
                                    # If barge mode is active (user speaking), drop playback to prevent echo
                                    if barge_mode.is_set():
                                        return
                                    # CRITICAL FIX: If suppress_agent_tts is True, don't play Agent audio
                                    # This prevents "two voices" when local TTS is also speaking
                                    if suppress_agent_tts:
                                        return
                                    # DIRECT WRITE to speaker (like avas_voice.py line 286)
                                    try:
                                        speaker_stream.write(pcm)
                                    except Exception:
                                        pass
                            else:
                                msg_type = getattr(message, "type", "Unknown")
                                try:
                                    # Always log messages when debug enabled
                                    if self.cfg.get('debug_asr') or non_audio_ctr["n"] < 12:
                                        payload = getattr(message, "__dict__", None)
                                        s = str(payload) if payload is not None else str(message)
                                        print(f"NON-AUDIO MSG: {msg_type} :: {s[:500]}")
                                        non_audio_ctr["n"] += 1
                                except Exception:
                                    pass

                                # Log UserStartedSpeaking with tts_active state for debugging
                                if msg_type == "UserStartedSpeaking":
                                    print(f"[TTS-CONTROL] UserStartedSpeaking (tts_active={self.tts_active.is_set()})")

                                # Handle errors with provider fallback
                                if msg_type == "Error":
                                    error_code = getattr(message, "code", None)
                                    error_desc = getattr(message, "description", "")
                                    print(f"[agent] ERROR from Deepgram: {error_code} - {error_desc}")

                                    # Check for errors that should trigger provider fallback
                                    should_fallback = False
                                    if error_code in ["INVALID_SETTINGS", "MODEL_ERROR", "QUOTA_EXCEEDED"]:
                                        should_fallback = True
                                    elif "quota" in error_desc.lower() or "limit" in error_desc.lower() or "rate limit" in error_desc.lower():
                                        should_fallback = True

                                    if should_fallback and current_provider_idx["idx"] < len(available_providers) - 1:
                                        # Try next provider
                                        current_provider_idx["idx"] += 1
                                        provider_name, provider_class, model_name = available_providers[current_provider_idx["idx"]]
                                        print(f"[agent] Falling back to {provider_name} ({model_name})...")
                                        settings_obj = build_settings_with_provider(provider_name, provider_class, model_name)
                                        # Close current connection to trigger reconnect with new provider
                                        try:
                                            conn.close()
                                        except Exception:
                                            pass
                                        connection_active.clear()
                                        return
                                    elif should_fallback:
                                        print(f"[agent] No more LLM providers to fall back to.")
                                        # Try switching to local voice engine (Whisper + Edge TTS)
                                        if self._handle_deepgram_quota_error():
                                            connection_active.clear()
                                            return  # Exit to let local engine take over

                                if msg_type == "ConversationText":
                                    last_rx_time["t"] = time.time()  # Track RX for connection watchdog
                                    try:
                                        role = str(getattr(message, 'role', ''))
                                        content = str(getattr(message, 'content', ''))
                                        # Show assistant text as AVA to match heard voice; tools will override with natural result
                                        if role == 'assistant':
                                            print(f"AVA: {content}")
                                        else:
                                            print(f"You: {content}")
                                        # Self-awareness and tools routing: on user text, handle local intents first,
                                        # then try corrected tools via cmpuse Agent; else call AVA server and speak reply
                                        if role == 'user' and content.strip():
                                            tts_token = self._turn_state.mint_tts_token("agent-user-text")
                                            try:
                                                import asyncio
                                                loop = None
                                                try:
                                                    loop = asyncio.get_event_loop()
                                                except Exception:
                                                    loop = None
                                                # Handle self-awareness/intents locally first
                                                handled = False
                                                if loop and loop.is_running():
                                                    fut0 = asyncio.run_coroutine_threadsafe(self._maybe_handle_local_intent(content, turn_id=tts_token), loop)
                                                    handled = bool(fut0.result(timeout=10))
                                                else:
                                                    handled = asyncio.run(self._maybe_handle_local_intent(content, turn_id=tts_token))
                                                if handled:
                                                    return
                                                
                                                # RE-ENABLED: Local tool handling for voice commands
                                                # This routes tool commands directly without waiting for Deepgram FunctionCallRequest
                                                try:
                                                    # Check for destructive actions that need confirmation
                                                    if self.intent_router_enabled and self.intent_router.requires_confirmation(content):
                                                        if not self._check_confirmation(content):
                                                            confirmation_msg = f"Should I {content}? Say 'yes' to confirm or 'no' to cancel."
                                                            print(f"AVA: {confirmation_msg}")
                                                            # Dispatch async _speak_text through event loop (sync context)
                                                            if loop and loop.is_running():
                                                                asyncio.run_coroutine_threadsafe(self._speak_text(confirmation_msg, turn_id=tts_token), loop).result(timeout=30)
                                                            else:
                                                                asyncio.run(self._speak_text(confirmation_msg, turn_id=tts_token))
                                                            return

                                                    # Try local tool dispatch
                                                    tool_result = self._try_tool_dispatch(content)
                                                    if tool_result:
                                                        print(f"AVA: {tool_result}")
                                                        # Dispatch async _speak_text through event loop (sync context)
                                                        if loop and loop.is_running():
                                                            asyncio.run_coroutine_threadsafe(self._speak_text(tool_result, turn_id=tts_token), loop).result(timeout=30)
                                                        else:
                                                            asyncio.run(self._speak_text(tool_result, turn_id=tts_token))
                                                        # Record in session history
                                                        if self.session_manager_enabled and self.voice_session:
                                                            self.voice_session.add_exchange(content, tool_result)
                                                        return
                                                except Exception as tool_err:
                                                    if self.cfg.get('debug_tools'):
                                                        print(f"[tool dispatch error] {tool_err}")
                                                    pass
                                            except Exception:
                                                # On server error, fall back to agent TTS
                                                agent_tts_fallback.set()
                                                pass
                                        # When suppressing agent TTS, skip speaking agent assistant text here.
                                    except Exception:
                                        pass
                                elif msg_type == "AgentText":
                                    # Do not parse or execute tools from AgentText; native FunctionCallRequest is the source of truth
                                    try:
                                        txt = str(getattr(message, 'content', ''))
                                        # Show what the Agent says as AVA for consistency
                                        if txt:
                                            print(f"AVA: {txt}")
                                    except Exception:
                                        pass
                                elif msg_type == "FunctionCallRequest":
                                    # Handle native Deepgram Voice Agent function calls per V1 spec
                                    print(f"[agent] Received FunctionCallRequest!")
                                    try:
                                        funcs_req = getattr(message, 'functions', None)
                                        if not funcs_req and isinstance(message, dict):
                                            funcs_req = message.get('functions')
                                        if not funcs_req:
                                            print("[agent] No functions in FunctionCallRequest")
                                            return

                                        conn = conn_ref.get('conn')
                                        print(f"[agent] Processing {len(funcs_req)} function call(s)")

                                        for f in funcs_req:
                                            try:
                                                # Check client_side flag per Deepgram V1 spec
                                                client_side = getattr(f, 'client_side', None) if hasattr(f, 'client_side') else (f.get('client_side') if isinstance(f, dict) else None)
                                                if client_side is not True:
                                                    print(f"[agent] Skipping function (client_side={client_side})")
                                                    continue

                                                call_id = getattr(f, 'id', None) if hasattr(f, 'id') else (f.get('id') if isinstance(f, dict) else None)
                                                tname = getattr(f, 'name', None) if hasattr(f, 'name') else (f.get('name') if isinstance(f, dict) else None)
                                                arg_str = getattr(f, 'arguments', '{}') if hasattr(f, 'arguments') else (f.get('arguments') if isinstance(f, dict) else '{}')

                                                print(f"[agent] Executing tool: {tname} (id={call_id})")

                                                try:
                                                    targs = json.loads(arg_str) if isinstance(arg_str, str) else (arg_str or {})
                                                except Exception:
                                                    targs = {}

                                                # Execute tool via CMPUSE
                                                res = asyncio.run(self.handle_tool_call(tname, targs))
                                                print(f"[agent] Tool result: {str(res)[:200]}")

                                                # Send FunctionCallResponse with same id and name per V1 spec
                                                payload = {
                                                    "type": "FunctionCallResponse",
                                                    "id": call_id,
                                                    "name": tname,
                                                    "content": json.dumps(res, default=str)
                                                }
                                                try:
                                                    conn.send(json.dumps(payload))
                                                    print(f"[agent] Sent FunctionCallResponse for {tname}")
                                                except Exception as send_ex:
                                                    print(f"[agent] Failed to send response: {send_ex}")
                                            except Exception as func_ex:
                                                print(f"[agent] Error processing function: {func_ex}")
                                        return
                                    except Exception as ex:
                                        print(f"[agent] FunctionCallRequest error: {ex}")
                                elif msg_type == "AgentAudioDone":
                                    print(f"[TTS-CONTROL] AgentAudioDone received, queue size: {agent_audio_queue.qsize()}")
                                    # Current TTS clip finished from Deepgram
                                    # But audio might still be in playback queue
                                    # Start a thread to wait for queue to drain, then clear tts_active
                                    def wait_for_queue_drain():
                                        # Wait for queue to empty
                                        while not agent_audio_queue.empty():
                                            time.sleep(0.05)
                                        # Wait extra 200ms for speaker buffer to drain
                                        time.sleep(0.2)
                                        print(f"[TTS-CONTROL] tts_active CLEAR (queue drained)")
                                        self.tts_active.clear()

                                    threading.Thread(target=wait_for_queue_drain, daemon=True).start()

                                    tts_start_time["t"] = 0.0
                                    playback_rms["v"] = 0.0
                                    self._playback_rms_ema = 0.0
                                    self.user_speaking.clear()
                                    if barge_mode.is_set():
                                        print(f"[BARGE] barge_mode CLEAR (AgentAudioDone)")
                                    barge_mode.clear()
                                    wav_stripper.reset()
                                    agent_tts_fallback.clear()

                        def on_close(close):
                            connection_active.clear(); conn_ref["conn"] = None

                        connection.on(EventType.MESSAGE, on_message)
                        connection.on(EventType.CLOSE, on_close)

                        # Send settings FIRST using proper SDK method (before start_listening)
                        try:
                            # DEBUG: Print exact JSON being sent to verify functions are included
                            try:
                                import json
                                settings_dict = settings_obj.__dict__ if hasattr(settings_obj, '__dict__') else settings_obj
                                # Try to serialize for debugging
                                def obj_to_dict(obj):
                                    if hasattr(obj, '__dict__'):
                                        result = {}
                                        for k, v in obj.__dict__.items():
                                            if isinstance(v, list):
                                                result[k] = [obj_to_dict(item) for item in v]
                                            elif hasattr(v, '__dict__'):
                                                result[k] = obj_to_dict(v)
                                            else:
                                                result[k] = v
                                        return result
                                    return obj
                                settings_json = obj_to_dict(settings_obj)
                                print(f"[agent] SENDING SETTINGS JSON:")
                                print(json.dumps(settings_json, indent=2))
                            except Exception as debug_ex:
                                print(f"[agent] Could not serialize settings for debug: {debug_ex}")

                            connection.send_settings(settings_obj)
                            print("[agent] Settings sent via SDK send_settings()")
                        except Exception as e:
                            print(f"[agent] Failed to send settings: {e}")
                            import traceback
                            traceback.print_exc()

                        # Activate the connection so mic can start sending audio
                        print("[agent] Setting connection_active flag...")
                        connection_active.set()
                        print(f"[agent] connection_active is now: {connection_active.is_set()}")

                        # NOW start listening for responses (this blocks to keep connection alive)
                        print("[agent] Calling start_listening()...")
                        connection.start_listening()
                        print("[agent] Deepgram Agent connected and configured")
                        while connection_active.is_set() and not shutdown.is_set():
                            time.sleep(0.1)
                except Exception as e:
                    error_str = str(e)
                    # Detect quota/payment issues (HTTP 402)
                    if "402" in error_str or "Payment Required" in error_str:
                        print(f"[agent] ⚠️ Deepgram quota exhausted (HTTP 402)")
                        if LOCAL_FALLBACK_AVAILABLE and self.local_voice_engine:
                            print("[agent] Switching to local voice engine (Whisper + Edge TTS)...")
                            self._switch_to_local_voice()
                            # Keep running in local mode
                            while self.running and not shutdown.is_set():
                                time.sleep(0.5)
                            break  # Exit the reconnect loop
                        else:
                            print("[agent] Local fallback not available. Please add Deepgram credits.")
                            print("[agent] Visit: https://console.deepgram.com/billing")
                            break  # Don't keep retrying
                    else:
                        print(f"Agent connection error: {e}. Reconnecting in 3s…")
                    connection_active.clear(); time.sleep(3)
        finally:
            try:
                shutdown.set()
                mic_stream.stop_stream(); mic_stream.close()
                speaker_stream.stop_stream(); speaker_stream.close()
                p.terminate()
            except Exception:
                pass

    async def start_conversation(self):
        """Start the realtime voice conversation"""
        self.running = True

        # Ensure brain server is available if configured to auto-start
        if bool(self.cfg.get('auto_start_server', True)):
            self._ensure_server_started()
            try:
                base = self._server_base()
                status = getattr(self, '_brain_status', 'unknown')
                pid = getattr(self, '_brain_pid', None)
                pid_part = f" (pid {pid})" if (pid and status == 'started') else ''
                print(f"brain={base}  status={status}{pid_part}")
            except Exception:
                pass

        # Unified voice path (local hybrid ASR + server respond + streamed TTS)
        if getattr(self, 'voice_selected', None) == 'unified':
            if not (self.playback_thread and self.playback_thread.is_alive()):
                self.playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
                self.playback_thread.start()
            t = threading.Thread(target=self.run_unified_voice, name="voice_unified", daemon=True)
            t.start()
            try:
                while self.running and t.is_alive():
                    await asyncio.sleep(0.5)
            finally:
                return

        # CHECK DEEPGRAM AVAILABILITY BEFORE STARTING
        # If quota is exhausted, start directly in local mode
        deepgram_available = self._check_deepgram_available()
        if not deepgram_available:
            if LOCAL_FALLBACK_AVAILABLE and self.local_voice_engine:
                print("[startup] ⚡ Deepgram unavailable - starting in LOCAL mode (Whisper + Edge TTS)")
                with self.voice_engine_state.lock:
                    self.voice_engine_state.current = VoiceEngineState.LOCAL
                    self.voice_engine_state.deepgram_available = False
                
                # Start local voice engine
                threading.Thread(target=self.local_voice_engine.run, name="local_voice", daemon=True).start()
                print("[startup] ✅ Local voice engine started")
                
                # Keep running in local mode
                try:
                    while self.running:
                        await asyncio.sleep(0.5)
                except KeyboardInterrupt:
                    print("\n\n👋 Shutting down AVA...")
                finally:
                    self.running = False
                    if self.local_voice_engine:
                        self.local_voice_engine.stop()
                return
            else:
                print("[startup] ⚠️ Deepgram unavailable and no local fallback!")
                print("[startup] Please add Deepgram credits: https://console.deepgram.com/billing")
                print("[startup] Or install local fallback: pip install faster-whisper edge-tts")
                return

        # Ensure audio playback thread only when needed (local TTS mode)
        try:
            vmode = str(self.cfg.get('voice_mode', 'agent')).lower()
            use_local_tts = bool(self.cfg.get('suppress_agent_tts', True))
        except Exception:
            vmode = 'agent'; use_local_tts = True
        if (vmode != 'agent' or use_local_tts):
            if not (self.playback_thread and self.playback_thread.is_alive()):
                self.playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
                self.playback_thread.start()
                print("🔊 Audio playback thread started\n")

        # Prefer Deepgram Agent voice path; returns when agent thread exits
        threading.Thread(target=self._config_watcher, daemon=True).start()
        if str(self.cfg.get('voice_mode','agent')).lower() == 'agent':
            t = threading.Thread(target=self.run_agent_voice, name="agent_voice", daemon=True)
            t.start()
            try:
                while self.running and t.is_alive():
                    await asyncio.sleep(0.5)
            finally:
                return

        # Start config watcher (hot reload)
        threading.Thread(target=self._config_watcher, daemon=True).start()
        await self.connect_asr()
        microphone_task = asyncio.create_task(self.stream_microphone_input())
        events_task = asyncio.create_task(self.asr_receiver())

        try:
            await asyncio.gather(microphone_task, events_task)
        except KeyboardInterrupt:
            print("\n\n👋 Shutting down AVA...")
            self.running = False
            # Signal playback thread to stop
            self.audio_queue.put(None)

    async def run(self):
        """Main run loop"""
        try:
            # Prefer unified local voice when configured
            try:
                vm = (self.cfg.get('voice_mode') if isinstance(self.cfg, dict) else None) or os.getenv('AVA_VOICE_MODE') or ''
            except Exception:
                vm = os.getenv('AVA_VOICE_MODE') or ''
            if vm.lower() == 'unified' or os.getenv('VOICE_UNIFIED','0') == '1':
                print("[voice-unified] Entering unified local voice runner")
                loop = asyncio.get_running_loop()
                # Run blocking unified voice in executor to keep event loop alive
                await loop.run_in_executor(None, self.run_unified_voice)
                return
            # Otherwise fall back to legacy conversation loop (if present)
            await self.start_conversation()
        finally:
            if self.asr_ws:
                await self.asr_ws.close()
            try:
                self.audio.terminate()
            except Exception:
                pass

    async def cleanup(self):
        """Cleanup resources before reconnection"""
        self.running = False

        # Signal playback thread to stop
        if self.audio_queue:
            self.audio_queue.put(None)

        # Wait for playback thread
        if self.playback_thread and self.playback_thread.is_alive():
            self.playback_thread.join(timeout=2)

        # Close websocket
        if self.asr_ws:
            try:
                await self.asr_ws.close()
            except:
                pass

    # ---------------------- Identity & Self-awareness ----------------------
    def _load_identity(self) -> dict:
        try:
            if self.identity_path.exists():
                with open(self.identity_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception:
            pass
        # Defaults
        return {
            "name": "AVA",
            "developer": os.getenv('USERNAME') or os.getenv('USER') or 'User',
            "home": str(Path.home()),
            "location": str(Path(__file__).resolve().parent),
            "purpose": "Personal AI assistant that lives on this laptop.",
        }

    def _uptime_hms(self) -> str:
        dt = int(time.time() - self.started_at)
        h = dt // 3600; m = (dt % 3600) // 60; s = dt % 60
        return f"{h}h {m}m {s}s"

    def _self_status_text(self) -> str:
        idt = self.identity
        lines = []
        lines.append(f"I am {idt.get('name','AVA')}, your assistant developed by {idt.get('developer','you')}.")
        lines.append(f"I run locally on {platform.system()} {platform.release()} in {idt.get('location','my folder')}.")
        lines.append(f"Uptime {self._uptime_hms()}. Mic {MIC_RATE} Hz, TTS {PLAYBACK_RATE} Hz.")
        # Components
        asr_ok = bool(self.asr_ws and self.asr_ws.open)
        lines.append(f"ASR {'connected' if asr_ok else 'disconnected'}. TTS ready.")
        # Metrics
        m = self.metrics
        lines.append(f"ASR msgs {m.get('asr_messages',0)}, finals {m.get('asr_finals',0)}, TTS {m.get('tts_utterances',0)}, reconnects {m.get('reconnects',0)}.")
        le = m.get('last_error','')
        if le:
            lines.append(f"Last error: {le}")
        return " ".join(lines)

    def handle_self_modification(self, action: str, **kwargs) -> dict:
        """Handle self-modification requests
        
        Actions:
        - diagnose: Diagnose the codebase for issues
        - diagnose_error: Diagnose a specific error
        - analyze_file: Analyze a specific file
        - find_function: Find a function in a file
        - propose_fix: Propose a code fix (requires approval)
        - list_pending: List pending modifications
        - approve: Approve a modification
        - reject: Reject a modification
        - rollback: Rollback a modification
        - read_file: Read a core file
        - get_coding_knowledge: Get distilled coding knowledge
        - list_core_files: List all core AVA files
        """
        if not self.self_mod_enabled or not SELF_MOD_AVAILABLE:
            return {"status": "error", "message": "Self-modification system not available"}
        
        try:
            args = {"action": action, **kwargs}
            return self_mod_tool_handler(args)
        except Exception as e:
            return {"status": "error", "message": f"Self-mod error: {e}"}

    def handle_introspection(self, query_type: str = "full") -> dict:
        """Handle self-awareness and introspection queries
        
        Query types:
        - full: Complete self-knowledge dump
        - identity: Just identity info
        - capabilities: Available tools and their status
        - learning: Learned facts, corrections, patterns
        - diagnose: Run self-diagnosis
        - who_am_i: Dynamic self-description
        """
        if not self.self_awareness_enabled or not SELF_AWARENESS_AVAILABLE:
            return {"status": "error", "message": "Self-awareness system not available"}
        
        try:
            if query_type == "full":
                return {"status": "ok", "data": introspect()}
            elif query_type == "identity":
                return {"status": "ok", "data": self.self_awareness.get_identity()}
            elif query_type == "capabilities":
                if getattr(self, 'server_caps', None):
                    return {"status": "ok", "data": self.server_caps}
                return {"status": "ok", "data": {
                    "tools": self.self_awareness.get_available_tools(),
                    "status": self.self_awareness.get_tool_status()
                }}
            elif query_type == "learning":
                return {"status": "ok", "data": {
                    "facts": self.self_awareness.get_learned_facts(),
                    "corrections": self.self_awareness.get_corrections(),
                    "patterns": self.self_awareness.get_patterns(),
                    "preferences": self.self_awareness.get_preferences()
                }}
            elif query_type == "diagnose":
                return {"status": "ok", "data": self_diagnose()}
            elif query_type == "who_am_i":
                if getattr(self, 'server_explain', None) and self.server_explain.get('ok'):
                    who = (self.server_explain.get('who') or {})
                    can = (self.server_explain.get('canDo') or {})
                    desc = (
                        f"I am {who.get('name') or 'AVA'}. "
                        f"I can use {len(can.get('tools') or [])} tools; write={bool(can.get('write'))}; "
                        f"bridge={'healthy' if (can.get('bridgeHealthy')) else 'down'}; "
                        f"LLM={can.get('llmProvider') or 'unknown'}."
                    )
                    return {"status": "ok", "description": desc, "who": who, "can": can}
                return {"status": "ok", "description": who_am_i()}
            elif query_type == "system":
                return {"status": "ok", "data": self.self_awareness.get_system_state()}
            else:
                return {"status": "error", "message": f"Unknown query type: {query_type}"}
        except Exception as e:
            return {"status": "error", "message": f"Introspection error: {e}"}

    def learn_correction(self, user_input: str, wrong: str, correct: str, context: str = "") -> dict:
        """Record a correction to learn from mistakes"""
        if not self.self_awareness_enabled or not SELF_AWARENESS_AVAILABLE:
            return {"status": "error", "message": "Self-awareness system not available"}
        
        try:
            success = learn_from_correction(user_input, wrong, correct, context)
            if success:
                return {"status": "ok", "message": "Correction recorded for future learning"}
            else:
                return {"status": "error", "message": "Failed to record correction"}
        except Exception as e:
            return {"status": "error", "message": f"Learning error: {e}"}

    def record_voice_interaction(self, transcript: str, response: str, helpful: bool = True) -> dict:
        """Record a voice interaction for passive learning"""
        if not self.passive_learning_enabled or not PASSIVE_LEARNING_AVAILABLE:
            return {"status": "skipped", "message": "Passive learning not available"}
        
        try:
            record_interaction(transcript, response, helpful)
            return {"status": "ok", "message": "Interaction recorded"}
        except Exception as e:
            return {"status": "error", "message": f"Recording error: {e}"}

    def get_passive_learning_status(self) -> dict:
        """Get passive learning status and summary"""
        if not self.passive_learning_enabled or not PASSIVE_LEARNING_AVAILABLE:
            return {"status": "disabled", "message": "Passive learning not available"}
        
        try:
            summary = get_learning_summary()
            context = get_passive_context()
            return {
                "status": "active",
                "current_context": context,
                "summary": summary
            }
        except Exception as e:
            return {"status": "error", "message": f"Status error: {e}"}

    def _detect_correction(self, transcript: str) -> bool:
        """Detect if the user is correcting AVA's last response"""
        if not self._last_ava_response:
            return False
        
        lower = transcript.lower().strip()
        
        # Check against correction patterns
        for pattern in self._correction_patterns:
            if re.match(pattern, lower, re.IGNORECASE):
                return True
        
        return False

    def _handle_correction(self, transcript: str) -> None:
        """Handle a detected correction - learn from the mistake"""
        if not self.self_awareness_enabled or not SELF_AWARENESS_AVAILABLE:
            return
        
        if not self._last_user_transcript or not self._last_ava_response:
            return
        
        try:
            # Record the correction for future learning
            learn_from_correction(
                user_input=self._last_user_transcript,
                wrong=self._last_ava_response[:200],  # Truncate for storage
                correct=transcript[:200],
                context=f"User corrected AVA's response"
            )
            print(f"[learning] Recorded correction: '{self._last_user_transcript[:30]}...' → correction noted")
        except Exception as e:
            print(f"[learning] Error recording correction: {e}")

    def _check_past_mistakes(self, transcript: str) -> str:
        """Check if we've made a similar mistake before and get guidance"""
        if not self.self_awareness_enabled or not SELF_AWARENESS_AVAILABLE:
            return ""
        
        try:
            similar = check_past_mistakes(transcript)
            if similar:
                # Return guidance to avoid repeating the mistake
                wrong = similar.get('wrong', '')
                correct = similar.get('correct', '')
                if wrong and correct:
                    return f" NOTE: For similar requests, user previously corrected: don't say '{wrong[:50]}', instead '{correct[:50]}'. "
        except Exception as e:
            pass
        
        return ""

    def _get_enhanced_transcript(self, transcript: str) -> str:
        """Enhance transcript with past mistake context if relevant"""
        guidance = self._check_past_mistakes(transcript)
        if guidance:
            return f"{transcript} [SYSTEM GUIDANCE:{guidance}]"
        return transcript

    def _has_command_verb(self, text: str) -> bool:
        """Check if text contains an explicit command verb from COMMAND_VERBS."""
        if not text:
            return False
        words = text.strip().lower().split()
        return bool(set(words) & self.COMMAND_VERBS)

    def _should_allow_tools(self, transcript: str) -> bool:
        """Policy gate: decide whether tools are allowed for this transcript.

        - Validation mode ON: requires wake word AND command verb
        - Validation mode OFF: requires command verb at minimum
        Returns True if tools should be enabled, False to block them.
        """
        if not transcript:
            return False
        lower = transcript.strip().lower()

        # Always require a command verb
        if not self._has_command_verb(lower):
            return False

        # In validation mode, also require wake word
        if self._validation_mode and self._require_wake_for_tools:
            wake_words = getattr(self, '_wake_words', ['ava', 'eva'])
            normalized = self._normalize_for_wake(lower)
            has_wake = any(normalized.startswith(w) or f" {w}" in normalized for w in wake_words)
            if not has_wake:
                return False

        return True

    # Minimum real words (after stripping wake word) to enter agent loop
    MIN_CONTENT_WORDS = 2

    MIN_CONTENT_WORDS = 2

    def _is_chat_only(self, text: str) -> str | None:
        """Detect conversational transcripts that should NEVER start an agent loop."""
        if not text:
            return None

        import random
        import time as _time
        import re

        def _normalize_words_local(value: str) -> list[str]:
            value = (value or '').lower().strip()
            value = re.sub(r"[^a-z0-9\s]+", " ", value)
            value = re.sub(r"\s+", " ", value).strip()
            return [w for w in value.split() if w]

        def _normalize_text_local(value: str) -> str:
            return ' '.join(_normalize_words_local(value))

        def _wake_phrases_local() -> list[str]:
            phrases = []
            for wake in getattr(self, '_wake_words', ['ava', 'eva']):
                norm = _normalize_text_local(wake)
                if norm:
                    phrases.append(norm)
            return sorted(set(phrases), key=len, reverse=True)

        lower = text.strip().lower()
        clean_words = _normalize_words_local(text)
        word_count = len(clean_words)
        has_command = bool(set(clean_words) & self.COMMAND_VERBS)
        if has_command:
            return None

        wake_phrases = _wake_phrases_local()
        norm_text = _normalize_text_local(text)
        filler_tokens = {'ha', 'huh', 'um', 'uh', 'ah', 'oh', 'hmm', 'hey', 'hi', 'hello', 'yo', 'ok', 'okay'}
        trimmed_words = list(clean_words)
        while trimmed_words and trimmed_words[0] in filler_tokens:
            trimmed_words = trimmed_words[1:]
        trimmed_text = ' '.join(trimmed_words)
        wake_match = None
        for wake_phrase in wake_phrases:
            if norm_text == wake_phrase or norm_text.startswith(wake_phrase + ' ') or trimmed_text == wake_phrase or trimmed_text.startswith(wake_phrase + ' '):
                wake_match = wake_phrase
                break

        remaining_words = list(trimmed_words or clean_words)
        if wake_match:
            wake_len = len(wake_match.split())
            remaining_words = (trimmed_words or clean_words)[wake_len:]
        remaining_words = [w for w in remaining_words if w not in filler_tokens]

        if wake_match and len(remaining_words) < self.MIN_CONTENT_WORDS:
            ack_replies = ["Yeah?", "I'm here.", "Go ahead.", "Listening.", "What's up?"]
            followup_window = float(getattr(self, '_wake_followup_sec', 6.0) or 6.0)
            if followup_window > 0:
                self._wake_followup_until = _time.time() + followup_window
                print(f"[wake-only] Wake word detected, no command content: '{text}' -> silent followup_window={followup_window}s")
                return getattr(self, '_wake_followup_silent_reply', '__AVA_WAKE_FOLLOWUP_SILENT__')
            self._wake_followup_until = 0.0
            print(f"[wake-only] Wake word detected, no command content: '{text}' -> ack only followup_window=0.0s")
            return random.choice(ack_replies)

        greeting_patterns = [
            'hello', 'hi', 'hey', 'howdy', 'greetings', 'good morning',
            'good afternoon', 'good evening', 'good night', 'whats up',
            'sup', 'yo', 'hiya', 'heya',
        ]
        wake_tokens = set(' '.join(wake_phrases).split())
        content_for_greeting = ' '.join(w for w in clean_words if w not in wake_tokens)
        if len(content_for_greeting.split()) <= 3:
            for g in greeting_patterns:
                if content_for_greeting == g or content_for_greeting.startswith(g + ' ') or content_for_greeting.endswith(' ' + g):
                    replies = [
                        "Hey! What can I do for you?",
                        "Hi there! How can I help?",
                        "Hey! I'm listening.",
                        "Hello! What do you need?",
                    ]
                    return random.choice(replies)

        if not has_command:
            query_text = ' '.join(remaining_words or clean_words)
            time_query = any(p in query_text for p in [
                'what time', 'what s the time', 'what is the time',
                'current time', 'the time', 'need the time', 'time is it',
            ])
            if time_query:
                from datetime import datetime
                now = datetime.now().strftime("%-I:%M %p" if os.name != 'nt' else "%#I:%M %p")
                return f"It's {now}."
            date_query = (
                any(p in query_text for p in [
                    'what day', 'what is the date', 'what date', 'today s date',
                    'the date', 'need the date', 'date today', 'date is it',
                    'what is today', 'what s today', 'today is it',
                ])
                or bool(re.search(r"\bwhat\s+(?:is|s)\s+today\b", query_text))
                or bool(re.search(r"\bwhat\s+day\s+(?:is\s+)?(?:it|today)\b", query_text))
            )
            if date_query:
                from datetime import datetime
                today = datetime.now().strftime("%A, %B %-d, %Y" if os.name != 'nt' else "%A, %B %#d, %Y")
                return f"Today is {today}."

        if word_count <= 6 and not has_command:
            if any(p in lower for p in ['how are you', 'how do you do', 'how goes it']):
                return "I'm doing well! How can I help?"
            if any(p in lower for p in ['thank', 'thanks']):
                return "You're welcome!"
            if any(p in lower for p in ['never mind', 'nevermind', 'forget it', 'cancel']):
                return "Okay, no problem."
            if any(p in lower for p in ['who are you', 'what are you', "what's your name", 'your name']):
                return "I'm AVA, your autonomous virtual assistant."
            if any(p in lower for p in ['goodbye', 'bye', 'see you', 'later', 'good night']):
                return "See you later!"
            if lower in ('yes', 'no', 'yeah', 'yep', 'nope', 'nah', 'okay', 'ok', 'sure'):
                return None

        return None

    def _arm_wake_followup_asr_capture(self) -> None:
        try:
            asr_engine = getattr(getattr(self, '_voice_provider', None), 'asr', None)
            if asr_engine and hasattr(asr_engine, 'set_capture_enabled'):
                asr_engine.set_capture_enabled(True)
                print("[wake-followup] ASR capture gate opened for follow-up command")
        except Exception:
            pass

    async def _maybe_handle_local_intent(self, transcript: str, turn_id=None) -> bool:
        """Handle key voice intents locally to keep server-truth consistent"""
        try:
            text = (transcript or '').strip()
            if not text:
                return False
            lower = text.lower()

            # CHAT-FIRST ROUTING: Greetings and simple questions never start agent loops
            chat_reply = self._is_chat_only(text)
            if chat_reply == getattr(self, '_wake_followup_silent_reply', '__AVA_WAKE_FOLLOWUP_SILENT__'):
                print(f"[chat-first] Silent wake follow-up armed (no TTS): '{text}'")
                self._arm_wake_followup_asr_capture()
                return True
            if chat_reply:
                print(f"[chat-first] Direct reply (no agent loop): '{chat_reply}'")
                await self._speak_text(chat_reply, turn_id=turn_id)
                return True

            # Voice approval for apply: require nonce, e.g., "APPLY 4821"
            now = time.time()
            if now < self._pending_apply_until and getattr(self, '_apply_nonce', None):
                # Expect exact phrase APPLY <nonce>
                nonce = str(self._apply_nonce)
                if re.search(rf"\bapply\s+{re.escape(nonce)}\b", lower, re.IGNORECASE):
                    conf = float(getattr(self, '_last_asr_confidence', 1.0) or 1.0)
                    if conf < 0.85:
                        await self._speak_text("I didn't catch that clearly. Please press F10 twice or confirm in the UI.", turn_id=turn_id)
                        return True
                    # Require second factor if confidence is borderline
                    if conf < 0.95:
                        self._apply_hotkey_armed = True
                        self._apply_hotkey_armed_until = time.time() + 10.0
                        await self._speak_text("Second factor required. Press F10 twice or confirm in the UI.", turn_id=turn_id)
                        return True
                    token = f"YES_APPLY_{int(now)}"
                    res = None
                    if getattr(self, 'server_client', None):
                        res = self.server_client.doctor(mode='apply', reason=self._apply_reason or 'voice_apply', confirm_token=token)
                    msg = 'Applied maintenance successfully.' if res and res.get('ok') and not (res.get('applyResult') or {}).get('rolledBack') else 'Apply failed or rolled back.'
                    print(f"[doctor] Voice approval → apply: {msg}")
                    await self._speak_text(msg, turn_id=turn_id)
                    self._pending_apply_until = 0.0
                    self._apply_reason = ''
                    self._apply_nonce = None
                    return True

            # Trigger: doctor propose
            if any(kw in lower for kw in ['maintenance report', 'run doctor', 'start doctor', 'run maintenance', 'doctor report']):
                res = None
                if getattr(self, 'server_client', None):
                    res = self.server_client.doctor(mode='propose', reason='voice_propose')
                ok = bool(res and res.get('ok'))
                msg = 'Maintenance report generated.' if ok else 'Maintenance request failed.'
                print(f"[doctor] Voice propose: {msg}")
                await self._speak_text(msg, turn_id=turn_id)
                return True

            # Trigger: doctor apply (ask for confirmation)
            if any(w in lower for w in ['apply maintenance', 'apply doctor', 'approve maintenance', 'approve doctor', 'apply changes', 'apply patches']):
                self._pending_apply_until = time.time() + 25.0
                self._apply_reason = 'voice_apply'
                self._apply_nonce = random.randint(1000, 9999)
                prompt = f"To confirm, say: APPLY {self._apply_nonce}."
                print("[doctor] Awaiting voice confirmation with nonce for apply...")
                await self._speak_text(prompt, turn_id=turn_id)
                return True

            # Trigger: brain reconnect
            if any(p in lower for p in ['reconnect brain', 'connect to server', 'retry server', 'retry brain']):
                try:
                    self._ensure_server_started()
                    status = getattr(self, '_brain_status', 'unknown')
                    await self._speak_text('Brain reconnected.' if status in ('up','started') else 'Brain still unreachable. Running voice only.', turn_id=turn_id)
                except Exception as e:
                    print(f"[server] Reconnect error: {e}")
                    await self._speak_text('Could not reconnect to brain.', turn_id=turn_id)
                return True

            # Capability/identity short-hands
            if any(p in lower for p in ['what can you do', 'what are you capable of', 'your capabilities']):
                if getattr(self, 'server_caps', None):
                    tools = self.server_caps.get('tools') if isinstance(self.server_caps, dict) else []
                    reply = f"I currently have {len(tools or [])} tools available."
                    await self._speak_text(reply, turn_id=turn_id)
                    return True
            if any(p in lower for p in ['who are you', 'what are you']):
                if getattr(self, 'server_explain', None) and self.server_explain.get('ok'):
                    who = (self.server_explain.get('who') or {})
                    can = (self.server_explain.get('canDo') or {})
                    reply = (
                        f"I am {who.get('name') or 'AVA'}. "
                        f"LLM {can.get('llmProvider') or 'unknown'}, bridge is {'healthy' if can.get('bridgeHealthy') else 'down'}."
                    )
                    await self._speak_text(reply, turn_id=turn_id)
                    return True

            # NEW: Intent router for classified commands
            if self.intent_router_enabled:
                try:
                    intent = self.intent_router.classify_intent(text)
                    if intent:
                        # Handle specific intents that need special processing
                        if intent == 'self_awareness':
                            # Let the server handle self-awareness with full context
                            return False  # Return False to let server respond
                        
                        # Extract entities for better tool calling
                        entities = self.intent_router.extract_entities(text, intent)
                        if entities and self.cfg.get('debug_agent'):
                            print(f"[intent] Classified as '{intent}' with entities: {entities}")
                        
                        # For most intents, let the tool dispatch handle it
                        # But we've added context so the server knows the intent
                except Exception as e:
                    if self.cfg.get('debug_agent'):
                        print(f"[intent] Router error: {e}")

            return False
        except Exception as e:
            print(f"[intent] Local intent error: {e}")
            return False


async def main():
    """Entry point with auto-restart"""
    reconnect_count = 0

    while True:
        try:
            print("\n" + "=" * 80)
            if reconnect_count > 0:
                print(f"🔄 Reconnecting to AVA (attempt #{reconnect_count + 1})...")
            print("=" * 80 + "\n")

            ava = StandaloneRealtimeAVA()
            await ava.run()

            # If we get here without exception, it was a clean shutdown
            break

        except WS_ClosedOK as e:
            # Session expired (60 minute limit)
            print("\n" + "=" * 80)
            print("⏰ Session expired (60-minute limit reached)")
            print("🔄 Auto-restarting AVA in 3 seconds...")
            print("=" * 80)
            reconnect_count += 1

            # Cleanup
            try:
                await ava.cleanup()
            except:
                pass

            # Wait before reconnecting
            await asyncio.sleep(3)

        except WS_ClosedError as e:
            # Connection lost unexpectedly
            print("\n" + "=" * 80)
            print(f"⚠️  Connection lost: {e}")
            print("🔄 Auto-restarting AVA in 5 seconds...")
            print("=" * 80)
            reconnect_count += 1

            # Cleanup
            try:
                await ava.cleanup()
            except:
                pass

            # Wait before reconnecting
            await asyncio.sleep(5)

        except KeyboardInterrupt:
            print("\n\n👋 Shutting down AVA...")
            try:
                await ava.cleanup()
            except:
                pass
            break

        except Exception as e:
            print(f"\n❌ Unexpected error: {e}")
            print("🔄 Attempting to restart in 10 seconds...")
            reconnect_count += 1

            try:
                await ava.cleanup()
            except:
                pass

            await asyncio.sleep(10)
    print("\n" + "=" * 80)
    print("AVA Standalone ended")
    print("=" * 80)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Goodbye!")
VOICE_UNIFIED = os.getenv("VOICE_UNIFIED", "0") == "1"
