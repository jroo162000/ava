#!/usr/bin/env python3
"""
smoke_test.py — quick sanity check that training worked, before you bring the model home.
Loads the trained adapter and runs the exact actions AVA kept failing on; prints a one-line
result the runner captures into MANIFEST.json. Good sign: "N/N valid JSON, 0 denials".

  python smoke_test.py --adapter ./ava-decider-lora
"""
import argparse, json, re

SYS = ("You are AVA's decision engine. For the user's request, respond with EXACTLY ONE JSON "
       "object and no prose: {\"decision\":\"tool_call\",\"tool\":\"<name>\",\"args\":{...}} to use a "
       "tool, or {\"decision\":\"stop\",\"result\":\"<answer>\",\"success\":true} to answer directly. "
       "You DO have tools for 3D generation (model3d_ops), image editing (image_ops), tab switching "
       "(window_ops focus_tab) and more — never claim you can't.")

TESTS = [
    "make a brand new 3D model of a red sports car",
    "switch to the ava hologram tab in edge",
    "give her longer hair in the 3d holo ava image in downloads",
    "generate an image of a mountain at sunrise",
]
DENY = re.compile(r"\b(i can'?t|i cannot|do ?n'?t have (a|the|any).*(tool|way|ability)|no tool)\b", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--base", default="unsloth/Qwen2.5-Coder-7B-Instruct")
    args = ap.parse_args()

    from unsloth import FastLanguageModel
    model, tok = FastLanguageModel.from_pretrained(args.adapter, max_seq_length=4096, load_in_4bit=True)
    FastLanguageModel.for_inference(model)

    ok = deny = 0
    for t in TESTS:
        msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": t}]
        ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, return_tensors="pt").to(model.device)
        out = model.generate(input_ids=ids, max_new_tokens=200, do_sample=False, temperature=0.0)
        txt = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()
        m = re.search(r"\{.*\}", txt, re.S)
        if m:
            try:
                json.loads(m.group(0)); ok += 1
            except Exception:
                pass
        if DENY.search(txt):
            deny += 1
    print(f"{ok}/{len(TESTS)} valid JSON, {deny} denials")


if __name__ == "__main__":
    main()
