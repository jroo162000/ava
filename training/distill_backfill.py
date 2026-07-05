#!/usr/bin/env python3
"""
distill_backfill.py — front-load the DPO set from history.

Your conversation logs already contain ~dozens of WRONG assistant replies (denials, leaks, empty
promises) — the 'rejected' side. This script pairs each with the preceding user request and asks a
STRONG model (OpenAI or Anthropic) for the CORRECT decision JSON — the 'chosen' side — writing
preference pairs to <logs>/training/distilled.jsonl so prepare_data.py can fold them in.

Run wherever you have a funded strong-model key (locally or on the VM):
  OPENAI_API_KEY=...  python distill_backfill.py --logs /path/to/ava-server/logs --provider openai
  ANTHROPIC_API_KEY=. python distill_backfill.py --logs /path/to/ava-server/logs --provider anthropic
"""
import argparse, glob, json, os, re, time

TOOLS = ("model3d_ops(action=generate|from_image), image_ops(action=generate|edit), "
         "window_ops(action=focus_tab|focus|list), computer_use(action=click_text|click_target|type|hotkey), "
         "open_item, browser_automation, app_control, vision_ops, screen_ops, fs_read, fs_find, "
         "comm_ops, calendar_ops, memory_search, scene3d, web_search")

DENIAL = re.compile(r"\b(i can'?t|i cannot|i'?m (not able|unable)|do ?n'?t have (a|the|any|the ability)|no tool (that|to)|not able to (open|show|display|generate|create|make|build|run|edit)|don'?t have a way to)\b", re.I)
LEAK = re.compile(r'<\/?(?:model3d_ops|scene3d|image_ops|window_ops|computer_use|open_item)\b|"decision"\s*:\s*"tool_call"', re.I)
PROMISE = re.compile(r"\b(let me (go |now |just )?(get|do|open|generate|create|make|build|run)|i'?ll (get|do|open|generate|create|make|build|run)|(searching|generating|creating|building|opening) (it|that|now))\b", re.I)

INSTR = ("You are AVA's decision engine. AVA has these tools: {tools}. The user made a request and a "
         "WEAK assistant answered WRONGLY (it denied a capability, leaked a raw tool call, or promised "
         "without doing). Output the CORRECT response as EXACTLY ONE JSON object and nothing else: "
         "{{\"decision\":\"tool_call\",\"tool\":\"<name>\",\"args\":{{...}}}} if a tool should run, or "
         "{{\"decision\":\"stop\",\"result\":\"<short answer>\",\"success\":true}} if it's genuine chit-chat. "
         "Prefer calling the obvious tool. User request: {user}\nWeak (wrong) answer: {bad}")


def _strong(provider, prompt):
    if provider == "openai":
        from openai import OpenAI
        c = OpenAI()
        r = c.chat.completions.create(model=os.getenv("DISTILL_MODEL", "gpt-4o"),
                                      messages=[{"role": "user", "content": prompt}],
                                      temperature=0.1, response_format={"type": "json_object"})
        return r.choices[0].message.content
    else:
        from anthropic import Anthropic
        c = Anthropic()
        r = c.messages.create(model=os.getenv("DISTILL_MODEL", "claude-3-5-sonnet-latest"),
                              max_tokens=500, messages=[{"role": "user", "content": prompt}])
        return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", required=True)
    ap.add_argument("--provider", choices=["openai", "anthropic"], default="openai")
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--sleep", type=float, default=0.4)
    args = ap.parse_args()
    conv_dir = os.path.join(args.logs, "conversations")
    out_path = os.path.join(args.logs, "training", "distilled.jsonl")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # collect (user_request, bad_reply) pairs
    pairs, last_user = [], ""
    for f in sorted(glob.glob(os.path.join(conv_dir, "conversation-*.jsonl"))):
        for ln in open(f, encoding="utf-8", errors="ignore"):
            ln = ln.strip()
            if not ln:
                continue
            try:
                o = json.loads(ln)
            except Exception:
                continue
            c = str(o.get("content", ""))
            if o.get("direction") == "user":
                last_user = c
            elif o.get("direction") == "assistant" and last_user:
                if LEAK.search(c) or DENIAL.search(c) or PROMISE.search(c):
                    tag = "tool_leak" if LEAK.search(c) else ("false_denial" if DENIAL.search(c) else "empty_promise")
                    pairs.append((last_user, c, tag))

    pairs = pairs[: args.limit]
    written = 0
    with open(out_path, "a", encoding="utf-8") as out:
        for user, bad, tag in pairs:
            try:
                chosen = _strong(args.provider, INSTR.format(tools=TOOLS, user=user[:600], bad=bad[:500]))
                chosen = chosen.strip()
                json.loads(chosen)  # validate it's JSON; skip if not
            except Exception:
                continue
            out.write(json.dumps({"prompt": user, "chosen": chosen, "rejected": bad[:800],
                                  "tags": [tag, "distilled"]}, ensure_ascii=False) + "\n")
            written += 1
            time.sleep(args.sleep)
    print(json.dumps({"candidates": len(pairs), "written": written, "out": out_path}, indent=2))


if __name__ == "__main__":
    main()
