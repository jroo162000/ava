// Spoken-reply shaping utilities: budget normalization, TTS number/homograph/pronunciation
// handling, Markdown stripping, Moltbook STT-mishear repair, and step-status detection.
// Extracted verbatim from routes/api.js (Tier 2 split) — logic unchanged.
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../utils/config.js';

/**
 * Detect if response is a step execution status message (not natural language)
 */
function isStepStatusMessage(text) {
  if (!text || typeof text !== 'string') return false;

  const textClean = text.trim().toLowerCase();

  // Exact match blacklists
  const exactBlacklist = ['done', 'ready', 'ok', 'okay', 'success', 'complete', 'completed', 'finished'];
  if (exactBlacklist.includes(textClean)) return true;

  // Very short responses
  if (textClean.length <= 3) return true;

  // Pattern matching
  const stepPatterns = [
    /reached step \d+ of \d+/i,
    /currently running without any further actions/i,
    /executing step \d+/i,
    /plan step \d+/i,
    /completed \d+ of \d+ steps/i,
    /no further actions? to execute/i,
    /step \d+ complete/i,
    /task (complete|completed|finished|done)/i,
    /operation (complete|completed|finished|done)/i,
    /action (complete|completed|finished|done)/i,
    /i will execute/i,
    /i am (executing|running|processing)/i,
    /tool (executed|called|invoked)/i,
    /function (executed|called|invoked)/i,
    /automation (complete|completed|finished)/i,
    /working on step \d+/i,
    /step \d+ (done|finished|complete)/i,
    // Additional patterns for step status messages
    /current step \d+/i,
    /step \d+ of \d+/i,
    /completed successfully/i,
    /successfully completed/i,
    /execution complete/i,
    /process(ing)? complete/i,
    /running step/i,
    /proceeding to step/i,
    /moving to step/i,
  ];

  return stepPatterns.some(pattern => pattern.test(text));
}

// STT (Whisper) routinely garbles "Moltbook" — her AI-agent social network feature — into
// non-words ("moat book", "mote book", "malt book", "mold book", "molt book") or, in context,
// real words ("notebook", "more book"). Normalize those to "moltbook" so intent routing and the
// model aren't derailed by the exact transcription. The original user text is still what gets
// logged; this only cleans the copy used for understanding/routing.
function normalizeMoltbookMentions(text) {
  let s = String(text || '');
  // Clear non-word mishears — safe to map unconditionally.
  s = s.replace(/\b(moat ?book|mote ?book|molt ?book|mold ?book|malt ?book|mault ?book|moult ?book|vault ?book|moat ?books)\b/gi, 'moltbook');
  // Real-word mishears ("notebook", "more book") — only when context is clearly the AI social
  // network / posting, so legitimate uses of those words aren't clobbered.
  if (/\b(ai|agent|agents|social|feed|post|posts|posted|posting|platform|network|community|upvote|submolt|comment)\b/i.test(s)) {
    s = s.replace(/\b(note ?book|notebook|more ?book|moor ?book|moot ?book)\b/gi, 'moltbook');
  }
  return s;
}

function normalizeSpokenReplyBudget(body = {}) {
  const voiceMode = String(body.voice_mode || body.voiceMode || '').toLowerCase();
  const rawBudget = body.spoken_reply_budget || body.spokenReplyBudget || {};
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const defaults = voiceMode === 'spoken'
    ? { maxSentences: 2, maxWords: 28 }
    : { maxSentences: 4, maxWords: 60 };

  return {
    voiceMode,
    maxSentences: parsePositiveInt(rawBudget.max_sentences ?? rawBudget.maxSentences, defaults.maxSentences),
    maxWords: parsePositiveInt(rawBudget.max_words ?? rawBudget.maxWords, defaults.maxWords),
  };
}

