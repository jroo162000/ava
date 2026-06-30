// financeKnowledge.js — AVA's finance / bookkeeping / tax knowledge HARNESS (RAG).
// You don't fine-tune her cloud brain for this; you give it a retrievable, source-cited knowledge
// base it grounds answers in. Authoritative sources (IRS pubs, GAAP, recordkeeping, tax tables) are
// chunked, embedded into her existing memory (so her normal retrieval surfaces them), and mirrored to
// a finance-kb.jsonl with source + date for citation. search() pulls the most relevant chunks for a
// finance question. Knowledge stays CURRENT by re-ingesting sources — no stale fine-tune to redo.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import memoryService from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'finance-kb.jsonl');

// Paragraph-aware chunking so retrieved passages stay coherent and citable.
function chunkText(text, size = 1100, overlap = 150) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > size && buf) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n\n' + p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  // Hard-split any oversized single paragraph.
  const out = [];
  for (const c of chunks) {
    if (c.length <= size * 1.5) { out.push(c); continue; }
    for (let i = 0; i < c.length; i += size) out.push(c.slice(i, i + size));
  }
  return out;
}

/**
 * Ingest a source document into the finance knowledge base.
 * @param {object} o
 * @param {string} o.text         the source text (e.g. from web_scrape)
 * @param {string} o.source       human label, e.g. "IRS Publication 334"
 * @param {string} o.url          source URL (for citation)
 * @param {string} o.topic        e.g. "depreciation", "bookkeeping", "schedule-c"
 * @param {string} o.jurisdiction e.g. "US-federal", "US-CA"
 * @param {boolean} o.dryRun      compute chunks without storing
 */
export async function ingest({ text, source = '', url = '', topic = '', jurisdiction = 'US-federal', dryRun = false }) {
  const chunks = chunkText(text).filter(c => c.trim().length >= 80);
  if (dryRun) return { dryRun: true, wouldStore: chunks.length, source: source || url };
  const retrievedAt = new Date().toISOString();
  let stored = 0;
  for (const c of chunks) {
    try {
      await memoryService.store({
        text: `[FINANCE-KB${topic ? '/' + topic : ''}] ${c}`,
        type: 'fact', priority: 3, source: 'learned',
        tags: ['finance', 'finance-kb', jurisdiction, ...(topic ? [topic] : [])]
      });
      fs.mkdirSync(path.dirname(KB_PATH), { recursive: true });
      fs.appendFileSync(KB_PATH, JSON.stringify({ topic, source, url, jurisdiction, retrievedAt, text: c }) + '\n');
      stored++;
    } catch (e) { logger.warn('[finance-kb] store failed', { error: e.message }); }
  }
  logger.info('[finance-kb] ingested source', { source: source || url, chunks: stored, jurisdiction });
  return { stored, source: source || url, retrievedAt };
}

// Retrieve the most relevant finance-KB passages for a question (the RAG step).
export async function search(query, k = 6) {
  try { return await memoryService.retrieveRelevant(query, k, { tags: ['finance-kb'] }); }
  catch (e) { logger.warn('[finance-kb] search failed', { error: e.message }); return []; }
}

export function stats() {
  try {
    if (!fs.existsSync(KB_PATH)) return { chunks: 0, sources: 0 };
    const lines = fs.readFileSync(KB_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const sources = new Set();
    for (const l of lines) { try { sources.add(JSON.parse(l).source || JSON.parse(l).url); } catch {} }
    return { chunks: lines.length, sources: sources.size };
  } catch { return { chunks: 0, sources: 0 }; }
}

export default { ingest, search, stats };
