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
// Single-asterisk roleplay emotes: *tilts head*, *lets a slow smile spread...*
// (never **bold**). She emotes this way NATURALLY — so instead of fighting the
// habit, we treat emotes as movement intent: strip them from her words and
// hand the description to a tiny LLM that translates it into <move> directives.
const EMOTE_RE = /(^|[^*])\*([A-Za-z][^*\n]{1,239}?)\*(?!\*)/g;  // letter-led: '5 * 3 * 2' math stays intact
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

/** Translate a natural-language self-action ("tilts head, smiling") into
 *  <move> directives via one tiny LLM call, then execute them. Fire-and-forget:
 *  failures mean no movement, never broken text. */
async function interpretEmotes(emotes) {
  try {
    const llm = (await import('./llm.js')).default;
    const r = await llm.chat([
      { role: 'system', content: 'Translate the described body action of a 3D avatar (head, eyes, torso, facial expression) into 1-4 movement directives. Available: <move>{"look":[x,y]}</move> (x,y -1..1), <move>{"head":{"yaw":n,"pitch":n,"roll":n},"hold":s}</move> (radians, max 0.6), <move>{"gesture":"nod|shake|tilt|lean_in|look_away"}</move>, <move>{"body":{"lean":n,"bend":n,"turn":n},"hold":s}</move> (torso, max 0.15/0.15/0.3), <move>{"express":{"<ARKitMorphName>":0..1},"hold":s}</move> (e.g. mouthSmileLeft, mouthSmileRight, browInnerUp, eyeSquintLeft, cheekSquintLeft, eyeWideLeft). Reply with ONLY the directives, nothing else.' },
      { role: 'user', content: emotes.join('. ') },
    ], { max_tokens: 200, temperature: 0.4 });
    const text = (r && (r.text || r.content)) || '';
    if (text.includes('<move>')) extract(text, true);
  } catch { /* movement is best-effort; her words were already cleaned */ }
}

/** Remove complete <move> tags AND *emote* spans. execute=true runs the tags
 *  and asynchronously interprets the emotes (once per reply). */
export function extract(text, execute) {
  let s = String(text || '');
  if (s.indexOf('<move>') >= 0) {
    s = s.replace(TAG_RE, (m, json) => {
      if (execute) {
        try { applyDirective(JSON.parse(json)); }
        catch (e) { logger.debug('[avatarBody] bad directive dropped', { error: e.message }); }
      }
      return ' ';
    });
  }
  // A model can be interrupted mid-directive or emit malformed JSON without a
  // closing tag. Treat every remaining move-tag fragment as control-channel
  // data, never user-facing text. Complete directives were already executed
  // above; incomplete directives are intentionally dropped rather than guessed.
  s = s
    .replace(/<move\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<\/?move\b[^>]*>/gi, ' ')
    .replace(/<\/?mov(?:e)?[^>]*$/gi, ' ');
  if (s.indexOf('*') >= 0) {
    const emotes = [];
    s = s.replace(EMOTE_RE, (m, pre, action) => {
      emotes.push(action.trim());
      return pre + ' ';
    });
    if (execute && emotes.length) interpretEmotes(emotes);
  }
  return s.replace(/[ \t]{2,}/g, ' ');
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
  // unpaired single-asterisk emote still streaming in: hold from its start —
  // but only when it LOOKS like an emote (letter-led or at the very end), so a
  // lone math '*' can never stall sentence flushing.
  const lastStar = str.lastIndexOf('*');
  if (lastStar >= 0 && str[lastStar - 1] !== '*' && str[lastStar + 1] !== '*') {
    const next = str[lastStar + 1];
    const emoteish = next === undefined || /[A-Za-z]/.test(next);
    const openCount = (str.match(/(^|[^*])\*(?=[A-Za-z]|$)/g) || []).length;
    if (emoteish && openCount % 2 === 1 && str.length - lastStar < 240) return Math.max(0, lastStar - 1);
  }
  return str.length;
}

export default { applyDirective, extract, strip, extractAndApply, safeLength };