// --- Spoken-number normalization: say numbers the way a person would when HEARD, not read ---
const _ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const _TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function _twoDigitsToWords(n) {
  n = parseInt(n, 10);
  if (n < 20) return _ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${_TENS[t]}-${_ONES[o]}` : _TENS[t];
}
// 1999 -> "nineteen ninety-nine"; 2005 -> "two thousand five"; 1905 -> "nineteen oh five"
function _yearToWords(y) {
  const n = parseInt(y, 10);
  if (n >= 2000 && n <= 2009) return n % 10 ? `two thousand ${_ONES[n % 10]}` : 'two thousand';
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return `${_twoDigitsToWords(hi)} hundred`;
  if (lo < 10) return `${_twoDigitsToWords(hi)} oh ${_ONES[lo]}`;
  return `${_twoDigitsToWords(hi)} ${_twoDigitsToWords(lo)}`;
}
const _DIGIT_WORD = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
// Read an ID/code/serial out character by character (digits become words, letters stay).
function _spellChars(tok) {
  return String(tok).split('').map(c => _DIGIT_WORD[c] || c.toLowerCase()).filter(Boolean).join(' ');
}
// Homograph disambiguation for TTS. The Piper/espeak engine already pronounces MOST homographs
// correctly from context (measured: it nails read-present, lead-verb, live, tear, bass, wound,
// record-noun/verb, etc.). It only mis-says a small, MEASURED set — so we surgically respell ONLY
// those, to a token verified to phonemize correctly, and only in the sense the engine gets wrong.
// This affects the spoken copy only; the on-screen text keeps the real spelling. Toggle off with
// AVA_HOMOGRAPH_OFF=1.
function disambiguateHomographs(text) {
  if (process.env.AVA_HOMOGRAPH_OFF === '1') return text;
  const HOMO = new Set(['read', 'lead', 'close', 'excuse', 'wind', 'bow', 'dove', 'minute']);
  const tokens = []; const re = /[A-Za-z']+/g; let m;
  while ((m = re.exec(text))) tokens.push({ w: m[0], i: m.index, lw: m[0].toLowerCase() });
  if (!tokens.length) return text;
  const words = tokens.map(t => t.lw);
  const repl = {};
  for (let k = 0; k < tokens.length; k++) {
    const w = words[k]; if (!HOMO.has(w)) continue;
    const prev = (n) => words[k - n] || ''; const next = (n) => words[k + n] || '';
    const around = words.slice(Math.max(0, k - 4), k + 5);
    let r = null;
    if (w === 'read') {                                   // past tense -> "red" (engine says "reed")
      const PERF = new Set(['have', 'has', 'had', 'having', "i've", "we've", "you've", "they've", "i'd", "we'd", "you'd", "they'd", "he'd", "she'd", 'just', 'already', 'recently']);
      const PAST = new Set(['yesterday', 'ago', 'earlier', 'already', 'recently', 'then', 'last']);
      if (PERF.has(prev(1)) || PERF.has(prev(2)) || PAST.has(prev(1)) || around.some(x => PAST.has(x))) r = 'red';
    } else if (w === 'lead') {                            // the metal -> "led" (engine says "leed")
      const METAL = new Set(['pipe', 'pipes', 'paint', 'poison', 'poisoning', 'solder', 'acid', 'metal', 'bullet', 'bullets', 'toxic', 'molten', 'dust', 'exposure', 'levels', 'free', 'based']);
      if (METAL.has(next(1)) || METAL.has(next(2)) || METAL.has(prev(1)) || prev(1) === 'heavy') r = 'led';
    } else if (w === 'close') {                           // verb -> "cloze" (/z/); adjective stays /s/
      const OBJ = new Set(['the', 'this', 'that', 'your', 'my', 'our', 'his', 'her', 'their', 'it', 'them', 'a', 'an', 'up', 'down', 'out', 'off', 'everything', 'all']);
      const ADJN = new Set(['to', 'friend', 'friends', 'call', 'by', 'enough', 'proximity', 'range', 'second', 'attention', 'eye', 'watch', 'relationship', 'family', 'ties', 'together', 'quarters']);
      const ADJP = new Set(['so', 'very', 'too', 'how', 'getting', 'pretty', 'real', 'more', 'less', 'quite', 'extremely', 'super', 'really']);
      if (ADJN.has(next(1)) || ADJP.has(prev(1))) r = null;
      else if (OBJ.has(next(1))) r = 'cloze';
    } else if (w === 'excuse') {                          // verb -> "excuze" (/z/); noun stays /s/
      const VOBJ = new Set(['me', 'him', 'her', 'us', 'them', 'myself', 'yourself', 'ourselves', 'my', 'the', 'his', 'their']);
      const NDET = new Set(['an', 'a', 'the', 'no', 'any', 'some', 'that', 'this', 'your', 'my', 'his', 'her', 'good', 'bad', 'weak', 'lame', 'poor', 'valid', 'great', 'another']);
      if (NDET.has(prev(1))) r = null;
      else if (VOBJ.has(next(1)) || ['to', 'will', 'please', 'would', 'can', 'may'].includes(prev(1))) r = 'excuze';
    } else if (w === 'wind') {                            // verb (wind a clock / wind up) -> "wined" /aɪ/
      const MECH = new Set(['clock', 'watch', 'spring', 'cord', 'rope', 'string', 'handle', 'crank', 'thread', 'yarn', 'bobbin', 'gear', 'clockwork']);
      if (next(1) === 'up' || next(1) === 'down') r = 'wined';
      else if (['the', 'your', 'it', 'a'].includes(next(1)) && (MECH.has(next(2)) || MECH.has(next(3)))) r = 'wined';
    } else if (w === 'bow') {                             // bend/bow-down -> "bough" /aʊ/; ribbon/weapon stay /oʊ/
      if (next(1) === 'down' || next(1) === 'to' || (prev(1) === 'a' && ['take', 'took', 'takes', 'taking', 'taken'].includes(prev(2)))) r = 'bough';
    } else if (w === 'dove') {                            // past of dive -> "dohv" /oʊ/; the bird stays /ʌ/
      const SUBJ = new Set(['i', 'he', 'she', 'we', 'they', 'you', 'who', 'then', 'just']);
      const DIR = new Set(['into', 'in', 'under', 'off', 'down', 'for', 'head', 'headfirst', 'deep', 'straight', 'beneath', 'through', 'forward']);
      if (SUBJ.has(prev(1)) && DIR.has(next(1))) r = 'dohv';
    } else if (w === 'minute') {                          // tiny -> "mynute"; the time unit stays
      const TINY = new Set(['amount', 'amounts', 'detail', 'details', 'particle', 'particles', 'quantity', 'quantities', 'trace', 'traces', 'fraction', 'difference', 'differences', 'change', 'changes', 'speck']);
      if (TINY.has(next(1))) r = 'mynute';
    }
    if (r) repl[k] = r;
  }
  if (!Object.keys(repl).length) return text;
  let out = ''; let last = 0;
  for (let k = 0; k < tokens.length; k++) {
    if (repl[k]) { out += text.slice(last, tokens[k].i) + repl[k]; last = tokens[k].i + tokens[k].w.length; }
  }
  out += text.slice(last);
  return out;
}

// Pronunciation lexicon (TTS): word -> respelling the voice engine actually says correctly.
// Seeded with her OWN name — the engine says "AVA"/"Ava" as "AH-vuh" (/ˈɑːvə/) or spells out
// "A. V. A.", but she's "Aiva" = /ˈeɪvə/ ("AY-vuh"). This is a pronunciation dictionary, not a
// behavioral hardcode: it's case-insensitive, whole-word, spoken-copy-ONLY (the on-screen text
// keeps the real "AVA" spelling), and EXTENSIBLE/learnable via ava-integration/ava_pronunciations.json
// (add "name": "respelling" entries to teach her new names; keys starting with _ are ignored).
let _pronLexicon = null;
function loadPronunciationLexicon() {
  if (_pronLexicon) return _pronLexicon;
  const lex = { ava: 'Aiva' };  // built-in seed so her own name is always right
  try {
    const candidates = [
      config.AVA_INTEGRATION_DIR ? path.join(config.AVA_INTEGRATION_DIR, 'ava_pronunciations.json') : null,
      path.join(process.cwd(), '..', 'ava-integration', 'ava_pronunciations.json'),
      path.join(os.homedir(), 'ava', 'ava-integration', 'ava_pronunciations.json'),
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const [k, v] of Object.entries(data || {})) {
          if (k && !k.startsWith('_') && typeof v === 'string' && v.trim()) lex[k.toLowerCase()] = v.trim();
        }
        break;
      }
    }
  } catch { /* fall back to the built-in seed */ }
  _pronLexicon = lex;
  return lex;
}
function applyPronunciationLexicon(text) {
  if (process.env.AVA_PRON_LEXICON_OFF === '1') return text;
  const lex = loadPronunciationLexicon();
  let s = String(text || '');
  for (const [word, say] of Object.entries(lex)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\b${esc}\\b`, 'gi'), say);
  }
  return s;
}

