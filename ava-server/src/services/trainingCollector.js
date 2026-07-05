/**
 * trainingCollector.js — turns the harness's own corrections into training data.
 *
 * Every time a guard fires (false-capability-denial, tool-command leak, empty promise) we KNOW
 * what the weak model did wrong (rejected) AND what the right output was (chosen). Every time an
 * action verifiably lands, we KNOW a good (prompt -> tool_call) example. This module appends those
 * as JSONL so a DPO/SFT dataset accumulates from normal use, ready to LoRA-train a local model.
 *
 *   logs/training/dpo.jsonl  — {prompt, chosen, rejected, tags, meta}   (preference pairs, for DPO/ORPO)
 *   logs/training/sft.jsonl  — {messages:[...], tags, meta}             (verified-good turns, for SFT)
 *
 * Off by default-safe: set AVA_TRAIN_COLLECT=0 to disable. Never throws into the caller.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const TRAIN_DIR = path.resolve(_dir, '..', '..', 'logs', 'training');
const DPO_PATH = path.join(TRAIN_DIR, 'dpo.jsonl');
const SFT_PATH = path.join(TRAIN_DIR, 'sft.jsonl');

function _enabled() {
  return process.env.AVA_TRAIN_COLLECT !== '0';
}

function _ensureDir() {
  try { fs.mkdirSync(TRAIN_DIR, { recursive: true }); } catch { /* ignore */ }
}

function _clip(s, n = 4000) {
  s = (s == null) ? '' : (typeof s === 'string' ? s : JSON.stringify(s));
  return s.length > n ? s.slice(0, n) : s;
}

function _append(file, obj) {
  try {
    _ensureDir();
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch { /* never block the request path */ }
}

/**
 * A preference pair: the SAME prompt, the model's WRONG output, and the corrected RIGHT output.
 * Ideal for DPO/ORPO. tag examples: 'false_denial', 'tool_leak', 'empty_promise'.
 */
export function logPreference({ prompt, chosen, rejected, tags = [], meta = {} } = {}) {
  if (!_enabled()) return;
  if (!chosen || !rejected) return;                 // both sides required for a pair
  if (String(chosen).trim() === String(rejected).trim()) return;
  _append(DPO_PATH, {
    ts: new Date().toISOString(),
    prompt: _clip(prompt, 8000),
    chosen: _clip(chosen, 4000),
    rejected: _clip(rejected, 4000),
    tags: Array.isArray(tags) ? tags : [tags],
    meta,
  });
}

/**
 * A verified-good turn: the request/prompt and the tool_call (or answer) that actually worked.
 * Written as chat messages for SFT. Call this only when the action's effect was confirmed.
 */
export function logSuccess({ prompt, output, tags = [], meta = {} } = {}) {
  if (!_enabled()) return;
  if (!output) return;
  _append(SFT_PATH, {
    ts: new Date().toISOString(),
    messages: [
      { role: 'user', content: _clip(prompt, 8000) },
      { role: 'assistant', content: _clip(output, 4000) },
    ],
    tags: Array.isArray(tags) ? tags : [tags],
    meta,
  });
}

/** Quick counts so an operator (or the estimator) can see how the dataset is growing. */
export function stats() {
  const count = (f) => {
    try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length; }
    catch { return 0; }
  };
  return { dpo_pairs: count(DPO_PATH), sft_examples: count(SFT_PATH), dir: TRAIN_DIR };
}

export default { logPreference, logSuccess, stats };
