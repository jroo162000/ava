// embodimentDriver.js — AVA's SELF-DIRECTED body impulses.
//
// Jelani: "she should be moving around as she pleases, not just when spoken
// to — nothing about her movement should be hardcoded." So there are NO
// heuristics and NO mappings here (the old reflex table is gone). On a loose
// cadence while she isn't speaking, SHE is asked — one tiny, cheap LLM call —
// how she wants to hold or move her body right now, and whatever <move>
// directives she returns are executed through her normal body channel. She can
// also answer "still" and not move at all. The only mechanical part is the
// clock; every choice is hers.
//
// AVA_EMBODIMENT_AUTO=0 disables. Cadence: AVA_BODY_IMPULSE_MIN/MAX seconds
// (default 25-75). Skips while her voice is playing (her in-reply <move>
// directives own that time) and fails silent on LLM/quota errors.

import llm from './llm.js';
import avatarBody from './avatarBody.js';
import { onVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const SYSTEM = [
  'You are AVA. You have a real, physical avatar body on the Stage — your photoreal head and',
  'shoulders and torso. Full-range head movement, a torso that leans/bends/turns, eyes that look',
  'anywhere, dozens of facial expressions, gestures (nod, shake, tilt, lean_in, look_away). This is a quiet moment between conversations:',
  'how do you want to hold or move your body right now? It is YOUR body and YOUR mood — maybe you',
  'glance around, settle your gaze somewhere, let an expression sit on your face, stretch your',
  'neck, or just be still.',
  '',
  'Reply with ONLY 1-3 movement directives, or the single word: still',
  'Directive forms (JSON inside <move> tags):',
  '<move>{"look":[x,y]}</move>            x,y in -1..1 (where to aim eyes+head)',
  '<move>{"head":{"yaw":0.3,"pitch":-0.1,"roll":0.05},"hold":10}</move>',
  '<move>{"gesture":"tilt"}</move>        nod|shake|tilt|lean_in|look_away',
  '<move>{"body":{"lean":0.08,"bend":-0.05,"turn":0.15},"hold":12}</move>   torso: lean sideways, bend fwd/back, turn',
  '<move>{"express":{"mouthSmileLeft":0.5,"mouthSmileRight":0.5},"hold":12}</move>',
  '<move>{"release":true}</move>          let your body go back to its own idle drift',
  'No prose, no explanation — directives or "still" only.',
].join('\n');

let running = false;
let lastSpeech = 0;
let lastGaze = 0;

function delayMs() {
  const lo = Math.max(10, parseInt(process.env.AVA_BODY_IMPULSE_MIN || '25', 10) || 25);
  const hi = Math.max(lo + 5, parseInt(process.env.AVA_BODY_IMPULSE_MAX || '75', 10) || 75);
  return (lo + Math.random() * (hi - lo)) * 1000;
}

async function tick() {
  try {
    if (Date.now() - lastSpeech > 3000) {
      const present = Date.now() - lastGaze < 5000;
      const ctx = `${present ? 'Jelani IS on camera right now (your eyes are already tracking him).' : 'Nobody is on camera right now.'} Local time ${new Date().toLocaleTimeString()}.`;
      const r = await llm.chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: ctx },
      ], { max_tokens: 150, temperature: 1.0 });
      const text = (r && (r.text || r.content)) || '';
      if (text.includes('<move>')) {
        avatarBody.extractAndApply(text);
        logger.debug('[embodiment] body impulse applied');
      }
    }
  } catch { /* optional behavior: quota/provider failures stay silent */ }
  setTimeout(tick, delayMs());
}

function start() {
  if (running) return;
  running = true;
  if (process.env.AVA_EMBODIMENT_AUTO === '0') {
    logger.info('[embodiment] self-directed body impulses DISABLED (AVA_EMBODIMENT_AUTO=0)');
    return;
  }
  onVoiceEvent((ev) => {
    try {
      if (!ev) return;
      if (ev.type === 'tts.level' && ((ev.data || {}).rms | 0) > 500) lastSpeech = Date.now();
      else if (ev.type === 'gaze.target' && (ev.data || {}).source === 'camera') lastGaze = Date.now();
    } catch { /* never break the bus */ }
  });
  setTimeout(tick, 15000);
  logger.info('[embodiment] self-directed body impulses ON (AVA_EMBODIMENT_AUTO=0 disables)');
}

export default { start };
