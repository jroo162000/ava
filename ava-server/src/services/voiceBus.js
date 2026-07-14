// voiceBus — a tiny in-process pub/sub so internal modules (conversationLogger,
// toolsService, /respond) can publish "what AVA is doing" events without importing
// the voice route (avoids circular imports). voice.js subscribes and fans these out
// to connected WebSocket UI clients.
import { EventEmitter } from 'events';
import eventLedger from './eventLedger.js';

const bus = new EventEmitter();
bus.setMaxListeners(100);

/**
 * Publish a voice/activity event. Shape matches what voice.js broadcasts:
 *   { type, timestamp(sec), data, source }
 */
export function emitVoiceEvent(type, data = {}, source = 'server') {
  const event = { type, timestamp: Date.now() / 1000, data: data || {}, source };
  try { eventLedger.recordEvent(event); } catch { /* durable evidence is best-effort */ }
  try { bus.emit('event', event); } catch { /* never let telemetry break the caller */ }
  return event;
}

export function onVoiceEvent(handler) {
  bus.on('event', handler);
}

export default bus;
