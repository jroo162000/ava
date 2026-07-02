// memory_search — one tool that searches AVA's curated memory (USER.md/MEMORY.md)
// AND her raw conversation logs (daily JSONL). Pattern: OpenClaw "memory_search across
// memory files + history". Simple keyword/relevance scan (logs are small for a personal
// assistant); FTS/embeddings are a future upgrade.
import fs from 'fs';
import path from 'path';
import os from 'os';
import curatedMemory from './curatedMemory.js';
import skillStore from './skillStore.js';
import ftsIndex from './ftsIndex.js';
import avaPaths from '../utils/paths.js';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'what', 'did', 'we', 'about', 'you',
  'your', 'our', 'do', 'does', 'have', 'has', 'is', 'are', 'to', 'of', 'on', 'in', 'for', 'me',
  'my', 'i', 'it', 'that', 'this', 'with', 'was', 'were', 'they', 'them', 'how', 'when', 'where',
  'why', 'who', 'can', 'could', 'would', 'should', 'please', 'tell', 'know', 'say', 'said', 'get']);

// Tier 1 #8: the conversation-logs location lives in ONE place now (utils/paths.js).
function logsDir() { return avaPaths.conversationLogsDir(); }

function terms(q) {
  return Array.from(new Set((String(q || '').toLowerCase().match(/[a-z0-9]+/g) || [])))
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

export function search(query, limit = 8) {
  const ts = terms(query);
  const ql = String(query || '').toLowerCase().trim();
  if (!ts.length && ql.length < 3) return { status: 'ok', query, count: 0, results: [], summary: 'Empty or too-short query.' };
  const results = [];

  // 1) curated memory files — distilled facts, highest priority
  for (const [label, p] of [['USER profile', curatedMemory.paths.userPath()], ['AVA notes', curatedMemory.paths.memoryPath()]]) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const low = line.toLowerCase();
        const score = ts.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0) + (ql && low.includes(ql) ? 2 : 0);
        if (score > 0) results.push({ source: 'memory', label, date: '', score: score + 3, text: line.trim() });
      }
    } catch { /* file optional */ }
  }

  // 1b) saved skills (reusable how-tos)
  try { for (const s of skillStore.searchSkills(query, ts)) results.push(s); } catch { /* optional */ }

  // 2) conversation logs — use the SQLite FTS5 index when available (scales to large histories
  // without re-scanning every line), else fall back to the original linear keyword scan.
  let usedFts = false;
  try {
    if (ftsIndex.available()) {
      const hits = ftsIndex.query(query, limit);
      if (Array.isArray(hits)) {
        usedFts = true;
        for (const h of hits) if (h.source === 'conversation') results.push(h);
      }
    }
  } catch { /* fall through to linear scan */ }

  if (!usedFts) {
    // newest day first
    let files = [];
    try {
      files = fs.readdirSync(logsDir()).filter((f) => /^conversation-.*\.jsonl$/.test(f)).sort().reverse();
    } catch { /* none */ }
    let scanned = 0;
    const MAX_SCAN = 8000;
    for (const f of files) {
      if (scanned >= MAX_SCAN) break;
      let lines = [];
      try { lines = fs.readFileSync(path.join(logsDir(), f), 'utf8').split('\n'); } catch { continue; }
      const date = (f.match(/conversation-(.*)\.jsonl/) || [])[1] || '';
      for (const ln of lines) {
        if (!ln.trim()) continue;
        scanned++; if (scanned >= MAX_SCAN) break;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.type && e.type !== 'message') continue;
        const content = String(e.content || '');
        if (!content) continue;
        const low = content.toLowerCase();
        const score = ts.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0) + (ql && low.includes(ql) ? 2 : 0);
        if (score > 0) {
          const who = (e.direction || e.role) === 'assistant' ? 'AVA' : 'You';
          let ld = date, tm = '';
          const ms = Date.parse(e.timestamp);
          if (!isNaN(ms)) {
            const off = parseInt(process.env.AVA_TZ_OFFSET_MIN || '-300', 10);
            const iso = new Date(ms + off * 60000).toISOString();
            ld = iso.slice(0, 10); tm = iso.slice(11, 16);
          }
          results.push({ source: 'conversation', label: ld, date: ld, time: tm, who, score, text: content.slice(0, 240) });
        }
      }
    }
  }

  results.sort((a, b) => (b.score - a.score) || String(b.date).localeCompare(String(a.date)));
  // Deduplicate by normalized text — keep first (highest-scored) occurrence
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = r.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  const top = deduped.slice(0, limit);
  const summary = top.length
    ? top.map((r) => (r.source === 'conversation' ? `[${r.date} ${r.time || ''} ${r.who}] ${r.text}` : `[${r.label}] ${r.text}`)).join('\n')
    : `No matches for "${query}".`;
  return { status: 'ok', query, count: top.length, results: top, summary };
}

export default { search };
