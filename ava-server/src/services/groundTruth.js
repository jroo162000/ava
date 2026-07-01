// groundTruth.js — AVA's shared single-source-of-truth (ground_truth.md). She READS it into her
// context each session so she doesn't rebuild the user's world from scratch, and she can WRITE to it
// ("Ava, file that") so settled facts, preferences, and decisions persist across sessions.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GT_PATH = process.env.AVA_GROUND_TRUTH_PATH
  || path.join(__dirname, '..', '..', '..', 'ava-integration', 'ground_truth.md');

export function read() {
  try { return fs.existsSync(GT_PATH) ? fs.readFileSync(GT_PATH, 'utf8') : ''; }
  catch { return ''; }
}

// A compact block for injecting into her prompt (settled context she should treat as established).
export function block(maxChars = 3500) {
  const t = read();
  if (!t) return '';
  const clipped = t.length > maxChars ? t.slice(0, maxChars) + '\n…(truncated; full file is ground_truth.md)' : t;
  return `[GROUND TRUTH — settled facts, preferences, and decisions you and ${process.env.AVA_USER_NAME || 'the user'} agreed on; treat these as established, don't re-ask or re-derive them]\n${clipped}`;
}

// Append a filed note under a "## Filed notes" section (create it if missing).
export function fileThat(text) {
  try {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!clean) return { ok: false, error: 'nothing to file' };
    let t = read();
    const line = `- (${new Date().toISOString().slice(0, 10)}) ${clean}`;
    if (/^##\s+Filed notes/m.test(t)) {
      t = t.replace(/(^##\s+Filed notes[^\n]*\n)/m, `$1${line}\n`);
    } else {
      t = (t.trimEnd() || '# AVA ⇄ Ground Truth') + `\n\n## Filed notes\n${line}\n`;
    }
    fs.mkdirSync(path.dirname(GT_PATH), { recursive: true });
    fs.writeFileSync(GT_PATH, t);
    logger.info('[ground-truth] filed a note', { chars: clean.length });
    return { ok: true, filed: clean };
  } catch (e) { logger.warn('[ground-truth] fileThat failed', { error: e.message }); return { ok: false, error: e.message }; }
}

export default { read, block, fileThat };
