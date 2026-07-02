// memoryHub — THE single interface to AVA's memory (Tier 1 #5).
//
// One store   : memory.js        (durable typed memories: facts/preferences/constraints/…)
// One index   : ftsIndex.js      (SQLite FTS5 over curated files + conversation logs;
//                                 memorySearch.js is the query layer with linear-scan fallback)
// One log     : conversationLogger.js (daily JSONL conversation log)
//
// Retrieval layers on top of those three. Callers should import THIS module instead of
// reaching into the pieces (or scanning log files themselves — the old duplicate scanners).
//
// API:
//   store/upsert/retrieveRelevant/markUsed/formatForPrompt/buildRetrievalQuery — durable store
//   search(query, limit)      — unified: curated files + skills + conversation logs (FTS-first)
//                               + the durable typed store, merged and deduped
//   historyWindow(query,opts) — dated transcript window for recall grounding
//   recentTurns(n)            — recent conversation turns across days
import memoryService, { MemoryType, MemorySource } from './memory.js';
import memorySearch from './memorySearch.js';
import conversationLogger from './conversationLogger.js';
import conversationHistory from './conversationHistory.js';

async function search(query, limit = 8) {
  // 1) Curated memory + skills + conversation logs (FTS5 when available).
  const base = memorySearch.search(query, limit);
  const results = Array.isArray(base.results) ? [...base.results] : [];

  // 2) Durable typed store (vector/keyword scored) — the piece the old memory_search missed.
  try {
    const hits = await memoryService.search(query, Math.min(limit, 5));
    for (const h of hits || []) {
      if (h && h.text) results.push({ source: 'store', label: h.type || 'memory', date: '', score: 2 + (h.priority || 0) / 10, text: String(h.text).slice(0, 240) });
    }
  } catch { /* store search optional */ }

  // Merge + dedupe (same normalization as memorySearch)
  results.sort((a, b) => (b.score - a.score) || String(b.date || '').localeCompare(String(a.date || '')));
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = String(r.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (key && !seen.has(key)) { seen.add(key); deduped.push(r); }
  }
  const top = deduped.slice(0, limit);
  const summary = top.length
    ? top.map((r) => (r.source === 'conversation' ? `[${r.date} ${r.time || ''} ${r.who}] ${r.text}` : `[${r.label}] ${r.text}`)).join('\n')
    : `No matches for "${query}".`;
  return { status: 'ok', query, count: top.length, results: top, summary };
}

function historyWindow(query, opts = {}) {
  const win = conversationHistory.windowForQuery(query, { maxTurns: opts.maxTurns || 160 });
  return { ...win, transcript: conversationHistory.formatTurns(win.turns, opts.maxChars || 8000) };
}

function recentTurns(n = 10) {
  try { return conversationLogger.getRecentHistoryAcrossDays(n) || []; } catch { return []; }
}

export { MemoryType, MemorySource };
export default {
  // durable store (memory.js)
  store: (...a) => memoryService.store(...a),
  upsert: (...a) => memoryService.upsert(...a),
  retrieveRelevant: (...a) => memoryService.retrieveRelevant(...a),
  markUsed: (...a) => memoryService.markUsed(...a),
  formatForPrompt: (...a) => memoryService.formatForPrompt(...a),
  buildRetrievalQuery: (...a) => memoryService.buildRetrievalQuery(...a),
  generatePersona: (...a) => memoryService.generatePersona(...a),
  // unified retrieval
  search,
  historyWindow,
  recentTurns,
};
