from __future__ import annotations

import re
from typing import List


_SENT_SPLIT = re.compile(r"(?<=[\.!\?])\s+")


def chunk_text_for_tts(
    text: str,
    *,
    max_words: int = 6,
    max_chars: int = 60,
    min_words: int = 3,
) -> List[str]:
    """Split a long response into small, speakable chunks.

    Goal: reduce time-to-first-audio for bursted local TTS like Piper.exe.
    """
    if not text:
        return []

    normalized = " ".join(text.strip().split())
    if not normalized:
        return []

    parts = _SENT_SPLIT.split(normalized)
    out: List[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue

        words = part.split()
        if len(words) <= max_words and len(part) <= max_chars:
            out.append(part)
            continue

        current: List[str] = []
        for word in words:
            current.append(word)
            if len(current) >= max_words or len(" ".join(current)) >= max_chars:
                out.append(" ".join(current).strip())
                current = []
        if current:
            out.append(" ".join(current).strip())

    merged: List[str] = []
    for chunk in out:
        word_count = len(chunk.split())
        if merged and word_count < max(1, min_words):
            merged[-1] = (merged[-1] + " " + chunk).strip()
        else:
            merged.append(chunk)
    return merged
