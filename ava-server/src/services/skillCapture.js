// skillCapture — after a successful, non-trivial task, distill a reusable skill.
// skill_guard scans the candidate before saving; the store's maturity counter promotes
// a skill to "proven" after it's been captured a few times.
import logger from '../utils/logger.js';
import llmService from './llm.js';
import conversationLogger from './conversationLogger.js';
import skillStore from './skillStore.js';

// Reject destructive, secret, or injection content from ever becoming a saved skill.
const REJECT = [
  /rm\s+-rf/i, /del\s+\/[fsq]/i, /format\s+[a-z]:/i, /deltree/i, /rmdir\s+\/s/i,
  /\bshutdown\b/i, /reg(\.exe)?\s+delete/i, /diskpart/i, /mkfs/i,
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /\bpassword\b|\bapi[_\- ]?key\b|\bsecret\s+key\b|\bprivate\s+key\b|\btoken\s*[:=]/i,
  /[A-Za-z0-9+/]{40,}={0,2}/,            // long base64-ish blob
  /https?:\/\/\S*[:@]\S+/i,              // creds in URL
];
function guardOk(text) { return !REJECT.some((r) => r.test(text)); }

let _running = false;

export async function reviewAndCapture(opts = {}) {
  if (_running) return { captured: false, reason: 'already running' };
  _running = true;
  try {
    let transcript = opts.transcript;
    if (!transcript) {
      try {
        const h = conversationLogger.getRecentHistoryAcrossDays(opts.maxTurns || 14) || [];
        transcript = h.map((e) => ({ d: (e.direction || e.role), c: e.content }))
          .filter((x) => x.c).slice(-14)
          .map((x) => `${x.d === 'assistant' ? 'AVA' : 'User'}: ${String(x.c).slice(0, 400)}`)
          .join('\n');
      } catch { /* optional */ }
    }
    if (!transcript || !transcript.trim()) return { captured: false, reason: 'no transcript' };

    const sys = `You capture REUSABLE skills from a completed task. If the task involved a NON-TRIVIAL, repeatable procedure (multiple steps, specific tools, or trial-and-error worth remembering for next time), output ONE skill as JSON:
{"title":"short imperative title","when":"when to use this","steps":["step 1","step 2", ...],"tags":["..."]}
Explicit user corrections or preference-pattern phrases (for example, "no, I meant...", "actually...", or "when I say X, do Y") are reusable lessons: capture them as a skill with the corrected/preferred behavior in steps, even if they are not a completed task.
If the task was trivial, one-off, or has no reusable procedure or explicit correction/preference pattern, output exactly: null
Never include secrets, credentials, or destructive commands in the steps.`;
    const usr = `GOAL: ${opts.goal || '(infer from the transcript)'}\n\nTRANSCRIPT:\n${transcript}`;

    let text = '';
    try {
      const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.2, max_tokens: 500 });
      text = (r.text || r.content || '').trim();
    } catch (e) { return { captured: false, error: e.message }; }

    if (/^null\b/i.test(text) || text.toLowerCase() === 'null') return { captured: false, reason: 'nothing reusable' };
    let skill = null;
    try { const m = text.match(/\{[\s\S]*\}/); skill = m ? JSON.parse(m[0]) : null; } catch { skill = null; }
    if (!skill || !skill.title || !skill.steps) return { captured: false, reason: 'no skill parsed' };

    const serialized = `${skill.title}\n${skill.when || ''}\n${Array.isArray(skill.steps) ? skill.steps.join('\n') : skill.steps}`;
    if (!guardOk(serialized)) {
      logger?.warn?.('[skillCapture] rejected unsafe skill', { title: skill.title });
      return { captured: false, reason: 'guard_rejected' };
    }

    const res = skillStore.saveSkill({ title: skill.title, when: skill.when, steps: skill.steps, tags: skill.tags });
    logger?.info?.('[skillCapture] captured', { title: skill.title, uses: res.uses, proven: res.proven });
    return { captured: true, title: skill.title, uses: res.uses, proven: res.proven, isNew: res.created };
  } finally {
    _running = false;
  }
}

export default { reviewAndCapture };