// Make spoken text TTS-friendly: drop stray markdown symbols and voice numbers by context.
function normalizeForSpeech(text) {
  let s = String(text || '');
  // (a) Strip any stray markdown so TTS never reads symbols aloud (defense-in-depth).
  s = s.replace(/```[\s\S]*?```/g, ' ')
       .replace(/`([^`]*)`/g, '$1')
       .replace(/^\s{0,3}#{1,6}\s+/gm, '')
       .replace(/^\s*[-*+]\s+/gm, '')
       .replace(/\*\*([^*]+)\*\*/g, '$1')
       .replace(/\*([^*]+)\*/g, '$1')
       .replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1')
       .replace(/~~([^~]+)~~/g, '$1');
  // (a.4) Apply the pronunciation lexicon (her name "AVA" -> "Aiva", plus any learned names).
  s = applyPronunciationLexicon(s);
  // (a.5) Fix the handful of homographs the TTS engine mispronounces (read-past, lead-metal,
  // close/excuse verbs, wind/bow/dove/minute) — measured + verified, spoken copy only.
  s = disambiguateHomographs(s);
  if (process.env.AVA_SPEAK_NUMBERS_OFF === '1') return s.replace(/[ \t]{2,}/g, ' ');
  // (b) An ID/code/serial/version after a cue word: read it out character by character.
  s = s.replace(/\b(id|number|code|serial|confirmation|reference|ref|order|account|invoice|ticket|version|build|commit|hash|pin|phone|model)\b([:#.\s]+)([A-Za-z]*\d[A-Za-z0-9._-]*|\d{3,})/gi,
    (m, cue, sep, tok) => `${cue}${sep}${_spellChars(tok.replace(/[._-]/g, ''))}`);
  // (c) Hex-like ID tokens (digits + a–f letters, 6+ chars) anywhere — e.g. change "7bfcdc6b".
  s = s.replace(/\b(?=[a-f0-9]*\d)(?=[a-f0-9]*[a-f])[a-f0-9]{6,}\b/gi, (m) => _spellChars(m));
  // (d) Years: a bare 4-digit 1500–2099 that isn't a price/decimal/thousand -> say it as a year.
  s = s.replace(/(^|[^\w$£€])((1[5-9]|20)\d{2})(?![\w%]|[.,]\d)/g, (m, pre, yr) => `${pre}${_yearToWords(yr)}`);
  return s.replace(/[ \t]{2,}/g, ' ');
}

function shapeSpokenReply(text, body = {}) {
  let reply = typeof text === 'string' ? text.trim() : '';
  if (!reply) return '';

  const budget = normalizeSpokenReplyBudget(body);
  if (budget.voiceMode !== 'spoken') return reply;

  reply = normalizeForSpeech(reply);

  const sentenceMatches = reply.match(/[^.!?]+[.!?]?/g) || [reply];
  reply = sentenceMatches.slice(0, budget.maxSentences).join(' ').replace(/\s+/g, ' ').trim();

  const words = reply.split(/\s+/).filter(Boolean);
  if (words.length > budget.maxWords) {
    reply = words.slice(0, budget.maxWords).join(' ').replace(/[,:;]+$/g, '').trim();
    if (reply && !/[.!?]$/.test(reply)) {
      reply += '.';
    }
  }

  return reply;
}

export {
  isStepStatusMessage,
  normalizeMoltbookMentions,
  normalizeSpokenReplyBudget,
  disambiguateHomographs,
  loadPronunciationLexicon,
  applyPronunciationLexicon,
  normalizeForSpeech,
  shapeSpokenReply,
};
