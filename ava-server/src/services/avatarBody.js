// avatarBody.js — AVA's NATIVE body channel.
//
// Jelani's requirement: her movement must be HERS — at will, in any reply, not
// tool-gated and not hardcoded. So she embeds directives directly in her own
// output text:
//
//   <move>{"look":[0.4,0.1]}</move>
//   <move>{"gesture":"nod"}</move>
//   <move>{"express":{"mouthSmileLeft":0.6,"mouthSmileRight":0.6},"hold":6}</move>
//   <move>{"head":{"yaw":0.3,"pitch":-0.1},"hold":8}</move>
//   <move>{"release":true}</move>
//
// The server EXECUTES each directive (same avatar.* events her avatar_body tool
// uses) and STRIPS it from the text before anything is spoken, displayed, or
// logged. She decides when and how to move; this module is only transport.
// Execution owner: conversationLogger.logAssistantMessage (exactly once per
// reply). The stream route strips WITHOUT executing so nothing is double-fired
// and no tag is ever spoken mid-stream.

import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const TAG_RE = /<move>([\s\S]*?)<\/move>/g;
const GESTURES = new Set(['nod', 'shake', 'tilt', 'lean_in', 'look_away']);
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

export function applyDirective(d) {
  if (!d || typeof d !== 'object') return false;
  const holdMs = Math.round(clamp(d.hold !== undefined ? d.hold : 6, 0.5, 60) * 1000);
  let did = false;
  if (d.release) {
    emitVoiceEvent('avatar.release', {}, 'ava-body');
    did = true;
  }
  if (d.look !== undefined) {
    const arr = Array.isArray(d.look) ? d.look : [d.look.x, d.look.y];
    emitVoiceEvent('gaze.target', { x: clamp(arr[0], -1, 1), y: clamp(arr[1], -1, 1), hold_ms: holdMs, source: 'ava' }, 'ava-body');
    did = true;
  }
  if (d.head && typeof d.head === 'object') {
    emitVoiceEvent('avatar.pose', {
      yaw: clamp(d.head.yaw, -0.65, 0.65),
      pitch: clamp(d.head.pitch, -0.45, 0.45),
      roll: clamp(d.head.roll, -0.35, 0.35),
      hold_ms: holdMs,
    }, 'ava-body');
    did = true;
  }
  if (d.body && typeof d.body === 'object') {
    // Torso: lean (side, roll), bend (forward/back, pitch), turn (yaw).
    emitVoiceEvent('avatar.torso', {
      roll: clamp(d.body.lean, -0.14, 0.14),
      pitch: clamp(d.body.bend, -0.16, 0.16),
      yaw: clamp(d.body.turn, -0.3, 0.3),
      hold_ms: holdMs,
    }, 'ava-body');
    did = true;
  }
  if (d.gesture && GESTURES.has(String(d.gesture))) {
    emitVoiceEvent('avatar.gesture', { name: String(d.gesture) }, 'ava-body');
    did = true;
  }
  if (d.express && typeof d.express === 'object') {
    const morphs = {};
    let n = 0;
    for (const [k, v] of Object.entries(d.express)) {
      if (n >= 12) break;
      if (/^[a-zA-Z]{3,32}$/.test(k)) { morphs[k] = clamp(v, 0, 1); n += 1; }
    }
    if (n) {
      emitVoiceEvent('avatar.expression', { morphs, hold_ms: holdMs }, 'ava-body');
      did = true;
    }
  }
  return did;
}

/** Remove complete <move> tags. execute=true also runs them (once per reply). */
export function extract(text, execute) {
  const s = String(text || '');
  if (s.indexOf('<move>') < 0) return s;
  return s.replace(TAG_RE, (m, json) => {
    if (execute) {
      try { applyDirective(JSON.parse(json)); }
      catch (e) { logger.debug('[avatarBody] bad directive dropped', { error: e.message }); }
    }
    return ' ';
  }).replace(/[ \t]{2,}/g, ' ');
}

export const strip = (text) => extract(text, false);
export const extractAndApply = (text) => extract(text, true);

/** Length of the prefix of `s` that is SAFE to flush/emit: stops before any
 *  unclosed <move> tag or a trailing partial "<move"/"</move" prefix, so a
 *  directive split across stream deltas never leaks into speech or the UI. */
export function safeLength(s) {
  const str = String(s || '');
  // first <move> without a following </move>
  let from = 0;
  for (;;) {
    const open = str.indexOf('<move>', from);
    if (open < 0) break;
    const close = str.indexOf('</move>', open);
    if (close < 0) return open;
    from = close + 7;
  }
  // trailing partial tag start ("<", "<m", "<mo", ... or "</mov")
  const lastLt = str.lastIndexOf('<');
  if (lastLt >= 0) {
    const tail = str.slice(lastLt);
    if (tail.length < 7 && ('<move>'.startsWith(tail) || '</move>'.startsWith(tail))) return lastLt;
  }
  return str.length;
}

export default { applyDirective, extract, strip, extractAndApply, safeLength };
