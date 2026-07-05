#!/usr/bin/env python3
"""
prepare_data.py — consolidate the JSONL that AVA's harness collected into clean train/val files.

Inputs (produced live by trainingCollector.js, plus optional distilled pairs):
  <logs>/training/dpo.jsonl          {prompt, chosen, rejected, tags}
  <logs>/training/sft.jsonl          {messages:[{user},{assistant}], tags}
  <logs>/training/distilled.jsonl    (optional) same shape as dpo.jsonl, from distill_backfill.py

Outputs (in --out, default ./data):
  dpo_train.jsonl / dpo_val.jsonl    columns: prompt, chosen, rejected     (for TRL DPOTrainer)
  sft_train.jsonl                    columns: messages (chat)              (for SFT)

Usage:
  python prepare_data.py --logs /path/to/ava-server/logs --out ./data
"""
import argparse, json, os, random, hashlib

SYS = ("You are AVA's decision engine. For the user's request, respond with EXACTLY ONE JSON "
       "object and no prose: {\"decision\":\"tool_call\",\"tool\":\"<name>\",\"args\":{...}} to use a "
       "tool, or {\"decision\":\"stop\",\"result\":\"<answer>\",\"success\":true} to answer directly. "
       "You DO have tools for 3D generation (model3d_ops), image editing (image_ops), tab switching "
       "(window_ops focus_tab) and more — never claim you can't.")


def _read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
    return out


def _key(*parts):
    return hashlib.sha1("".join(str(p) for p in parts).encode("utf-8", "ignore")).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", required=True, help="path to ava-server/logs")
    ap.add_argument("--out", default="./data")
    ap.add_argument("--val_frac", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    tdir = os.path.join(args.logs, "training")

    # ---- DPO pairs ----
    dpo = _read_jsonl(os.path.join(tdir, "dpo.jsonl")) + _read_jsonl(os.path.join(tdir, "distilled.jsonl"))
    seen, dpo_rows = set(), []
    for r in dpo:
        prompt, chosen, rejected = r.get("prompt"), r.get("chosen"), r.get("rejected")
        if not (prompt and chosen and rejected):
            continue
        if str(chosen).strip() == str(rejected).strip():
            continue
        k = _key(prompt, chosen, rejected)
        if k in seen:
            continue
        seen.add(k)
        dpo_rows.append({"prompt": str(prompt), "chosen": str(chosen), "rejected": str(rejected)})

    # ---- SFT positives (goal -> correct tool_call) ----
    sft = _read_jsonl(os.path.join(tdir, "sft.jsonl"))
    seen2, sft_rows = set(), []
    for r in sft:
        msgs = r.get("messages") or []
        if len(msgs) < 2:
            continue
        user = next((m.get("content") for m in msgs if m.get("role") == "user"), None)
        asst = next((m.get("content") for m in msgs if m.get("role") == "assistant"), None)
        if not (user and asst):
            continue
        k = _key(user, asst)
        if k in seen2:
            continue
        seen2.add(k)
        sft_rows.append({"messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": str(user)},
            {"role": "assistant", "content": str(asst)},
        ]})

    random.seed(args.seed)
    random.shuffle(dpo_rows)
    n_val = max(1, int(len(dpo_rows) * args.val_frac)) if dpo_rows else 0
    dpo_val, dpo_train = dpo_rows[:n_val], dpo_rows[n_val:]

    def _write(name, rows):
        with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    _write("dpo_train.jsonl", dpo_train)
    _write("dpo_val.jsonl", dpo_val)
    _write("sft_train.jsonl", sft_rows)

    print(json.dumps({
        "dpo_train": len(dpo_train), "dpo_val": len(dpo_val), "sft_train": len(sft_rows),
        "out": os.path.abspath(args.out),
        "hint": "If dpo_train is small, run distill_backfill.py to generate 'chosen' sides for the "
                "denials/leaks already in your conversation logs, then re-run this.",
    }, indent=2))


if __name__ == "__main__":
    main()
