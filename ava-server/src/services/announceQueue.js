// Tiny in-memory queue of short spoken announcements the voice runner pulls and speaks aloud
// (e.g., "I've queued a code change for your review"). Shared by the server (push) and the
// /voice/announcements route (drain). Bounded so it can never grow unbounded.
const _q = [];
const MAX = 20;

export function pushAnnouncement(text) {
  const t = String(text || '').trim();
  if (!t) return;
  _q.push(t);
  while (_q.length > MAX) _q.shift();
}

export function drainAnnouncements() {
  return _q.splice(0, _q.length);
}

export function pendingCount() { return _q.length; }

export default { pushAnnouncement, drainAnnouncements, pendingCount };
