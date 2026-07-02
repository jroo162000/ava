// turnGuard.js -- clean task-switch / interrupt handling.
// Each conversational turn for a session gets a monotonically increasing token. If a NEWER turn
// begins for the same session while an older one is still working (barge-in, or the user types
// while voice is mid-thought), the older turn detects it's been superseded at its emit point and
// drops its now-stale reply instead of speaking over the new one. In-memory only, per session.
const _gen = new Map();
const _pending = new Map(); // sessionId -> Set<token>

export function begin(sessionId) {
  const s = String(sessionId || 'default');
  const n = (_gen.get(s) || 0) + 1;
  _gen.set(s, n);
  // Track this token as pending; any prior pending tokens for this session remain tracked
  // but will be auto-dropped when they emit and fail isCurrent. Also clean up old pending.
  if (!_pending.has(s)) _pending.set(s, new Set());
  _pending.get(s).add(n);
  return n;
}

// True if `token` is still the latest turn for this session (i.e. not superseded).
export function isCurrent(sessionId, token) {
  return (_gen.get(String(sessionId || 'default')) || 0) === token;
}

// Register that a completion (belonging to `token`) has finished emitting (success or discard).
// This removes it from the pending set to allow eventual GC of the session's pending set.
export function complete(sessionId, token) {
  const s = String(sessionId || 'default');
  const set = _pending.get(s);
  if (set) {
    set.delete(token);
    if (set.size === 0) _pending.delete(s);
  }
}

// Returns the number of pending (in-flight) completions for a session, useful for diagnostic logging.
export function pendingCount(sessionId) {
  const s = String(sessionId || 'default');
  const set = _pending.get(s);
  return set ? set.size : 0;
}

export default { begin, isCurrent, complete, pendingCount };
