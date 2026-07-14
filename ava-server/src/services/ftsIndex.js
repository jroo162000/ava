// ftsIndex — a SQLite FTS5 full-text index over AVA's curated memory (USER.md/MEMORY.md) and her
// conversation logs (daily JSONL). This is the "retrieval at scale" upgrade: instead of re-reading
// and linearly scanning every log line on each query (memorySearch's old path, capped at 8k lines),
// we maintain a bm25-ranked FTS5 index and MATCH against it. Matches Hermes' SQLite+FTS state.
//
// Uses Node's BUILT-IN node:sqlite (Node >= 22.5, FTS5 compiled in) — no native dependency. If the
// runtime lacks it, available() returns false and memorySearch falls back to the linear scan, so this
// is strictly non-breaking.
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import curatedMemory from './curatedMemory.js';
import avaPaths from '../utils/paths.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (e) { try { logger.info('[fts] node:sqlite unavailable, FTS disabled', { error: e.message }); } catch { /* ignore */ } }

const DB_PATH = path.join(avaPaths.dataDir(), 'memory_fts.db');
const OFFSET_MIN = parseInt(process.env.AVA_TZ_OFFSET_MIN || '-300', 10);
const FRESH_CHECK_MS = 15000;   // don't re-stat sources more than this often

let db = null;
let _ok = false;
let _lastCheck = 0;
let _lastSig = '';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'what', 'did', 'we', 'about', 'you',
  'your', 'our', 'do', 'does', 'have', 'has', 'is', 'are', 'to', 'of', 'on', 'in', 'for', 'me',
  'my', 'i', 'it', 'that', 'this', 'with', 'was', 'were', 'they', 'them', 'how', 'when', 'where',
  'why', 'who', 'can', 'could', 'would', 'should', 'please', 'tell', 'know', 'say', 'said', 'get']);

