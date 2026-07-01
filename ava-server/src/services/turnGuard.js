// turnGuard.js -- clean task-switch / interrupt handling.
// Each conversational turn for a session gets a monotonically increasing token. If a NEWER turn
// begins for the same session while an older one is still working (barge-in, or the user types
// while voice is mid-thought), the older turn detects it's been superseded at its emit point and
// drops its now-stale reply instead of speaking over the new one. In-memory only, per session.
const _gen = new Map();

export function begin(sessionId) {
  const s = String(sessionId || 'default');
  const n = (_gen.get(s) || 0) + 1;
  _gen.set(s, n);
  return n;
}

// True if `token` is still the latest turn for this session (i.e. not superseded).
export function isCurrent(sessionId, token) {
  return (_gen.get(String(sessionId || 'default')) || 0) === token;
}

export default { begin, isCurrent };
