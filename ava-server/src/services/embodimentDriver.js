// embodimentDriver.js — AVA's autonomous body reflexes.
//
// Why: avatar_body gives her deliberate control, but most casual replies run
// the conversational path (no tool calls), so her body sat still unless the
// agent loop happened to engage. This layer makes the body live WITHOUT the
// LLM in the loop: it listens to what she just said on the voice bus and fires
// small gestures/expressions through the same avatar.* channels her tool uses.
//
// These are GENERAL presentation reflexes (punctuation classes, a small valence
// lexicon, reply length) with randomness — not phrase-to-response mappings, and
// they change nothing about what she says or does. Her deliberate avatar_body
// calls always win (explicit pose outranks reflexes in Core3D's arbitration).
// Revert wholesale with AVA_EMBODIMENT_AUTO=0.

import { onVoiceEvent, emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const POSITIVE = /\b(great|love|nice|awesome|glad|perfect|happy|excellent|wonderful|beautiful|success|done|works|working now|got it|fixed)\b/i;
const NEGATION = /\b(no|not|can't|cannot|won't|don't|never|unfortunately|failed|error|problem|sorry)\b/i;

let started = false;
const chance = (p) => Math.random() < p;

function react(text) {
  const t = String(text || '').slice(0, 400);
  if (!t) return;
  const question = t.includes('?');
  const exclaim = t.includes('!');
  const positive = POSITIVE.test(t);
  const negation = NEGATION.test(t.slice(0, 120));   // opening stance, not any late clause

  // At most one gesture per reply, randomized so she reads alive, not scripted.
  if (negation && chance(0.6)) emitVoiceEvent('avatar.gesture', { name: 'shake' }, 'embodiment');
  else if (question && chance(0.5)) emitVoiceEvent('avatar.gesture', { name: 'tilt' }, 'embodiment');
  else if (t.length > 220 && chance(0.4)) emitVoiceEvent('avatar.gesture', { name: 'lean_in' }, 'embodiment');
  else if (positive && chance(0.45)) emitVoiceEvent('avatar.gesture', { name: 'nod' }, 'embodiment');

  // At most one expression per reply.
  if (positive && chance(0.7)) {
    emitVoiceEvent('avatar.expression', {
      morphs: { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.2, cheekSquintRight: 0.2 },
      hold_ms: 4000,
    }, 'embodiment');
  } else if (exclaim && chance(0.5)) {
    emitVoiceEvent('avatar.expression', {
      morphs: { browInnerUp: 0.45, eyeWideLeft: 0.3, eyeWideRight: 0.3 },
      hold_ms: 2500,
    }, 'embodiment');
  }
}

function start() {
  if (started) return;
  started = true;
  if (process.env.AVA_EMBODIMENT_AUTO === '0') {
    logger.info('[embodiment] autonomous body reflexes DISABLED (AVA_EMBODIMENT_AUTO=0)');
    return;
  }
  onVoiceEvent((ev) => {
    try {
      if (!ev || ev.type !== 'assistant.final') return;
      const d = ev.data || {};
      react(d.text || d.content || d.output_text || '');
    } catch { /* reflexes must never break the bus */ }
  });
  logger.info('[embodiment] autonomous body reflexes ON (AVA_EMBODIMENT_AUTO=0 reverts)');
}

export default { start };
