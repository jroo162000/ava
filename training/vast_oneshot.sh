#!/usr/bin/env bash
# ============================================================================
# AVA local-model training — STANDALONE ONE-SHOT Vast.ai job.
# Rent a fresh RTX 4090 (24GB), copy this training/ folder + your ava-server/logs
# next to it, then: bash vast_oneshot.sh
# It provisions, trains SFT->DPO->GGUF, smoke-tests, writes MANIFEST.json, and (only
# if you opt in) stops the instance. Download the .gguf, then DESTROY the box.
#
# No secrets are printed. Nothing calls AVA. It does NOT touch your router or the
# inference brains — it's an isolated training job.
#
# Optional env:
#   LOGS_DIR=/path/to/ava-server/logs   (default ./logs)
#   BASE=unsloth/Qwen2.5-Coder-7B-Instruct
#   AUTO_STOP=1 VAST_API_KEY=... VAST_INSTANCE_ID=...   (self-stop when finished)
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="${LOGS_DIR:-$HERE/logs}"
WORK="${WORK:-$HERE}"
BASE="${BASE:-unsloth/Qwen2.5-Coder-7B-Instruct}"
OUT_GGUF="${OUT_GGUF:-$WORK/ava-decider-gguf}"
ADAPTER="${ADAPTER:-$WORK/ava-decider-lora}"
RUN_LOG="$WORK/run.log"
MANIFEST="$WORK/MANIFEST.json"
SMOKE_RESULT="not-run"
: > "$RUN_LOG"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$RUN_LOG"; }

write_manifest() {  # $1 = status
  local gpu; gpu="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo unknown)"
  STATUS="$1" GPU="$gpu" BASE="$BASE" OUT_GGUF="$OUT_GGUF" MANIFEST="$MANIFEST" SMOKE_RESULT="$SMOKE_RESULT" \
  python3 - <<'PY'
import json, os, glob
ggufs = glob.glob(os.path.join(os.environ["OUT_GGUF"], "*.gguf"))
m = {
  "status": os.environ["STATUS"],
  "gpu": os.environ.get("GPU", "unknown"),
  "vast_instance_id": os.environ.get("VAST_INSTANCE_ID", "unset"),
  "base_model": os.environ["BASE"],
  "gguf": ggufs[0] if ggufs else None,
  "gguf_size_mb": round(os.path.getsize(ggufs[0]) / 1e6, 1) if ggufs else None,
  "smoke_test": os.environ.get("SMOKE_RESULT", "not-run"),
}
json.dump(m, open(os.environ["MANIFEST"], "w"), indent=2)
print(json.dumps(m, indent=2))
PY
}

maybe_stop() {
  if [ "${AUTO_STOP:-0}" = "1" ] && [ -n "${VAST_API_KEY:-}" ] && [ -n "${VAST_INSTANCE_ID:-}" ]; then
    log "auto-stop: stopping Vast instance ${VAST_INSTANCE_ID}"
    pip -q install --upgrade vastai >>"$RUN_LOG" 2>&1 || true
    VAST_API_KEY="$VAST_API_KEY" vastai stop instance "$VAST_INSTANCE_ID" >>"$RUN_LOG" 2>&1 \
      || log "auto-stop FAILED — stop the instance manually so you don't keep paying."
  else
    log "auto-stop off — download the GGUF, then DESTROY the instance manually."
  fi
}

on_err() { log "ERROR at line ${1} (exit ${2})"; write_manifest "failed" || true; maybe_stop || true; exit 1; }
trap 'on_err "$LINENO" "$?"' ERR

# ---- pipeline ----
log "== AVA one-shot training on $(hostname) =="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee -a "$RUN_LOG" || true

log "installing deps (first run pulls unsloth/torch; a few minutes)"
pip -q install -r "$HERE/requirements.txt" >>"$RUN_LOG" 2>&1

log "preparing train/val from ${LOGS_DIR}"
python3 "$HERE/prepare_data.py" --logs "$LOGS_DIR" --out "$WORK/data" | tee -a "$RUN_LOG"

log "training SFT -> DPO -> GGUF (base=${BASE}) — ~1-3h"
python3 "$HERE/train.py" --base "$BASE" --data "$WORK/data" --stage both \
  --gguf_out "$OUT_GGUF" --adapter_out "$ADAPTER" 2>&1 | tee -a "$RUN_LOG"

log "smoke-testing the trained adapter"
if SMOKE_RESULT="$(python3 "$HERE/smoke_test.py" --adapter "$ADAPTER" --base "$BASE" 2>>"$RUN_LOG")"; then
  log "smoke: ${SMOKE_RESULT}"
else
  SMOKE_RESULT="test-error"; log "smoke test errored (non-fatal) — see run.log"
fi

write_manifest "done"
log "DONE. GGUF: ${OUT_GGUF}  |  Manifest: ${MANIFEST}"
log "Next: scp the .gguf home, load it in LM Studio, set AVA_LOCAL_LLM_MODEL, then DESTROY this box."
maybe_stop
