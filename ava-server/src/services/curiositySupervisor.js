// Curiosity Supervisor - policy-governed wrapper for background research
// Enforces: policy gate, budgets, relevance threshold, citation requirement,
// memory hygiene (dedupe + caps), and no-interrupt rule.

import autonomyLib from './autonomyPolicy.js';
import memoryService from './memory.js';
import { jaccardSim } from './curiosityScoring.js';
import logger from '../utils/logger.js';

function normalizeFinding(f) {
  if (!f) return null;
  const obj = typeof f === 'string' ? { text: f } : { ...f };
  obj.text = String(obj.text || '').trim();
  if (!obj.text) return null;
  if (obj.url && typeof obj.citation !== 'string') obj.citation = obj.url;
  return obj;
}

export async function runCuriosity({
  trigger = 'gap_detected',
  domain = 'web_research',
  scopeMinutes = 5,
  plannedFindings = 1,
  signal = {},
  isUserInitiated = false,
  query = '',
  task
} = {}) {
  const { getAutonomy } = autonomyLib;
  const autonomy = getAutonomy(logger);
  const policy = autonomy.getPolicy();

  if (typeof task !== 'function') {
    return { ran: false, outcome: 'log_only', reason: 'no_task' };
  }

  // 1) Policy gate
  const decision = autonomy.decide({
    domain,
    trigger,
    risk: { toolRisk: 'low' },
    requiresWrite: false,
    isUserInitiated,
    signal
  });

  // For curiosity, only run on act/act_then_report (notify/log_only becomes suggestion)
  if (!['act', 'act_then_report'].includes(decision.outcome)) {
    // Provide budget reason if applicable
    const budgets = autonomy.getBudgets();
    const minutesOk = budgets.canSpend('curiosityMinutes', scopeMinutes);
    const findingsOk = budgets.canSpend('curiosityFindings', plannedFindings);
    const reason = (!minutesOk || !findingsOk) ? 'budget_exceeded' : 'policy_outcome';
    return { ran: false, outcome: decision.outcome, decision, reason };
  }

  // 2) Budgets
  const budgets = autonomy.getBudgets();
  if (!budgets.canSpend('curiosityMinutes', scopeMinutes) || !budgets.canSpend('curiosityFindings', plannedFindings)) {
    return { ran: false, outcome: 'log_only', reason: 'budget_exceeded', decision };
  }
  // Reserve budgets up front
  budgets.spend('curiosityMinutes', scopeMinutes);
  budgets.spend('curiosityFindings', plannedFindings);

  // 3) Execute task
  let findings = [];
  let taskOutput = null;
  try {
    const res = await task({ scopeMinutes, plannedFindings, query, signal });
    taskOutput = res || null;
    if (res && Array.isArray(res.findings)) findings = res.findings;
  } catch (e) {
    return { ran: false, outcome: 'log_only', reason: `task_error:${e.message}` };
  }

  // 4) Memory hygiene filters
  const t = policy.thresholds || {};
  const minRel = Number(t.curiosity_requires_relevance_score || 0.72);
  const requireCitation = !!t.curiosity_requires_citation;
  const maxChars = Number(t.memory_max_chars_per_item || 600);
  const dedupeThresh = Number(t.memory_dedupe_similarity_threshold || 0.92);

  const stored = [];
  const filtered = [];

  for (const raw of findings) {
    const f = normalizeFinding(raw);
    if (!f) { filtered.push({ reason: 'invalid' }); continue; }
    // relevance
    const r = typeof f.relevanceScore === 'number' ? f.relevanceScore : (query ? jaccardSim(f.text, query) : 0.5);
    if (r < minRel) { filtered.push({ ...f, reason: 'low_relevance' }); continue; }
    // citation/url
    if (requireCitation && !f.citation && !f.url) { filtered.push({ ...f, reason: 'no_citation' }); continue; }
    // length cap
    if (f.text.length > maxChars) { filtered.push({ ...f, reason: 'too_long' }); continue; }
    // dedupe vs. recent memory using Jaccard
    const recent = memoryService.memory?.slice(-200) || []; // shallow access acceptable in-process
    let dup = false;
    for (const m of recent) {
      const sim = jaccardSim(String(m.text || ''), f.text);
      if (sim >= dedupeThresh) { dup = true; break; }
    }
    if (dup) { filtered.push({ ...f, reason: 'dedupe' }); continue; }

    try {
      const mem = await memoryService.store({
        text: f.text,
        type: 'fact',
        priority: 2,
        source: 'learned',
        tags: ['curiosity', 'research'].concat(f.url ? ['url'] : [])
      });
      stored.push({ id: mem.id, url: f.url || null });
    } catch (e) {
      filtered.push({ ...f, reason: `store_error:${e.message}` });
    }
  }

  const rawFindings = (findings || []).slice(0, 3).map(f => normalizeFinding(f));
  return { ran: true, outcome: decision.outcome, decision, storedCount: stored.length, filteredCount: filtered.length, stored, filtered, rawFindings, taskOutput };
}

export default { run: runCuriosity };
