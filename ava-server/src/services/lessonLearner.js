// lessonLearner — when a tool fails, diagnose why and distill ONE preventive lesson
// into curated memory (guarded), so the same failure doesn't recur. Closes the
// detect -> reason -> repair loop back into the always-on memory.
import logger from '../utils/logger.js';
import llmService from './llm.js';
import curatedMemory from './curatedMemory.js';
import toolsService from './tools.js';

const REJECT = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /\bpassword\b|\bapi[_\- ]?key\b|\bsecret\s+key\b|\bprivate\s+key\b|\btoken\s*[:=]/i,
  /[A-Za-z0-9+/]{40,}={0,2}/,
  /https?:\/\/\S*[:@]\S+/i,
];
function safe(s) { return !REJECT.some((r) => r.test(s)); }

const _recent = new Set();   // de-dupe error storms within a run

export async function lessonFromError({ tool, args, error, goal } = {}) {
  try {
    if (process.env.AVA_LESSONS_OFF === '1') return { saved: false, reason: 'disabled' };
    const errStr = String(error || '').slice(0, 300);
    if (!tool || !errStr) return { saved: false, reason: 'insufficient' };
    const key = `${tool}:${errStr.slice(0, 60)}`;
    if (_recent.has(key)) return { saved: false, reason: 'dup' };
    _recent.add(key); if (_recent.size > 300) _recent.clear();

    // Best-effort: ask the runtime diagnoser why this tool is failing (richer lessons).
    let diagnosis = '';
    try {
      const d = await toolsService.executeTool('self_awareness', { action: 'diagnose_tool', tool }, false, { source: 'lesson', bypassIdempotency: true });
      diagnosis = JSON.stringify(d?.result || d || {}).slice(0, 500);
    } catch { /* diagnosis optional */ }

    const sys = `A tool just FAILED during a task. Write ONE short, GENERAL, preventive lesson AVA should remember so this does not happen again (e.g. "When <tool> fails with <symptom>, do <fix>" or "<tool> needs <prerequisite>"). Max 200 chars, specific and actionable. If there is no useful general lesson, output exactly: null. Never include secrets or destructive commands.`;
    const usr = `GOAL: ${goal || ''}\nTOOL: ${tool}\nARGS: ${JSON.stringify(args || {}).slice(0, 200)}\nERROR: ${errStr}\nDIAGNOSIS: ${diagnosis}`;

    let text = '';
    try {
      const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.2, max_tokens: 160 });
      text = (r.text || r.content || '').trim();
    } catch (e) { return { saved: false, error: e.message }; }

    if (!text || /^null\b/i.test(text) || text.toLowerCase() === 'null') return { saved: false, reason: 'no lesson' };
    let normalized = text.trim();
    if (normalized.startsWith('{')) {
      let parsed;
      try { parsed = JSON.parse(normalized); }
      catch { logger?.warn?.('[lessonLearner] rejected malformed JSON lesson', { tool }); return { saved: false, reason: 'malformed_json_learning' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { saved: false, reason: 'malformed_json_learning' };
      const pick = (...keys) => keys.map((k) => parsed[k]).find((v) => typeof v === 'string' && v.trim())?.trim();
      normalized = [pick('title', 'topic'), pick('content', 'insight', 'lesson')].filter(Boolean).join(': ');
      if (!normalized) return { saved: false, reason: 'malformed_json_learning' };
    }
    const lesson = normalized.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!safe(lesson)) { logger?.warn?.('[lessonLearner] rejected unsafe lesson', { tool }); return { saved: false, reason: 'guard' }; }

    const res = curatedMemory.appendFact('memory', `Lesson: ${lesson}`);
    logger?.info?.('[lessonLearner] saved lesson', { tool, lesson: lesson.slice(0, 80) });
    return { saved: !!(res.ok && !res.deduped), lesson };
  } catch (e) {
    return { saved: false, error: e.message };
  }
}

export async function processRejection({ rawReason, tool, args, goal } = {}) {
  try {
    if (process.env.AVA_LESSONS_OFF === '1') return { saved: false, reason: 'disabled' };
    const reasonStr = (rawReason || '').slice(0, 600);
    if (!reasonStr) return { saved: false, reason: 'insufficient' };

    // Extract core pattern: e.g. "calls pythonWorker.execute() which does not exist"
    const sys = `You are given a rejected proposal and its rejection reason. Extract the core technical mistake pattern in one short, specific sentence (max 150 chars). Example: "avoid calling pythonWorker.execute() — use pythonWorker.executeTool() instead". If no clear pattern exists, output exactly: null. Never include secrets.`;
    const usr = `REJECTION CONTEXT\nTOOL: ${tool || 'unknown'}\nARGS: ${JSON.stringify(args || {}).slice(0, 200)}\nGOAL: ${goal || ''}\nREJECTION: ${reasonStr}`;

    let text = '';
    try {
      const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.2, max_tokens: 150 });
      text = (r.text || r.content || '').trim();
    } catch (e) { return { saved: false, error: e.message }; }

    if (!text || /^null\b/i.test(text) || text.toLowerCase() === 'null') return { saved: false, reason: 'no lesson' };
    const lesson = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!safe(lesson)) { logger?.warn?.('[lessonLearner] rejected unsafe rejection lesson'); return { saved: false, reason: 'guard' }; }

    const res = curatedMemory.appendFact('memory', `Lesson: ${lesson}`);
    logger?.info?.('[lessonLearner] saved rejection lesson', { lesson: lesson.slice(0, 80) });
    return { saved: !!(res.ok && !res.deduped), lesson };
  } catch (e) {
    return { saved: false, error: e.message };
  }
}

export default { lessonFromError, processRejection };
