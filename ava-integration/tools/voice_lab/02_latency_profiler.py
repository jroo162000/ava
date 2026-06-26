"""Voice Lab tool: 02_latency_profiler.py

Objective, repeatable latency reporting for AVa.

Two input modes:
  1) JSONL produced by AVa when AVA_LATENCY_LOG is set.
  2) Plaintext logs containing lines like:
       [latency] asr=12ms llm=340ms tts_synth=220ms playback=950ms total=1522ms

Usage (recommended):
  - Set AVA_LATENCY_LOG to a file path while running AVa, e.g.:
      set AVA_LATENCY_LOG=C:\\ava\\latency.jsonl
  - Then run:
      python tools/voice_lab/02_latency_profiler.py --input C:\\ava\\latency.jsonl

This prints p50/p90/p95/p99 plus min/mean/max for each stage.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
from dataclasses import dataclass
from typing import Iterable, List, Dict, Optional, Tuple


LAT_RE = re.compile(
    r"\[latency\]\s+asr=(?P<asr>\d+)ms\s+llm=(?P<llm>\d+)ms\s+tts_synth=(?P<tts_synth>\d+)ms\s+playback=(?P<playback>\d+)ms\s+total=(?P<total>\d+)ms"
)


@dataclass
class Rec:
    asr_ms: int
    llm_ms: int
    tts_synth_ms: int
    playback_ms: int
    total_ms: int
    ts: Optional[float] = None


def _percentile(sorted_vals: List[float], p: float) -> float:
    """Linear interpolation percentile, p in [0,100]."""
    if not sorted_vals:
        return float('nan')
    if p <= 0:
        return float(sorted_vals[0])
    if p >= 100:
        return float(sorted_vals[-1])
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(sorted_vals[int(k)])
    d0 = sorted_vals[f] * (c - k)
    d1 = sorted_vals[c] * (k - f)
    return float(d0 + d1)


def _load_jsonl(path: str) -> List[Rec]:
    out: List[Rec] = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            # Accept either our canonical keys or older variants.
            try:
                out.append(
                    Rec(
                        asr_ms=int(o.get('asr_ms', 0) or 0),
                        llm_ms=int(o.get('llm_ms', 0) or 0),
                        tts_synth_ms=int(o.get('tts_synth_ms', 0) or 0),
                        playback_ms=int(o.get('playback_ms', 0) or 0),
                        total_ms=int(o.get('total_ms', 0) or 0),
                        ts=float(o.get('ts')) if o.get('ts') is not None else None,
                    )
                )
            except Exception:
                continue
    return out


def _load_text(path: str) -> List[Rec]:
    out: List[Rec] = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            m = LAT_RE.search(line)
            if not m:
                continue
            out.append(
                Rec(
                    asr_ms=int(m.group('asr')),
                    llm_ms=int(m.group('llm')),
                    tts_synth_ms=int(m.group('tts_synth')),
                    playback_ms=int(m.group('playback')),
                    total_ms=int(m.group('total')),
                    ts=None,
                )
            )
    return out


def _basic_stats(vals: List[int]) -> Dict[str, float]:
    if not vals:
        return {"n": 0}
    s = sorted(float(v) for v in vals)
    mean = float(statistics.mean(s))
    return {
        "n": float(len(s)),
        "min": float(s[0]),
        "p50": _percentile(s, 50),
        "p90": _percentile(s, 90),
        "p95": _percentile(s, 95),
        "p99": _percentile(s, 99),
        "mean": mean,
        "max": float(s[-1]),
    }


def _fmt_ms(x: float) -> str:
    if math.isnan(x):
        return "nan"
    return f"{x:.0f}ms"


def _render_report(recs: List[Rec]) -> Tuple[str, Dict[str, Dict[str, float]]]:
    asr = [r.asr_ms for r in recs if r.asr_ms >= 0]
    llm = [r.llm_ms for r in recs if r.llm_ms >= 0]
    tts = [r.tts_synth_ms for r in recs if r.tts_synth_ms >= 0]
    pb = [r.playback_ms for r in recs if r.playback_ms >= 0]
    total = [r.total_ms for r in recs if r.total_ms >= 0]

    stats = {
        "asr_ms": _basic_stats(asr),
        "llm_ms": _basic_stats(llm),
        "tts_synth_ms": _basic_stats(tts),
        "playback_ms": _basic_stats(pb),
        "total_ms": _basic_stats(total),
    }

    lines: List[str] = []
    lines.append(f"samples: {len(recs)}")
    lines.append("")

    def line(name: str, key: str) -> None:
        s = stats[key]
        if s.get('n', 0) == 0:
            lines.append(f"{name:<12}  (no data)")
            return
        lines.append(
            f"{name:<12}  min { _fmt_ms(s['min']) }  "
            f"p50 { _fmt_ms(s['p50']) }  p90 { _fmt_ms(s['p90']) }  "
            f"p95 { _fmt_ms(s['p95']) }  p99 { _fmt_ms(s['p99']) }  "
            f"mean { _fmt_ms(s['mean']) }  max { _fmt_ms(s['max']) }"
        )

    line("ASR", "asr_ms")
    line("LLM", "llm_ms")
    line("TTS synth", "tts_synth_ms")
    line("Playback", "playback_ms")
    line("TOTAL", "total_ms")

    return "\n".join(lines), stats


def main() -> int:
    ap = argparse.ArgumentParser(description="AVa Voice Lab latency profiler")
    ap.add_argument(
        "--input",
        default=os.environ.get("AVA_LATENCY_LOG", "").strip() or "latency.jsonl",
        help="Path to JSONL latency log (recommended) OR plaintext log containing [latency] lines.",
    )
    ap.add_argument(
        "--mode",
        choices=["auto", "jsonl", "text"],
        default="auto",
        help="Input mode. auto tries JSONL first then falls back to text parsing.",
    )
    ap.add_argument(
        "--last",
        type=int,
        default=0,
        help="Only analyze the last N samples (0 = all).",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="Also print machine-readable JSON stats.",
    )
    ap.add_argument(
        "--out",
        default="",
        help="Optional path to write the human report to a file.",
    )
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f"Input not found: {args.input}")
        return 2

    recs: List[Rec] = []
    if args.mode in ("auto", "jsonl"):
        try:
            recs = _load_jsonl(args.input)
        except Exception:
            recs = []
        if args.mode == "jsonl" and not recs:
            print("No JSONL records parsed. Check the file format.")
            return 3

    if args.mode in ("auto", "text") and not recs:
        try:
            recs = _load_text(args.input)
        except Exception:
            recs = []
        if args.mode == "text" and not recs:
            print("No [latency] lines parsed. Check the file.")
            return 4

    if args.last and args.last > 0:
        recs = recs[-args.last :]

    report, stats = _render_report(recs)
    print(report)
    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(stats, indent=2, sort_keys=True))

    if args.out:
        try:
            if os.path.dirname(args.out):
                os.makedirs(os.path.dirname(args.out), exist_ok=True)
            with open(args.out, 'w', encoding='utf-8') as f:
                f.write(report + "\n")
        except Exception as e:
            print(f"Failed to write report: {e}")
            return 5

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
