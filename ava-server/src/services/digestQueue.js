// Digest Queue - non-interruptive delivery of curiosity results and summaries
// Stores items in JSONL under data/digest.jsonl and holds a small in-memory queue

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import autonomyLib from './autonomyPolicy.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DIGEST_PATH = path.join(DATA_DIR, 'digest.jsonl');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }

class DigestQueue {
  constructor() {
    this.queue = [];
    this.lastFlushAt = 0;
    this.lastNotifyAt = 0;
    ensureDirs();
  }

  _isQuietHours() {
    const override = process.env.DIGEST_FORCE_MODE;
    if (override === 'quiet') return true;
    if (override === 'awake') return false;
    try {
      const { getAutonomy } = autonomyLib; const autonomy = getAutonomy();
      const policy = autonomy.getPolicy();
      // reuse quiet-hours check indirectly via shouldInterrupt logic; approximate with hour window
      const qh = policy.quiet_hours || {};
      if (!qh.enabled) return false;
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const t = `${hh}:${mm}`;
      const start = qh.start || '22:00';
      const end = qh.end || '07:00';
      if (start <= end) return t >= start && t < end;
      return t >= start || t < end;
    } catch { return false; }
  }

  enqueue(item) {
    const id = item.id || `dg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    const enriched = {
      id,
      createdAt: nowIso(),
      domain: item.domain || 'web_research',
      trigger: item.trigger || 'gap_detected',
      title: item.title || 'Digest Item',
      summary: item.summary || '',
      evidence: item.evidence || {},
      links: Array.isArray(item.links) ? item.links.slice(0, 5) : [],
      recommendedAction: item.recommendedAction || 'notify'
    };
    this.queue.push(enriched);
    try {
      fs.appendFileSync(DIGEST_PATH, JSON.stringify(enriched) + '\n');
    } catch {}
    this._rotateIfNeeded();
    this._notifyShim();
    return enriched.id;
  }

  flush() {
    const items = this.queue.slice();
    this.queue = [];
    this.lastFlushAt = Date.now();
    return items;
  }

  getNextDigestAt() {
    // Best-effort: use quiet_hours.digest_time if available
    try {
      const { getAutonomy } = autonomyLib; const autonomy = getAutonomy();
      const policy = autonomy.getPolicy();
      const qh = policy.quiet_hours || {};
      const digest = (qh.during_quiet_hours && qh.during_quiet_hours.digest_time) || '07:15';
      const [hh, mm] = String(digest).split(':').map(x => parseInt(x, 10));
      const now = new Date();
      const next = new Date(now.getTime());
      next.setHours(hh || 7, mm || 15, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      return next.toISOString();
    } catch {
      const t = new Date(Date.now() + 12 * 3600 * 1000);
      return t.toISOString();
    }
  }

  getStatus() {
    return {
      count: this.queue.length,
      lastFlushAt: this.lastFlushAt ? new Date(this.lastFlushAt).toISOString() : null,
      nextDigestAt: this.getNextDigestAt()
    };
  }

  getLastDelivered() {
    return this.lastDelivered || null;
  }

  setLastDelivered(items) {
    this.lastDelivered = { deliveredAt: new Date().toISOString(), count: (items||[]).length, items };
  }

  _notifyShim() {
    // Outside quiet hours only, rate-limited to once per 15 minutes
    if (this._isQuietHours()) return;
    const now = Date.now();
    const FIFTEEN_MIN = 15 * 60 * 1000;
    if (now - (this.lastNotifyAt || 0) < FIFTEEN_MIN) return;
    this.lastNotifyAt = now;
    logger.info(`[digest] Digest updated: ${this.queue.length} item(s) pending. Call /self/digest/flush to view.`);
  }

  _rotateIfNeeded() {
    try {
      const stat = fs.existsSync(DIGEST_PATH) ? fs.statSync(DIGEST_PATH) : null;
      if (!stat) return;
      const maxBytes = Number(process.env.DIGEST_MAX_BYTES || 5*1024*1024);
      if (stat.size < maxBytes) return;
      const archiveDir = path.join(DATA_DIR, 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      const fname = `digest-${new Date().toISOString().replace(/[:.]/g,'-')}.jsonl`;
      fs.renameSync(DIGEST_PATH, path.join(archiveDir, fname));
      fs.writeFileSync(DIGEST_PATH, '');
      // prune to last 7 archives
      const files = fs.readdirSync(archiveDir).filter(f => f.startsWith('digest-') && f.endsWith('.jsonl'))
        .map(f => ({ f, t: fs.statSync(path.join(archiveDir, f)).mtimeMs }))
        .sort((a,b)=>b.t-a.t);
      for (let i=7;i<files.length;i++) {
        try { fs.unlinkSync(path.join(archiveDir, files[i].f)); } catch {}
      }
    } catch {}
  }
}

const digestQueue = new DigestQueue();

export default digestQueue;
