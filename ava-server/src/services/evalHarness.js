// evalHarness — Tier 3 #21 (rest): a fast, deterministic BEHAVIORAL eval gate for AVA's
// self-improvement, distilled from the virtual-training-environment idea.
//
// The full training harness (ui_eval.bat + a task library + a sandboxed device) is heavy and
// lives on the install machine. This is its lightweight in-process cousin: a small fixed task
// set with DETERMINISTIC pass/fail checks that runs against the LIVE server (/respond) and
// returns a routing-accuracy score. It exists so a change that touches AVA's routing / guidance
// behavior can be scored — the "harness becomes the eval gate" half of roadmap #21 — cheaply
// enough to run on demand (a handful of turns), instead of never.
//
// Each task asserts an OBSERVABLE routing outcome, not a wording:
//   want:'tools' — a machine-state/action turn MUST reach the agent loop (id 'agent-*' or steps>0)
//   want:'chat'  — a pure-chat/self turn MUST stay conversational (id 'conv-*'/'direct-*', steps 0)
// Routing accuracy is the fraction of tasks whose actual outcome matches `want`. This is exactly
// the axis the training harness moved from 69%→94.5% (tool-use routing), so it's the right proxy.
import logger from '../utils/logger.js';
import config from '../utils/config.js';
import evolutionLog from './evolutionLog.js';

// The task set. Kept small (fast + cheap) and balanced so a change that makes her escalate
// EVERYTHING (fixing misses by breaking chat) is penalized by the 'chat' controls.
const TASKS = [
  { name: 'ram-usage', text: 'How much RAM is in use right now?', want: 'tools' },
  { name: 'open-windows', text: 'How many windows do I have open right now?', want: 'tools' },
  { name: 'clipboard', text: 'What is in my clipboard at the moment?', want: 'tools' },
  { name: 'c-drive', text: 'How full is my C drive?', want: 'tools' },
  { name: 'volume', text: 'What is my current volume level right now?', want: 'tools' },
  { name: 'greeting', text: 'Hey, how are you doing today?', want: 'chat' },
  { name: 'self-intro', text: 'Tell me a little about yourself.', want: 'chat' },
  { name: 'fact', text: 'What is the capital of France?', want: 'chat' },
];

function classify(agent) {
  const id = String((agent && agent.id) || '');
  const steps = (agent && agent.steps) | 0;
  if (id.startsWith('agent-') || steps > 0) return 'tools';
  return 'chat'; // conv-* / direct-* / self-* — no tool loop ran
}

async function runTask(baseUrl, token, task, i) {
  const body = JSON.stringify({
    sessionId: `eval-${Date.now()}-${i}`, text: task.text, freshSession: true,
    run_tools: false, allow_write: true, voice_mode: 'spoken',
    spoken_reply_budget: { max_sentences: 300, max_words: 4000, prefer_brief: false },
  });
  const r = await fetch(`${baseUrl}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });
  // Drain the SSE stream; we only need the `done` payload's agent block.
  const reader = r.body.getReader();
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
  try { await reader.cancel(); } catch { /* */ }
  const actual = classify(done && done.agent);
  return { name: task.name, want: task.want, actual, ok: actual === task.want, id: (done && done.agent && done.agent.id) || '' };
}

// Run the whole suite against the live server. Returns { score, passed, total, tasks, ms }.
export async function runEval({ record = true } = {}) {
  const t0 = Date.now();
  const port = process.env.PORT || 5051;
  const baseUrl = process.env.AVA_EVAL_BASE_URL || `http://127.0.0.1:${port}`;
  const token = config.AVA_API_TOKEN || process.env.AVA_API_TOKEN || '';
  const results = [];
  for (let i = 0; i < TASKS.length; i++) {
    try { results.push(await runTask(baseUrl, token, TASKS[i], i)); }
    catch (e) { results.push({ name: TASKS[i].name, want: TASKS[i].want, actual: 'error', ok: false, error: e.message }); }
  }
  const passed = results.filter(r => r.ok).length;
  const score = results.length ? passed / results.length : 0;
  const out = { score, passed, total: results.length, tasks: results, ms: Date.now() - t0 };
  if (record) {
    try {
      evolutionLog.record({
        kind: 'eval',
        title: `routing eval ${Math.round(score * 100)}% (${passed}/${results.length})`,
        detail: results.filter(r => !r.ok).map(r => `${r.name}: wanted ${r.want}, got ${r.actual}`).join('; ') || 'all tasks passed',
        meta: { score, passed, total: results.length },
      });
      _lastScore = { score, passed, total: results.length, at: Date.now() };
    } catch (e) { logger.warn('[evalHarness] failed to record eval', { error: e.message }); }
  }
  logger.info('[evalHarness] routing eval complete', { score: score.toFixed(3), passed, total: results.length, ms: out.ms });
  return out;
}

// Last score is cached so selfImprove can stamp a proposal's evalBaseline WITHOUT paying for a
// fresh run on every scan (that would be a suite of API calls per proposal).
let _lastScore = null;
export function lastScore() {
  if (_lastScore) return _lastScore;
  // fall back to the most recent recorded eval in the evolution log (recent() is oldest-first,
  // so the NEWEST eval is the last element).
  try {
    const recents = evolutionLog.recent(20, 'eval');
    const e = recents && recents.length ? recents[recents.length - 1] : null;
    if (e && e.meta && typeof e.meta.score === 'number') {
      _lastScore = { score: e.meta.score, passed: e.meta.passed, total: e.meta.total, at: Date.parse(e.at) || 0 };
    }
  } catch { /* none yet */ }
  return _lastScore;
}

// Files whose changes plausibly move routing/guidance behavior — the axis this eval measures.
// A proposal touching one of these is worth stamping with the current eval baseline.
const ROUTING_RELEVANT = /(respond\.js|chat\.js|agentLoop\.js|trainingGuidance\.js|persona\.js|llm\.js|ava_intent_router\.py|tools\.js)$/;
export function isRoutingRelevant(file) {
  return ROUTING_RELEVANT.test(String(file || '').replace(/\\/g, '/'));
}

export default { runEval, lastScore, isRoutingRelevant };
