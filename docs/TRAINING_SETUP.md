# Training the local LLM from AVA's own corrections

AVA's harness is now a **training-data generator**. Every time a guard corrects the weak model,
we log what it did wrong (`rejected`) and the right output (`chosen`). Every verified-good tool
call is logged as a positive example. Feed that to a LoRA fine-tune and the local model learns to
stop denying capabilities, stop leaking raw tool calls, and emit the exact decision format.

## What gets collected (automatically, from live use)

- `ava-server/logs/training/dpo.jsonl` — preference pairs `{prompt, chosen, rejected, tags}` for
  **DPO/ORPO**. Sources: false-capability-denial guard, tool-command-leak escalation, empty-promise
  escalation. Tags: `false_denial`, `tool_leak`, `empty_promise`.
- `ava-server/logs/training/sft.jsonl` — `{messages:[user, assistant]}` for **SFT**. Source: every
  tool call whose result was OK (a verified `goal -> correct tool_call` example).

Toggle with `AVA_TRAIN_COLLECT=0`. Check growth anytime:
`node ava-server/scripts/estimate_training.mjs` (also scans old conversation logs for recoverable pairs).

## How much data, and how long

Baseline from 9 days of logs: ~100 assistant turns/day, ~10 correction-eligible events/day, and 88
"wrong output" examples already recoverable from history.

- **SFT set (~300–500 verified-good turns)** — fills in **a few days**; successes are frequent.
- **DPO set (~300 pairs, minimum useful)** — **~2–3 weeks** organic, or **~1–2 days** if you
  front-load (below). ~1000 pairs (solid) is ~3 months organic.
- **Front-load:** (1) the 88 historical `rejected` outputs already in your logs just need their
  `chosen` side — run one **distillation** pass: send each to a strong model (Claude/GPT-4o) asking
  for the correct decision JSON, save as pairs. (2) Generate synthetic requests + correct calls with
  a strong model. Together you can hit a trainable set in a day or two instead of weeks.

Note: as the guards + fixes reduce failures, the DPO *failure* rate naturally drops (good problem) —
so distillation, not waiting, is the fast path.

## Connecting your GPU VM — two modes

You do **not** upload the quantized GGUF you run in LM Studio. Train on the base model's original
FP16 weights, then bring the trained adapter back and convert to GGUF.

### Mode A — serve the model ON the VM (recommended if the VM stays up)
Run inference on the GPU VM and point AVA at it over the network. Fast inference *and* you train on
the same box.
1. On the VM, serve an OpenAI-compatible endpoint: `vllm serve Qwen/Qwen2.5-Coder-7B-Instruct`
   (or LM Studio / llama.cpp `server`), exposing `http://<vm-ip>:8000/v1` (or `:1234/v1`).
2. On this PC, in `ava-integration/.env`:
   `AVA_LOCAL_LLM_URL=http://<vm-ip>:8000/v1` and `AVA_LOCAL_LLM_MODEL=<served model id>`.
   (AVA already reads these; restart the backend.) Use a LAN IP or a VPN/SSH tunnel, not the public internet.

### Mode B — train on the VM, run locally
Keep inference local (LM Studio), use the VM only to train.
1. Copy the dataset up: `scp ava-server/logs/training/*.jsonl user@vm:/data/`
2. Get the FP16 base from HuggingFace on the VM: `huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct`
3. Bring the adapter back: `scp user@vm:/out/adapter.gguf ...` into LM Studio's models folder.

## Training (LoRA SFT → DPO), on the VM

Easiest stack is **unsloth** (fast, low-VRAM; a 7B LoRA fits in ~12–16GB):

```bash
pip install "unsloth[cu121] @ git+https://github.com/unslothai/unsloth.git" trl peft
```

1. **SFT first** (teach the format + tool vocabulary) on `sft.jsonl` — 1–3 epochs, LoRA r=16.
2. **DPO second** (teach "call the tool, don't deny/leak") on `dpo.jsonl` — TRL `DPOTrainer`,
   beta≈0.1, 1 epoch. Each row maps `prompt/chosen/rejected` directly.
3. Base model: use the SAME base you run locally (`Qwen2.5-Coder-7B-Instruct` is a good pick — it's
   strong at structured/function-calling output; that's the decision task).

## Deploy the trained model

1. Merge the LoRA into the base (unsloth `save_pretrained_merged`), or keep it as an adapter.
2. Convert to GGUF for LM Studio: `python llama.cpp/convert_hf_to_gguf.py <merged_dir> --outfile ava-decider.gguf`
   then quantize: `llama.cpp/llama-quantize ava-decider.gguf ava-decider-Q4_K_M.gguf Q4_K_M`.
3. Drop it in LM Studio's models folder, load it, and set `AVA_LOCAL_LLM_MODEL` to its id. Restart.

## Already shipped alongside this (no training needed)

- **JSON-mode constrained decoding** on the local decision calls (`response_format: json_object`)
  so the local model can't emit prose/malformed/leaky decisions — structural, on CPU.
- **Few-shot exemplars** in the decision prompt for the actions the model kept refusing (3D, image
  edit, tab switch).
- The **false-denial guard**, **tool-leak escalation+scrub**, and **router fix** that both correct
  behavior live *and* generate the training pairs above.
