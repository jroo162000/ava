#!/usr/bin/env node
// Scans the existing conversation logs to estimate how much training data is already recoverable
// and the daily collection rate, so we can project when the DPO/SFT set will be big enough.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const CONV_DIR = path.resolve(_dir, '..', 'logs', 'conversations');
const TRAIN_DIR = path.resolve(_dir, '..', 'logs', 'training');

const TOOL_NAMES = /(model3d_ops|scene3d|image_ops|window_ops|computer_use|open_item|browser_automation|app_control|vision_ops|screen_ops|web_builder|comm_ops|fs_ops|fs_read|fs_find|memory_search)/i;
const DENIAL = /\b(i can'?t|i cannot|i'?m (not able|unable)|do ?n'?t have (a|the|any|the ability)|no tool (that|to)|not able to (open|show|display|generate|create|make|build|run|edit)|don'?t have a way to)\b/i;
const LEAK = new RegExp('<\\/?(?:' + TOOL_NAMES.source.slice(1, -1) + ')\\b|"decision"\\s*:\\s*"tool_call"|<action>\\s*\\w+\\s*<\\/action>', 'i');
const PROMISE = /\b(let me (go |now |just )?(get|do|open|generate|create|make|build|run|search|check|pull)|i'?ll (get|do|open|generate|create|make|build|run|search|check|pull)|(searching|generating|creating|building|opening|checking|pulling) (it|that|this|now))\b/i;

let assistantTurns = 0, denials = 0, leaks = 0, promises = 0;
const days = new Set();
let minT = Infinity, maxT = -Infinity;

let files = [];
try { files = fs.readdirSync(CONV_DIR).filter((f) => /^conversation-.*\.jsonl$/.test(f)); } catch { }
for (const f of files) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(CONV_DIR, f), 'utf8').split('\n'); } catch { continue; }
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if ((o.direction || '') !== 'assistant') continue;
    const c = String(o.content || '');
    assistantTurns++;
    if (o.timestamp) { const t = Date.parse(o.timestamp); if (!isNaN(t)) { minT = Math.min(minT, t); maxT = Math.max(maxT, t); days.add(new Date(t).toISOString().slice(0, 10)); } }
    if (LEAK.test(c)) leaks++;
    else if (DENIAL.test(c)) denials++;
    else if (PROMISE.test(c)) promises++;
  }
}

const recoverableRejected = denials + leaks + promises;   // "rejected" side is already in the logs
const spanDays = Math.max(1, (maxT - minT) / 86400000);
const activeDays = Math.max(1, days.size);
const perDay = recoverableRejected / activeDays;

let collected = { dpo: 0, sft: 0 };
try { collected.dpo = fs.readFileSync(path.join(TRAIN_DIR, 'dpo.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length; } catch { }
try { collected.sft = fs.readFileSync(path.join(TRAIN_DIR, 'sft.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length; } catch { }

const daysTo = (target) => perDay > 0 ? Math.ceil(Math.max(0, target - recoverableRejected) / perDay) : Infinity;

console.log(JSON.stringify({
  conversation_files: files.length,
  assistant_turns_scanned: assistantTurns,
  recoverable_now: { denials, leaks, promises, total_rejected_side: recoverableRejected },
  note_rejected_vs_pairs: 'These are the REJECTED (wrong) outputs already in your logs. A full DPO pair also needs the CHOSEN (right) output — the live collector captures both going forward; historical rejected sides get their CHOSEN via a strong-model distillation pass.',
  active_days_observed: activeDays,
  span_days: Math.round(spanDays * 10) / 10,
  rejected_events_per_active_day: Math.round(perDay * 10) / 10,
  already_collected_by_live_logger: collected,
  projection_days_to_reach: {
    '300_pairs (minimum useful DPO)': daysTo(300),
    '1000_pairs (solid)': daysTo(1000),
  },
}, null, 2));
