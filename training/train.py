#!/usr/bin/env python3
"""
train.py — QLoRA SFT then DPO on qwen2.5-coder-7b-instruct, then export a GGUF for LM Studio.
Runs on a single 24GB GPU (RTX 4090) via unsloth. Run on the Vast.ai box — NOT on the home PC.

  python train.py --data ./data --stage both --gguf_out ./ava-decider-gguf

Stages:
  sft   — teach the exact decision JSON format + tool vocabulary (from sft_train.jsonl)
  dpo   — teach "call the tool, don't deny/leak" (from dpo_train.jsonl preference pairs)
  both  — sft then dpo (recommended)
  gguf  — just export the current adapter to GGUF (after training)

Version note: pinned in requirements.txt. TRL's SFTConfig/DPOConfig arg names drift between minor
versions; if you hit a kwarg error, check `trl` version and adjust the two *Config(...) blocks.
"""
import argparse, os

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="unsloth/Qwen2.5-Coder-7B-Instruct")  # unsloth 4-bit-ready name
    ap.add_argument("--data", default="./data")
    ap.add_argument("--stage", choices=["sft", "dpo", "both", "gguf"], default="both")
    ap.add_argument("--max_seq", type=int, default=4096)
    ap.add_argument("--sft_epochs", type=float, default=2.0)
    ap.add_argument("--dpo_epochs", type=float, default=1.0)
    ap.add_argument("--sft_lr", type=float, default=2e-4)
    ap.add_argument("--dpo_lr", type=float, default=5e-6)
    ap.add_argument("--dpo_beta", type=float, default=0.1)
    ap.add_argument("--gguf_out", default="./ava-decider-gguf")
    ap.add_argument("--gguf_quant", default="q4_k_m")
    ap.add_argument("--adapter_out", default="./ava-decider-lora")
    args = ap.parse_args()

    from unsloth import FastLanguageModel, PatchDPOTrainer
    PatchDPOTrainer()  # enables ref-free DPO with the LoRA base as implicit reference
    import torch
    from datasets import load_dataset

    bf16 = torch.cuda.is_bf16_supported()
    fp16 = not bf16

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base, max_seq_length=args.max_seq, load_in_4bit=True, dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=32, lora_dropout=0.0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=13,
    )

    # ---------- SFT ----------
    if args.stage in ("sft", "both"):
        from trl import SFTTrainer, SFTConfig
        ds = load_dataset("json", data_files=os.path.join(args.data, "sft_train.jsonl"))["train"]

        def _fmt(ex):
            ex["text"] = tokenizer.apply_chat_template(ex["messages"], tokenize=False,
                                                       add_generation_prompt=False)
            return ex
        ds = ds.map(_fmt)
        sft = SFTTrainer(
            model=model, tokenizer=tokenizer, train_dataset=ds,
            args=SFTConfig(
                dataset_text_field="text", max_seq_length=args.max_seq,
                per_device_train_batch_size=2, gradient_accumulation_steps=8,
                num_train_epochs=args.sft_epochs, learning_rate=args.sft_lr,
                warmup_steps=5, logging_steps=10, optim="adamw_8bit", weight_decay=0.01,
                lr_scheduler_type="linear", seed=13, bf16=bf16, fp16=fp16, output_dir="out_sft",
            ),
        )
        sft.train()
        print("[train] SFT done")

    # ---------- DPO ----------
    if args.stage in ("dpo", "both"):
        from trl import DPOTrainer, DPOConfig
        ds = load_dataset("json", data_files=os.path.join(args.data, "dpo_train.jsonl"))["train"]
        val_path = os.path.join(args.data, "dpo_val.jsonl")
        val = load_dataset("json", data_files=val_path)["train"] if os.path.exists(val_path) and os.path.getsize(val_path) > 2 else None
        dpo = DPOTrainer(
            model=model, ref_model=None, tokenizer=tokenizer,
            train_dataset=ds, eval_dataset=val,
            args=DPOConfig(
                beta=args.dpo_beta, max_length=args.max_seq, max_prompt_length=args.max_seq // 2,
                per_device_train_batch_size=1, gradient_accumulation_steps=8,
                num_train_epochs=args.dpo_epochs, learning_rate=args.dpo_lr,
                warmup_steps=5, logging_steps=10, optim="adamw_8bit", weight_decay=0.0,
                lr_scheduler_type="linear", seed=13, bf16=bf16, fp16=fp16, output_dir="out_dpo",
            ),
        )
        dpo.train()
        print("[train] DPO done")

    # ---------- save adapter + export GGUF ----------
    model.save_pretrained(args.adapter_out)
    tokenizer.save_pretrained(args.adapter_out)
    print(f"[train] LoRA adapter saved to {args.adapter_out}")

    # One-line GGUF export (merges LoRA + converts + quantizes). Drop the .gguf into LM Studio.
    model.save_pretrained_gguf(args.gguf_out, tokenizer, quantization_method=args.gguf_quant)
    print(f"[train] GGUF ({args.gguf_quant}) written to {args.gguf_out} — copy it to LM Studio's models folder")


if __name__ == "__main__":
    main()
