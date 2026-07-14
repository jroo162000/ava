// Tiny in-memory queue of short spoken announcements the voice runner pulls and speaks aloud
// (e.g., "I've queued a code change for your review"). Shared by the server (push) and the
// /voice/announcements route (drain). Bounded so it can never grow unbounded.
import avatarBody from './avatarBody.js';
import conversationLogger from './conversationLogger.js';

const _q = [];
const MAX = 20;

export function pushAnnouncement(text, metadata = {}) {
  // Native embodiment: announcements are her words too — execute + strip any
  // inline <move> directives so the runner never speaks a raw tag.
  let t = String(text || '').trim();
  try { t = avatarBody.extractAndApply(t).trim(); } catch { /* keep original */ }
  if (!t) return;
  _q.push(t);
  while (_q.length > MAX) _q.shift();

  // Background speech is still part of the conversation. Publish it through the
  // same logger/event path as an ordinary assistant turn so it appears in chat,
  // survives in JSONL, and can be reviewed after the voice runner speaks it.
  try {
    conversationLogger.logAssistantMessage(t, {
      ...metadata,
      responseType: metadata.responseType || 'announcement',
      source: metadata.source || 'background',
    });
  } catch { /* speech must survive a logging failure */ }
}

export function drainAnnouncements() {
  return _q.splice(0, _q.length);
}

export function pendingCount() { return _q.length; }

export default { pushAnnouncement, drainAnnouncements, pendingCount };
