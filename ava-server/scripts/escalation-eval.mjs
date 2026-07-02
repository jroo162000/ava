// escalation-eval.mjs — Tier 3 #20b: NEED_TOOLS escalation reliability regression eval.
// Ten read-only current-machine-state questions go through /respond/stream exactly like
// streamed voice turns (run_tools=false). Every one of them REQUIRES tools; a `conv-` reply
// (steps=0) means the model answered current data without checking = an escalation MISS.
// Two are phrased to hit the deterministic looksLikeToolRequest gate as controls.
//
// Baseline 2026-07-02: BEFORE the machine-state gate + routing-prompt rule: 7/10 misses with
// confidently fabricated values (fake drive size, fake volume, fake recycle-bin count).
// AFTER: 10/10 escalated, 0 misses. Rerun after touching the conversational routing:
//   cd ava-server && node scripts/escalation-eval.mjs <label>
import fs from 'fs';
import path from 'path';

const serverDir = process.cwd();
const label = process.argv[2] || 'run';
const outPath = path.join(serverDir, `escalation-eval-${label}.txt`);
const lines = [];
const log = (s) => { lines.push(s); fs.writeFileSync(outPath, lines.join('\n') + '\n'); console.log(s); };

const envText = fs.readFileSync(path.join(serverDir, '..', 'ava-integration', '.env'), 'utf8');
const token = (envText.match(/^AVA_API_TOKEN=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';

const PROMPTS = [
  { q: 'What is in my clipboard at the moment?', control: false },
  { q: 'How many windows do I have open right now?', control: false },
  { q: 'Which program am I looking at right now?', control: false },
  { q: 'How full is my C drive?', control: false },
  { q: 'Am I connected to wifi right now?', control: false },
  { q: 'What is my current volume level?', control: false },
  { q: 'How many items are sitting in my recycle bin?', control: false },
  { q: 'What song or audio is playing on this computer right now?', control: false },
  { q: 'How much RAM is in use right now?', control: true },        // hits the sys gate
  { q: 'Do I have any unread emails?', control: true },             // hits the email gate
];

async function streamTurn(text, i) {
  const body = JSON.stringify({
    sessionId: `esc-eval-${label}-${i}`, text, freshSession: true,
    run_tools: false, allow_write: true, voice_mode: 'spoken',
    spoken_reply_budget: { max_sentences: 300, max_words: 4000, prefer_brief: false },
  });
  const resp = await fetch('http://127.0.0.1:5051/respond/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', ev = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:') && ev === 'done') { try { done = JSON.parse(line.slice(5)); } catch { /* */ } }
    }
    if (done) break;
  }
  try { reader.cancel(); } catch { /* */ }
  return done;
}

let miss = 0, escalated = 0, errors = 0;
for (let i = 0; i < PROMPTS.length; i++) {
  const { q, control } = PROMPTS[i];
  try {
    const d = await streamTurn(q, i);
    const agent = (d && d.agent) || {};
    const id = String(agent.id || '');
    const steps = agent.steps | 0;
    const usedTools = id.startsWith('agent-') || steps > 0;
    const verdict = usedTools ? 'ESCALATED' : 'MISS(conv)';
    if (usedTools) escalated++; else miss++;
    log(`[${i + 1}/${PROMPTS.length}]${control ? ' (control)' : ''} ${verdict} id=${id} steps=${steps}`);
    log(`    Q: ${q}`);
    log(`    A: ${String((d && d.output_text) || '').slice(0, 180)}`);
  } catch (e) {
    errors++;
    log(`[${i + 1}] ERROR ${e.message}`);
  }
}
log(`SUMMARY ${label}: escalated=${escalated} misses=${miss} errors=${errors} of ${PROMPTS.length}`);
log('DONE');
