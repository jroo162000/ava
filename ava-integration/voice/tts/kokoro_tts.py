"""KokoroTTS — local Kokoro-82M engine with TRUE per-phoneme viseme timing.

Why: Piper's duration predictor is sealed inside its onnx graph, so lip-sync
timing there is estimated. Kokoro's KPipeline exposes `pred_dur` (one duration
frame-count per input phoneme, 40 frames/sec) and misaki gives the exact
phoneme string per word token — so the viseme timeline here is measured, not
guessed. Emitted through the same `on_timeline` hook the runner wires to
tts.visemes.

Interface-compatible with PiperBinTTS: speak(text, on_chunk, frame_ms),
current_sample_rate, warmup, cancel_current_utterance, stop. Extra:
`supports_visemes = True` and speak(..., on_timeline=fn) where fn(events, total_ms)
fires after synthesis, before the first audio frame.

Revert: AVA_TTS_KOKORO=0 in the environment makes the runner skip this engine
and fall straight back to Piper. First init downloads ~330MB from Hugging Face
(hexgrad/Kokoro-82M) into the HF cache; run scripts/kokoro_warmup.py once.
"""

import os
import threading
from typing import Callable, List, Optional

# Misaki US phoneme -> viseme index. Alphabet: index-paired with
# voice/visemes.py VISEMES (sil PP FF TH DD KK CH SS RR AA E IH OH OU).
# Misaki US_VOCAB: AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ
MISAKI_TO_VISEME = {
    # diphthongs (uppercase misaki)
    'A': 10,  # eI  -> E
    'I': 9,   # aI  -> AA
    'O': 12,  # oU  -> OH
    'W': 12,  # aU  -> OH
    'Y': 12,  # OI  -> OH
    'Q': 12,  # GB oU
    # vowels
    'a': 9, 'æ': 9, 'ɑ': 9, 'ʌ': 9,          # open -> AA
    'ɔ': 12, 'ɒ': 12,                          # rounded open -> OH
    'ə': 10, 'ɛ': 10, 'ɜ': 10, 'ᵊ': 10,       # mid -> E
    'i': 11, 'ɪ': 11, 'ᵻ': 11,                 # spread -> IH
    'u': 13, 'ʊ': 13,                          # round -> OU
    # consonants
    'b': 1, 'p': 1, 'm': 1,                    # PP
    'f': 2, 'v': 2,                            # FF
    'θ': 3, 'ð': 3,                            # TH
    'd': 4, 't': 4, 'n': 4, 'l': 4, 'ɾ': 4,   # DD
    'k': 5, 'ɡ': 5, 'ŋ': 5,                    # KK
    'ʃ': 6, 'ʒ': 6, 'ʤ': 6, 'ʧ': 6,           # CH
    's': 7, 'z': 7,                            # SS
    'ɹ': 8,                                    # RR
    'w': 13,                                   # OU
    'j': 11,                                   # IH
    'h': 0, 'ʔ': 0,                            # neutral
    # stress marks / length: no mouth shape of their own (dur folds into next)
    'ˈ': None, 'ˌ': None, 'ː': None,
}

_HALF_FRAME_MS = 12.5   # pred_dur is 40 frames/sec; join_timestamps counts half-frames


def phoneme_events(tokens, pred_dur, offset_ms: float = 0.0):
    """Walk Kokoro's per-phoneme durations into [[ms, viseme_idx], ...].

    Mirrors KPipeline.join_timestamps' accounting exactly (bos frame, per-token
    phoneme spans, whitespace halved across both sides) but keeps PER-PHONEME
    boundaries instead of collapsing to word start/end.
    """
    events = []
    if tokens is None or pred_dur is None or len(pred_dur) < 3:
        return events
    pd = [int(x) for x in pred_dur]
    left = right = 2 * max(0, pd[0] - 3)
    i = 1
    for t in tokens:
        if i >= len(pd) - 1:
            break
        ph = getattr(t, 'phonemes', None) or ''
        ws = bool(getattr(t, 'whitespace', ''))
        if not ph:
            if ws:
                i += 1
                if i < len(pd):
                    left = right + pd[i]
                    right = left + pd[i]
                i += 1
            continue
        j = i + len(ph)
        if j >= len(pd):
            break
        hf = float(left)
        for k, ch in enumerate(ph):
            vis = MISAKI_TO_VISEME.get(ch, None)
            if vis is not None:
                events.append([offset_ms + hf * _HALF_FRAME_MS, vis])
            hf += 2.0 * pd[i + k]
        # silence at word end (space/punct gap)
        events.append([offset_ms + hf * _HALF_FRAME_MS, 0])
        space = pd[j] if ws else 0
        left = right + 2 * sum(pd[i:j]) + space
        right = left + space
        i = j + (1 if ws else 0)
    return events


