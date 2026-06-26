// conversationHistory — reads AVA's voice conversation logs (daily JSONL) and exposes
// them with LOCAL dates + timestamps, windowed by a time reference in the user's request
// ("today", "yesterday", "last few days", a specific date). File-backed, so a restart
// never loses access. Used by the recall path to summarize past conversations in detail.
import fs from 'fs';
import path from 'path';
import os from 'os';

// Log timestamps are UTC; convert to the user's local time for display/windowing.
const OFFSET_MIN = parseInt(process.env.AVA_TZ_OFFSET_MIN || '-300', 10); // default CDT (UTC-5)

function logsDir() {
  const cands = [
    path.join(process.cwd(), 'logs', 'conversations'),
    path.join(os.homedir(), 'ava', 'ava-server', 'logs', 'conversations'),
    path.join(os.homedir(), 'ava-server', 'logs', 'conversations'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}
function dayFiles() {
  try { return fs.readdirSync(logsDir()).filter((f) => /^conversation-.*\.jsonl$/.test(f)).sort(); }
  catch { return []; }
}
function toLocal(tsUtc) {
  const ms = Date.parse(tsUtc);
  if (isNaN(ms)) return { date: '', time: '' };
  const iso = new Date(ms + OFFSET_MIN * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
function localToday() { return new Date(Date.now() + OFFSET_MIN * 60000).toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function readRecentTurns(maxFiles = 14) {
  const dir = logsDir();
  const files = dayFiles().slice(-maxFiles);
  const turns = [];
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      if (e.type !== 'message') continue;            // skip session_start etc.
      const c = String(e.content || '').trim();
      if (!c) continue;
      const { date, time } = toLocal(e.timestamp);
      turns.push({ date, time, who: e.direction === 'assistant' ? 'AVA' : 'You', content: c });
    }
  }
  turns.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return turns;
}

export function availableDates() {
  const map = {};
  for (const t of readRecentTurns(30)) map[t.date] = (map[t.date] || 0) + 1;
  return Object.entries(map).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
}

// Pick the conversation turns relevant to the query's time reference (local dates).
export function windowForQuery(userText, opts = {}) {
  const t = String(userText || '').toLowerCase();
  const today = localToday();
  const all = readRecentTurns(opts.maxFiles || 16);
  let from, to, label;
  if (/\b(today|this morning|earlier today|so far today)\b/.test(t)) { from = today; to = today; label = 'today'; }
  else if (/\byesterday\b/.test(t)) { from = addDays(today, -1); to = addDays(today, -1); label = 'yesterday'; }
  else if (/\blast week\b/.test(t)) { from = addDays(today, -13); to = addDays(today, -7); label = 'last week'; }
  else if (/\b(this week|last few days|past few days|recent days|recently|lately|past couple( of)? days|these last few days|few days)\b/.test(t)) { from = addDays(today, -6); to = today; label = 'the last few days'; }
  else if (/\b(everything|our (whole|entire)|all our|ever|all of our)\b/.test(t)) { from = addDays(today, -30); to = today; label = 'our recent history'; }
  else {
    const iso = t.match(/\b(20\d\d-\d\d-\d\d)\b/);
    if (iso) { from = iso[1]; to = iso[1]; label = iso[1]; }
    else { from = addDays(today, -3); to = today; label = 'our recent conversations'; }
  }
  let turns = all.filter((x) => x.date >= from && x.date <= to);
  if (!turns.length) { turns = all.slice(-40); label = label || 'our recent conversations'; }
  const maxTurns = opts.maxTurns || 160;
  if (turns.length > maxTurns) turns = turns.slice(-maxTurns);
  return { label, from, to, turns };
}

export function formatTurns(turns, maxChars = 8000) {
  const lines = (turns || []).map((x) => `[${x.date} ${x.time} ${x.who}] ${x.content}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = '…(earlier turns omitted)\n' + text.slice(text.length - maxChars);
  return text;
}

export default { readRecentTurns, availableDates, windowForQuery, formatTurns };
