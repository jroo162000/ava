"""Text -> viseme timeline for lip sync (phoneme-class visemes, zero deps).

AVA's TTS (Piper) doesn't expose per-phoneme timings, so this module estimates
them: a compact grapheme->viseme scan (digraphs first) assigns each mouth shape
a duration weight; weights are scaled to milliseconds by a calibratable
ms-per-unit rate (the voice runner measures each chunk's REAL audio duration
after synthesis and feeds an EMA back in, so estimates self-tune within a
session). Consumed by Core3D.jsx, which schedules the shapes against the
tts.level amplitude envelope — amplitude still gates intensity, so timing drift
degrades gracefully instead of flapping a silent mouth.

Viseme alphabet (index = wire format, keep in sync with Core3D VISEME_MAP):
  0 sil   silence / pause
  1 PP    p b m        (lips pressed)
  2 FF    f v          (lower lip to teeth)
  3 TH    th           (tongue tip)
  4 DD    d t n l      (tongue ridge)
  5 KK    k g c q      (back of tongue)
  6 CH    ch j sh zh   (rounded-forward)
  7 SS    s z x        (teeth together)
  8 RR    r            (rounded slight)
  9 AA    a            (open)
 10 E     e ai ay      (mid-open spread)
 11 IH    i ee y       (spread smile-ish)
 12 OH    o ow oi      (rounded open)
 13 OU    u oo w wh    (tight round/pucker)
"""

VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'KK', 'CH', 'SS', 'RR', 'AA',
           'E', 'IH', 'OH', 'OU']
_IDX = {v: i for i, v in enumerate(VISEMES)}

# duration weights (relative units)
_W_VOWEL = 1.6
_W_DIPH = 2.1
_W_CONS = 0.7
_W_GAP = 0.6     # between words
_W_COMMA = 2.6
_W_STOP = 4.5    # . ! ? :

# digraphs / trigraphs first (longest match wins)
_MULTI = {
    'tch': ('CH', _W_CONS), 'sh': ('CH', _W_CONS), 'ch': ('CH', _W_CONS),
    'th': ('TH', _W_CONS), 'ph': ('FF', _W_CONS), 'wh': ('OU', _W_CONS),
    'ng': ('KK', _W_CONS), 'qu': ('KK', _W_CONS),
    'oo': ('OU', _W_DIPH), 'ou': ('OU', _W_DIPH), 'ew': ('OU', _W_DIPH),
    'ue': ('OU', _W_DIPH), 'ui': ('OU', _W_DIPH),
    'ee': ('IH', _W_DIPH), 'ea': ('IH', _W_DIPH), 'ey': ('IH', _W_DIPH),
    'ie': ('IH', _W_DIPH),
    'ai': ('E', _W_DIPH), 'ay': ('E', _W_DIPH), 'ei': ('E', _W_DIPH),
    'oi': ('OH', _W_DIPH), 'oy': ('OH', _W_DIPH),
    'ow': ('OH', _W_DIPH), 'oa': ('OH', _W_DIPH),
    'au': ('AA', _W_DIPH), 'aw': ('AA', _W_DIPH),
}
_SINGLE = {
    'a': ('AA', _W_VOWEL), 'e': ('E', _W_VOWEL), 'i': ('IH', _W_VOWEL),
    'o': ('OH', _W_VOWEL), 'u': ('OU', _W_VOWEL), 'y': ('IH', _W_VOWEL),
    'p': ('PP', _W_CONS), 'b': ('PP', _W_CONS), 'm': ('PP', _W_CONS),
    'f': ('FF', _W_CONS), 'v': ('FF', _W_CONS),
    'w': ('OU', _W_CONS), 'r': ('RR', _W_CONS),
    's': ('SS', _W_CONS), 'z': ('SS', _W_CONS), 'x': ('SS', _W_CONS),
    'd': ('DD', _W_CONS), 't': ('DD', _W_CONS), 'n': ('DD', _W_CONS),
    'l': ('DD', _W_CONS),
    'k': ('KK', _W_CONS), 'g': ('KK', _W_CONS), 'c': ('KK', _W_CONS),
    'q': ('KK', _W_CONS), 'j': ('CH', _W_CONS),
    # h shapes the mouth barely at all; treat as a very short neutral
    'h': ('sil', _W_CONS * 0.5),
}
_VOWELS = set('aeiouy')

