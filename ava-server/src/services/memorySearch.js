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

/**
 * searchMemoryFiles — reads each curated file (USER.md, MEMORY.md), returns matched lines
 * with filename, line number, and score based on query terms and exact phrase.
 * @param {string[]} ts — array of query terms (lowercased, filtered)
 * @param {string} ql — original lowercased trimmed query string (for exact-phrase bonus)
 * @returns {Array<{source:string, label:string, date:string, score:number, text:string, line:number, filename:string}>}
 */
function searchMemoryFiles(ts, ql) {
  const results = [];
  const entries = [['USER profile', curatedMemory.paths.userPath()], ['AVA notes', curatedMemory.paths.memoryPath()]];
  for (const [label, p] of entries) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const low = line.toLowerCase();
        const score = ts.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0) + (ql && low.includes(ql) ? 2 : 0);
        if (score > 0) {
          results.push({
            source: 'memory',
            label,
            date: '',
            score: score + 3,
            text: line.trim(),
            line: i + 1,
            filename: path.basename(p)
          });
        }
      }
    } catch { /* file optional */ }
  }
  return results;
}

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
  // Use the new searchMemoryFiles helper for richer results (filename + line number)
  const memoryFileResults = searchMemoryFiles(ts, ql);
  for (const r of memoryFileResults) results.push(r);

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
    // 2b) semantic re-ranking — pure JS TF-IDF-like scoring on result texts
  if (ql.length >= 3) {
    const queryTerms = terms(query);
    const queryWords = ql.split(/\s+/).filter(w => w.length > 0);
    if (queryTerms.length > 0) {
      // Build per-document term frequency maps
      const docTfs = results.map(r => {
        const words = r.text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const tf = {};
        const total = words.length || 1;
        for (const w of words) {
          if (!STOP.has(w) && w.length >= 3) tf[w] = (tf[w] || 0) + 1;
        }
        // Normalize by document length
        for (const key in tf) tf[key] /= total;
        return { orig: r, tf };
      });
      // Compute IDF for each query term across all results
      const n = docTfs.length;
      const idf = {};
      for (const qt of queryTerms) {
        let df = 0;
        for (const d of docTfs) if (d.tf[qt] > 0) df++;
        idf[qt] = df > 0 ? Math.log(n / df) + 1 : 0;
      }
      // Score each document: sum(tf * idf) for each query term + bonus for exact phrase presence
      for (const d of docTfs) {
        let score = 0;
        for (const qt of queryTerms) score += (d.tf[qt] || 0) * idf[qt];
        // Bonus for exact query phrase match
        if (ql && d.orig.text.toLowerCase().includes(ql)) score += 1.5;
        d.orig.score = Math.round((d.orig.score || 0) + score * 100) / 100;
      }
      // Re-sort by new score descending
      results.sort((a, b) => (b.score - a.score) || String(b.date).localeCompare(String(a.date)));
    }
  }

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