def _dedupe(events):
    """Round to ints, drop repeats and zero-length predecessors."""
    out = []
    for t, v in events:
        ti = int(round(t))
        if out and out[-1][1] == v:
            continue
        if out and out[-1][0] >= ti:
            out[-1][1] = v
            continue
        out.append([ti, v])
    if not out:
        out = [[0, 0]]
    elif out[0][0] > 0 and out[0][1] != 0:
        out.insert(0, [0, 0])
    return out


class KokoroTTS:
    engine = "kokoro"
    name = "kokoro"
    supports_visemes = True

    def __init__(self, voice: Optional[str] = None, lang_code: str = "a") -> None:
        from kokoro import KPipeline  # heavy: torch + model download on first use
        self.voice = voice or os.environ.get("AVA_KOKORO_VOICE", "af_heart")
        self.current_sample_rate = 24000
        self._cancel = threading.Event()
        self._speak_lock = threading.Lock()
        self.pipeline = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M")

    def warmup(self, timeout: float = 30.0) -> bool:
        try:
            for _ in self.pipeline("Hi.", voice=self.voice):
                pass
            return True
        except Exception:
            return False

    def synthesize(self, text: str) -> Optional[dict]:
        """Full synthesis WITHOUT playback: {'pcm', 'events', 'total_ms'} or None.
        Split out so the runner can PIPELINE — synthesize sentence N+1 in a
        background thread while sentence N is still playing. Checks (but does
        not clear) the cancel flag so a barge-in aborts prefetch too."""
        if not text:
            return None
        import numpy as np
        pcm_parts = []
        events = []
        offset_ms = 0.0
        try:
            for result in self.pipeline(text, voice=self.voice):
                if self._cancel.is_set():
                    return None
                audio = result.audio
                if audio is None:
                    continue
                a = audio.detach().cpu().numpy().astype('float32')
                # Kokoro synthesizes ~5x quieter than Piper; peak-normalize so
                # speaker volume and the UI amplitude envelope stay consistent.
                peak = float(np.max(np.abs(a))) if a.size else 0.0
                if peak > 0.02:
                    a = a * (0.85 / peak)
                pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype('<i2').tobytes()
                try:
                    events.extend(phoneme_events(result.tokens, result.pred_dur, offset_ms))
                except Exception:
                    pass  # timeline is telemetry; audio must not fail on it
                offset_ms += len(a) / self.current_sample_rate * 1000.0
                pcm_parts.append(pcm)
        except Exception:
            if not pcm_parts:
                raise  # let the runner's engine fallback handle a dead engine
        if self._cancel.is_set() or not pcm_parts:
            return None
        return {"pcm": b"".join(pcm_parts), "events": _dedupe(events), "total_ms": int(round(offset_ms))}

    def play(self, prepared: dict, on_chunk: Callable[[bytes], None],
             frame_ms: Optional[int] = None,
             on_timeline: Optional[Callable[[List[list], int], None]] = None) -> None:
        """Emit the (already exact) timeline, then stream the prepared PCM."""
        if not prepared or not prepared.get("pcm"):
            return
        with self._speak_lock:
            frame_ms = max(20, min(int(frame_ms or 100), 200))
            spf = max(int(self.current_sample_rate * (frame_ms / 1000.0)), 1)
            frame_bytes = spf * 2
            if on_timeline is not None:
                try:
                    on_timeline(prepared.get("events") or [], int(prepared.get("total_ms") or 0))
                except Exception:
                    pass
            buf = prepared["pcm"]
            pad = (-len(buf)) % frame_bytes
            if pad:
                buf += b"\x00" * pad
            for k in range(0, len(buf), frame_bytes):
                if self._cancel.is_set():
                    return
                on_chunk(buf[k:k + frame_bytes])

    def speak(self, text: str, on_chunk: Callable[[bytes], None],
              frame_ms: Optional[int] = None,
              on_timeline: Optional[Callable[[List[list], int], None]] = None) -> None:
        """Synthesize then play. The runner's streaming path prefers the split
        synthesize()/play() pair (pipelined); this stays for the blocking path."""
        self._cancel.clear()
        prepared = self.synthesize(text)
        if prepared:
            self.play(prepared, on_chunk, frame_ms, on_timeline)

    def cancel_current_utterance(self) -> None:
        self._cancel.set()

    def stop(self) -> None:
        self._cancel.set()