DEFAULT_MS_PER_UNIT = 62.0   # ~Piper lessac-medium at default rate; runner calibrates


def _word_visemes(word):
    """Yield (viseme, weight) for one lowercase alphabetic word."""
    out = []
    i = 0
    n = len(word)
    while i < n:
        # silent trailing 'e' ("time", "close") — skip unless it's the only vowel
        if (word[i] == 'e' and i == n - 1 and n > 3
                and any(ch in _VOWELS for ch in word[:i])):
            i += 1
            continue
        hit = None
        for ln in (3, 2):
            seg = word[i:i + ln]
            if len(seg) == ln and seg in _MULTI:
                hit = _MULTI[seg]
                i += ln
                break
        if hit is None:
            ch = word[i]
            # soft c: "ce", "ci", "cy" -> SS
            if ch == 'c' and i + 1 < n and word[i + 1] in 'eiy':
                hit = ('SS', _W_CONS)
            else:
                hit = _SINGLE.get(ch)
            i += 1
        if hit is None:
            continue
        # collapse immediate repeats ("ll", "ss" already handled by scan order)
        if out and out[-1][0] == hit[0]:
            out[-1] = (hit[0], out[-1][1] + hit[1] * 0.4)
        else:
            out.append(list(hit) if isinstance(hit, tuple) else hit)
            out[-1] = (hit[0], hit[1])
    return out


def viseme_timeline(text, ms_per_unit=None):
    """Build [[offset_ms, viseme_index], ...] + estimated total ms for `text`.

    Returns (events, est_ms). Events always start with [0, 0] (sil) and are
    strictly increasing in time. Numbers/symbols contribute word gaps only —
    the runner speaks pre-normalized text, so digits are rare.
    """
    rate = float(ms_per_unit or DEFAULT_MS_PER_UNIT)
    seq = [('sil', 0.0)]
    word = ''
    for ch in (text or '').lower() + ' ':
        if ch.isalpha() or ch == "'":
            if ch != "'":
                word += ch
            continue
        if word:
            seq.extend(_word_visemes(word))
            word = ''
        if ch in '.!?:;':
            if seq[-1][0] == 'sil':
                seq[-1] = ('sil', seq[-1][1] + _W_STOP)
            else:
                seq.append(('sil', _W_STOP))
        elif ch == ',':
            if seq[-1][0] == 'sil':
                seq[-1] = ('sil', seq[-1][1] + _W_COMMA)
            else:
                seq.append(('sil', _W_COMMA))
        elif ch == ' ':
            if seq[-1][0] != 'sil':
                seq.append(('sil', _W_GAP))
    events = []
    t = 0.0
    for vis, wgt in seq:
        idx = _IDX[vis]
        if events and events[-1][1] == idx:
            t += wgt * rate
            continue
        ti = int(round(t))
        if events and events[-1][0] == ti:
            events[-1][1] = idx          # zero-duration predecessor: replace
        else:
            events.append([ti, idx])
        t += wgt * rate
    est_ms = int(round(t))
    return events, est_ms


def calibrate(prev_rate, est_ms, actual_ms, alpha=0.35):
    """EMA update of ms-per-unit given a chunk's estimated vs measured duration.
    Clamped to a sane band so one bad measurement can't wreck the next chunk."""
    if est_ms <= 0 or actual_ms <= 0 or prev_rate <= 0:
        return prev_rate
    scale = actual_ms