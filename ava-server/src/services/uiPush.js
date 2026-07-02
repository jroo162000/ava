// uiPush.js — Tier 2 #15 (transport unification): push state CHANGES to the UI over the
// voiceBus -> /voice/ws WebSocket so the client never polls. Helpers fetch the current
// snapshot at its source of truth and emit it; callers fire-and-forget at every mutation
// point. Best-effort by design — a failed push only means the UI catches up on its
// reconnect snapshot refresh (the client re-fetches once whenever the socket opens).
import pythonWorker from './pythonWorker.js';
import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

// Self-modification proposals awaiting approval — pushed after every propose/approve/
// reject/undo so the UI's approval cards update the moment the queue changes.
export async function pushSelfModPending() {
  try {
    const r = await pythonWorker.selfMod({ action: 'list_pending' });
    const result = (r && r.result) || r || {};
    const list = result.pending || result.modifications || [];
    emitVoiceEvent('selfmod.pending', { pending: Array.isArray(list) ? list : [] }, 'server');
  } catch (e) {
    logger.warn('[ui-push] selfmod.pending push failed', { error: e.message });
  }
}

export default { pushSelfModPending };
