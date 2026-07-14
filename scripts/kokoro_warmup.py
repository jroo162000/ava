"""One-time Kokoro warmup + benchmark for AVA's voice runner.

Downloads hexgrad/Kokoro-82M (and misaki's spacy model) into the caches the
runner will use, then measures cold/warm synthesis RTF on THIS machine so we
know whether Kokoro is fast enough to be the primary engine. Writes results to
the repository's logs directory (ASCII only).
"""
import sys
import time
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "logs" / "kokoro_warmup_result.txt"


def log(msg):
    print(msg, flush=True)
    with open(OUT, "a", encoding="ascii", errors="replace") as fh:
        fh.write(msg + "\n")


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    open(OUT, "w").close()
    log("== kokoro warmup ==")
    t0 = time.time()
    try:
        from kokoro import KPipeline
    except Exception as exc:
        log("IMPORT_FAIL " + repr(exc))
        return 1
    log("import ok %.1fs" % (time.time() - t0))

    t0 = time.time()
    try:
        pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    except Exception as exc:
        log("PIPELINE_FAIL " + repr(exc))
        return 1
    log("pipeline built %.1fs (includes model download on first run)" % (time.time() - t0))

    texts = [
        "Hello Jelani, this is a warmup sentence.",
        "The quick brown fox jumps over the lazy dog, and everybody sees the difference.",
    ]
    total_audio = 0.0
    total_synth = 0.0
    for i, txt in enumerate(texts):
        t0 = time.time()
        try:
            audio_s = 0.0
            ts_sample = None
            for r in pipe(txt, voice="af_heart"):
                if r.audio is not None:
                    audio_s += float(len(r.audio)) / 24000.0
                if ts_sample is None and r.tokens:
                    tk = [t for t in r.tokens if getattr(t, "start_ts", None) is not None]
                    if tk:
                        ts_sample = [(t.text, round(t.start_ts, 2), round(t.end_ts, 2)) for t in tk[:4]]
            dt = time.time() - t0
            total_audio += audio_s
            total_synth += dt
            log("synth %d: %.2fs audio in %.2fs (RTF %.2f) tokens_ts=%s" % (i, audio_s, dt, dt / max(audio_s, 0.01), ts_sample))
        except Exception as exc:
            log("SYNTH_FAIL %d %r" % (i, exc))
            return 1
    rtf = total_synth / max(total_audio, 0.01)
    log("WARM_RTF %.2f" % rtf)
    log("VERDICT " + ("OK" if rtf < 1.0 else "SLOW (consider AVA_TTS_KOKORO=0)"))
    log("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