function terms(q) {
  return Array.from(new Set((String(q || '').toLowerCase().match(/[a-z0-9]+/g) || [])))
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// Tier 1 #8: the conversation-logs location lives in ONE place now (utils/paths.js).
function logsDir() { return avaPaths.conversationLogsDir(); }

function sourceFiles() {
  const files = [];
  try { const p = curatedMemory.paths.userPath(); if (fs.existsSync(p)) files.push({ p, kind: 'memory', label: 'USER profile' }); } catch { /* ignore */ }
  try { const p = curatedMemory.paths.memoryPath(); if (fs.existsSync(p)) files.push({ p, kind: 'memory', label: 'AVA notes' }); } catch { /* ignore */ }
  try { const p = path.join(path.dirname(curatedMemory.paths.memoryPath()), 'research-notes.jsonl'); if (fs.existsSync(p)) files.push({ p, kind: 'research', label: 'research' }); } catch { /* ignore */ }
  try {
    const dir = logsDir();
    for (const f of fs.readdirSync(dir).filter((f) => /^conversation-.*\.jsonl$/.test(f)).sort()) {
      files.push({ p: path.join(dir, f), kind: 'conversation', label: (f.match(/conversation-(.*)\.jsonl/) || [])[1] || '' });
    }
  } catch { /* none */ }
  return files;
}

function signature(files) {
  return files.map((f) => { try { const s = fs.statSync(f.p); return `${f.p}:${s.mtimeMs}:${s.size}`; } catch { return `${f.p}:0`; } }).join('|');
}

function toLocal(tsUtc) {
  const ms = Date.parse(tsUtc);
  if (isNaN(ms)) return { date: '', time: '' };
  const iso = new Date(ms + OFFSET_MIN * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function _init() {
  if (!DatabaseSync) return false;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(content, source UNINDEXED, label UNINDEXED, ymd UNINDEXED, tm UNINDEXED, who UNINDEXED)');
    _ok = true;
    return true;
  } catch (e) {
    try { logger.warn('[fts] init failed', { error: e.message }); } catch { /* ignore */ }
    _ok = false; db = null; return false;
  }
}

function _rebuild(files) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM docs');
    const ins = db.prepare('INSERT INTO docs (content, source, label, ymd, tm, who) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f.p, 'utf8'); } catch { continue; }
      if (f.kind === 'memory') {
        for (const line of text.split('\n')) { const t = line.trim(); if (t) ins.run(t, 'memory', f.label, '', '', ''); }
      } else if (f.kind === 'research') {
        for (const ln of text.split('\n')) {
          if (!ln.trim()) continue;
          let e; try { e = JSON.parse(ln); } catch { continue; }
          const content = `${e.topic || ''}: ${e.summary || ''}`.trim();
          if (content.length > 2) ins.run(content.slice(0, 2000), 'research', e.topic || 'research', String(e.ts || '').slice(0, 10), '', 'web');
        }
      } else {
        for (const ln of text.split('\n')) {
          if (!ln.trim()) continue;
          let e; try { e = JSON.parse(ln); } catch { continue; }
          if (e.type && e.type !== 'message') continue;
          const content = String(e.content || '').trim();
          if (!content) continue;
          const { date, time } = toLocal(e.timestamp);
          const who = (e.direction || e.role) === 'assistant' ? 'AVA' : 'You';
          ins.run(content.slice(0, 2000), 'conversation', date || f.label, date || f.label, time, who);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// Rebuild the index only when a source file changed (throttled). Cheap when nothing changed.
function ensureFresh() {
  if (!_ok && !_init()) return false;
  const now = Date.now();
  if (now - _lastCheck < FRESH_CHECK_MS) return true;
  _lastCheck = now;
  try {
    const files = sourceFiles();
    const sig = signature(files);
    if (sig !== _lastSig) {
      _rebuild(files);
      _lastSig = sig;
      logger.info('[fts] reindexed', { files: files.length });
    }
    return true;
  } catch (e) {
    try { logger.warn('[fts] reindex failed', { error: e.message }); } catch { /* ignore */ }
    return false;
  }
}

function available() { return !!DatabaseSync && (_ok || _init()); }

// Full-text query. Returns results shaped like memorySearch (higher score = better).
function query(q, limit = 8) {
  if (!ensureFresh() || !db) return null;
  const ts = terms(q);
  if (!ts.length) return [];
  const match = ts.map((t) => `"${t}"`).join(' OR ');
  try {
    const rows = db.prepare(
      'SELECT content, source, label, ymd, tm, who, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?'
    ).all(match, limit * 3);
    const out = rows.map((r) => ({
      source: r.source,
      label: r.label || '',
      date: r.ymd || '',
      time: r.tm || '',
      who: r.who || '',
      text: String(r.content || '').slice(0, 240),
      score: Math.max(1, Math.round((10 - Number(r.rank || 0)) * 10) / 10),  // -bm25 -> positive
    }));
    // Curated memory outranks conversation lines, mirroring memorySearch's +3 bias.
    for (const o of out) if (o.source === 'memory') o.score += 3;
    out.sort((a, b) => (b.score - a.score) || String(b.date).localeCompare(String(a.date)));
    return out.slice(0, limit);
  } catch (e) {
    try { logger.warn('[fts] query failed', { error: e.message }); } catch { /* ignore */ }
    return null;
  }
}

// Autocomplete-like prefix search: returns completions for a given prefix string by scanning the
// FTS index for labels and content that start with the prefix, enabling fast suggest-as-you-type
// for tool names, known entities, and recent terms without a full scan.
function _searchByPrefix(prefix, limit = 6) {
  if (!_ok && !_init()) return null;
  const p = String(prefix || '').trim().toLowerCase();
  if (!p || p.length < 2) return [];
  const safeP = p.replace(/'/g, "''");
  try {
    const sql = `SELECT DISTINCT content, source, label, ymd, tm, who FROM docs WHERE LOWER(content) LIKE '${safeP}%' OR LOWER(label) LIKE '${safeP}%' LIMIT ?`;
    const rows = db.prepare(sql).all(limit * 3);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const text = String(r.content || '').slice(0, 240);
      const key = `${r.source}:${r.label}:${text.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: r.source,
        label: r.label || '',
        date: r.ymd || '',
        time: r.tm || '',
        who: r.who || '',
        text,
        score: r.source === 'memory' ? 10 : 5,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    try { logger.warn('[fts] prefix search failed', { error: e.message }); } catch { /* ignore */ }
    return null;
  }
}

export { available, query, ensureFresh, _searchByPrefix };
export default { available, query, ensureFresh, _searchByPrefix };
