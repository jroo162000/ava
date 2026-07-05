# AVA local-LLM training kit (Vast.ai → LM Studio)

Trains `qwen2.5-coder-7b-instruct` on the data AVA's guards collect, then gives you a GGUF to run
locally in LM Studio. Everything below runs on a **Vast.ai GPU box**; only the final GGUF comes home.

Your setup: base = **qwen2.5-coder-7b-instruct**, run **locally in LM Studio**, GPU = **1× RTX 4090
(24GB)**, as a **standalone one-shot Vast job** (this is isolated from your router / inference brains —
it never calls AVA and never touches Hostinger).

---

## Quick path — one-shot (recommended)
1. Rent a fresh RTX 4090 on Vast (details in §0 below).
2. From your PC, copy the kit + data up:
   ```bash
   scp -P <port> -r "ava/training" "ava-server/logs" <user>@<vast-ip>:/workspace/
   ```
3. On the box, run the whole pipeline with one command:
   ```bash
   cd /workspace/training && LOGS_DIR=/workspace/logs bash vast_oneshot.sh
   ```
   It installs deps → prepares data → SFT→DPO→GGUF → smoke-tests → writes `MANIFEST.json`.
   (Add `OPENAI_API_KEY=... python distill_backfill.py --logs /workspace/logs` first if you want to
   front-load the DPO data — see §3.)
4. When it prints `DONE`, `scp` the `.gguf` home, then **destroy the instance**. Deploy in LM Studio (§7).
   - Want it to stop itself when finished? run with `AUTO_STOP=1 VAST_API_KEY=... VAST_INSTANCE_ID=...`.

The manual step-by-step below is the same thing unpacked, if you'd rather run each stage yourself.

---

## 0. Rent the GPU (Vast.ai)
- **GPU:** 1× RTX 4090 (24GB) — filter for it. (3090 24GB also fine, just slower.)
- **Image:** a PyTorch 2.3 / CUDA 12.1 template, e.g. `pytorch/pytorch:2.3.1-cuda12.1-cudnn8-devel`
  or Vast's "PyTorch" recommended image.
- **Disk:** 60 GB (base weights + checkpoints + GGUF).
- Note the SSH command Vast gives you.

## 1. Get the data + kit onto the box
On your PC, the dataset lives at `ava-server/logs/training/` and the conversation history at
`ava-server/logs/conversations/`. Copy both + this `training/` folder up:
```bash
scp -P <port> -r "ava-server/logs" <user>@<vast-ip>:/workspace/logs
scp -P <port> -r "ava/training"     <user>@<vast-ip>:/workspace/training
```
(rclone or the HuggingFace Hub work too if you prefer.)

## 2. Install (on the box)
```bash
cd /workspace/training
pip install -r requirements.txt
```

## 3. (Optional but recommended) Front-load the DPO set
Your logs already hold ~dozens of wrong replies (the "rejected" side). Generate the "chosen" side
with a strong model so you don't wait weeks for organic data:
```bash
OPENAI_API_KEY=sk-...  python distill_backfill.py --logs /workspace/logs --provider openai
# or: ANTHROPIC_API_KEY=...  python distill_backfill.py --logs /workspace/logs --provider anthropic
```

## 4. Build the train/val files
```bash
python prepare_data.py --logs /workspace/logs --out ./data
# prints dpo_train / dpo_val / sft_train counts. If dpo_train is thin, run step 3 first.
```

## 5. Train (SFT → DPO → GGUF), ~1–3 h on a 4090
```bash
python train.py --data ./data --stage both --gguf_out ./ava-decider-gguf
```
Produces `./ava-decider-gguf/*.gguf` (Q4_K_M) and a LoRA adapter in `./ava-decider-lora`.

## 6. Bring the GGUF home
```bash
scp -P <port> <user>@<vast-ip>:/workspace/training/ava-decider-gguf/*.gguf .
```
Then **destroy the Vast instance** so you stop paying.

## 7. Deploy in LM Studio + point AVA at it
1. Put the `.gguf` in LM Studio's models folder (LM Studio → My Models → open folder).
2. Load it; note its model id (e.g. `ava-decider`).
3. In `ava-integration/.env`: `AVA_LOCAL_LLM_MODEL=ava-decider` (keep `AVA_LOCAL_LLM_URL` pointing at
   your local LM Studio, `http://localhost:1234/v1`).
4. Restart the AVA backend. Done — the decision model is now your fine-tune.

## Retraining later
Data keeps accumulating in `logs/training/` from normal use. Re-copy, re-run steps 4–7 whenever you
want a fresher model. Each pass makes the local model deny/leak less, which (nice problem) slows new
failure-pair collection — so keep some distillation in the loop.

## Notes
- CPU-only home box → inference of a 7B in LM Studio is slow (tens of seconds). That's the trade for
  privacy + zero ongoing cost. If you later want speed, this same GGUF/adapter serves fine on any GPU.
- TRL's config kwargs drift between minor versions; requirements.txt pins compatible ones. If a
  `*Config(...)` kwarg errors, check the installed `trl` version and adjust those two blocks in train.py.
