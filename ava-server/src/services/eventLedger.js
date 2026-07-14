// Durable, append-only evidence ledger for turns, tools, workflows, approvals,
// and proactive work. High-frequency presentation telemetry is intentionally
// excluded; this file records decisions and outcomes AVA can reason from later.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import avaPaths from '../utils/paths.js';

const DATA_DIR = avaPaths.dataDir();
const LEDGER_PATH = path.join(DATA_DIR, 'event-ledger.jsonl');
const TRANSIENT = new Set([
  'assistant.delta', 'tts.level', 'tts.visemes', 'sys.stats',
  'gaze.target', 'avatar.pose', 'avatar.gesture', 'avatar.torso',
  'avatar.expression', 'avatar.release', 'ping', 'pong',
  'capabilities.updated',
]);
const recent = new Map();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function fingerprint(event) {
  const material = JSON.stringify(stable({ type: event.type, source: event.source, data: event.data }));
  return crypto.createHash('sha256').update(material).digest('hex');
}

function rotateIfNeeded() {
  const maxBytes = Math.max(1024 * 1024, Number(process.env.AVA_EVENT_LEDGER_MAX_BYTES) || 25 * 1024 * 1024);
  try {
    if (!fs.existsSync(LEDGER_PATH) || fs.statSync(LEDGER_PATH).size < maxBytes) return;
    const archive = path.join(DATA_DIR, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(LEDGER_PATH, path.join(archive, `event-ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
  } catch { /* evidence logging must never break a turn */ }
}

export function recordEvent(event) {
  try {
    if (!shouldRecordEvent(event)) return null;
    const hash = fingerprint(event);
    const now = Date.now();
    const duplicateWindow = Math.max(0, Number(process.env.AVA_EVENT_DEDUPE_MS) || 2500);
    const seenAt = recent.get(hash) || 0;
    if (duplicateWindow && now - seenAt < duplicateWindow) return null;
    recent.set(hash, now);
    for (const [key, at] of recent) if (now - at > 60000) recent.delete(key);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = {
      id: `evt-${now.toString(36)}-${hash.slice(0, 10)}`,
      ts: now,
      iso: new Date(now).toISOString(),
      type: String(event.type),
      source: String(event.source || 'server'),
      sessionId: event.data?.sessionId || event.data?.session_id || null,
      correlationId: event.data?.callId || event.data?.workflowId || event.data?.id || null,
      hash,
      data: event.data || {},
    };
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
    rotateIfNeeded();
    return entry;
  } catch {
    return null;
  }
}

export function shouldRecordEvent(event) {
  if (!event?.type || TRANSIENT.has(event.type)) return false;
  if (event.source === 'env' && (event.type === 'tool.start' || event.type === 'tool.result')) return false;
  return true;
}

export function recentEvents(limit = 100, filter = {}) {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      let event; try { event = JSON.parse(lines[i]); } catch { continue; }
      if (filter.type && event.type !== filter.type) continue;
      if (filter.source && event.source !== filter.source) continue;
      if (filter.sessionId && event.sessionId !== filter.sessionId) continue;
      if (filter.since && event.ts < filter.since) continue;
      out.push(event);
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export function queryByTurn(turnId) {
  try {
    if (!turnId) return [];
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.correlationId === turnId || event.sessionId === turnId || event.data?.turnId === turnId) {
        out.push(event);
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

export function queryByTool(toolName) {
  try {
    if (!toolName) return [];
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type.startsWith('tool.') && event.data?.tool === toolName) {
        out.push(event);
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

export function getStats() {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const typeCount = {};
    const sourceCount = {};
    const timeWindows = {
      last1m: 0,
      last5m: 0,
      last1h: 0,
      last24h: 0,
      all: 0,
    };
    const currentTs = Date.now();
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      typeCount[event.type] = (typeCount[event.type] || 0) + 1;
      sourceCount[event.source] = (sourceCount[event.source] || 0) + 1;
      const ageMsec = currentTs - event.ts;
      if (ageMsec <= 60000) timeWindows.last1m += 1;
      if (ageMsec <= 300000) timeWindows.last5m += 1;
      if (ageMsec <= 3600000) timeWindows.last1h += 1;
      if (ageMsec <= 86400000) timeWindows.last24h += 1;
      timeWindows.all += 1;
    }
    return {
      path: LEDGER_PATH,
      eventsByType: typeCount,
      eventsBySource: sourceCount,
      timeWindows,
      totalEvents: timeWindows.all,
    };
  } catch {
    return {
      path: LEDGER_PATH,
      eventsByType: {},
      eventsBySource: {},
      timeWindows: { last1m: 0, last5m: 0, last1h: 0, last24h: 0, all: 0 },
      totalEvents: 0,
    };
  }
}

export function stats() {
  try {
    const stat = fs.statSync(LEDGER_PATH);
    return { path: LEDGER_PATH, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { path: LEDGER_PATH, bytes: 0, updatedAt: null };
  }
}

export default { recordEvent, recentEvents, stats, getStats, queryByTurn, queryByTool, shouldRecordEvent, path: LEDGER_PATH };
