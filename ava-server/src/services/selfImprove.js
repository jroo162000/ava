// selfImprove.js — AVA's autonomous self-improvement loop.
//
// Gathers improvement signals (tracked issues from Moltbook, recent failed commands from the
// conversation logs, and code diagnostics), asks the decision model to draft ONE small, safe,
// concrete code change, and stages it as a *proposed* self-modification. Nothing is ever
// applied here — every proposal lands in the same pending store the UI panel and voice
// approval read from, so the user reviews the diff and approves (UI button or voice) first.
//
// Safety: changes are expressed as a single exact find/replace that must appear exactly once
// in the target file (no blind full-file rewrites). The approval gate (ava_self_modification's
// PROTECTED_BASENAMES) independently refuses proposals against the approval/safety code.

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import pythonWorker from './pythonWorker.js';
import announceQueue from './announceQueue.js';
import personaSvc from './persona.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const LOG_PATH = path.join(DATA_DIR, 'self-improve-log.jsonl');

let _timer = null;
let _running = false;

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

// Compose the spoken heads-up when a proposal is queued — in AVA's own voice, varied and
// natural, NOT a fixed "Heads up" template. Falls back to rotating natural lines if the LLM
// is unavailable. (Toggle the LLM phrasing off with AVA_ANNOUNCE_LLM_OFF=1.)
let _annIdx = 0;
function _fallbackAnnouncement({ file, reason, recommendation, id }) {
  const what = reason || ('an improvement to ' + path.basename(file));
  const openers = [
    `So, I went ahead and queued a change for you to look at`,
    `When you get a sec — I staged a code change`,
    `Got one for your review`,
    `I spotted something worth fixing and queued it up`,
    `There's a change waiting on your okay`,
    `Okay, so — I put together a small change`,
  ];
  const opener = openers[_annIdx++ % openers.length];
  return `${opener}: ${what}. My read on it: ${recommendation}. ` +
    `You can say "approve change ${id}" or "reject it", or use the panel.`;
}
async function composeProposalAnnouncement(info) {
  const { file, reason, recommendation, reviewReason, id } = info;
  try {
    if (process.env.AVA_ANNOUNCE_LLM_OFF === '1') return _fallbackAnnouncement(info);
    const persona = personaSvc.buildPersonaBlock();
    const sys = `${persona}\n\nYou just autonomously found a small improvement to your OWN code and queued it for the user to approve. Say a SHORT heads-up out loud, in your own voice — natural, the way you'd actually bring it up, NOT a template, with NO canned opener like "Heads up". One or two sentences: say plainly what the change does and your honest read on it, then let them know they can say "approve change ${id}" or "reject it", or use the panel. Spoken aloud — plain text, no markdown or symbols.`;
    const usr = `File: ${path.basename(file)}\nWhat the change does: ${reason || 'a small improvement'}\nReviewer recommendation: ${recommendation}\nReviewer note: ${reviewReason || ''}`;
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { temperature: 0.7, max_tokens: 220 }
    );
    const text = ((r && (r.content || r.text)) || '').trim();
    if (text && text.length > 12) return text;
  } catch (e) {
    logger.warn?.('[selfImprove] announcement compose failed; using fallback', { error: e.message });
  }
  return _fallbackAnnouncement(info);
}

function logEntry(obj) {
  try { ensureDir(); fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), ...obj }) + '\n'); } catch {}
}

function recentProposalAvoidTerms() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const since = Date.now() - Math.max(1, parseInt(process.env.AVA_SELF_IMPROVE_AVOID_HOURS || '24', 10)) * 3600 * 1000;
    const max = Math.max(0, parseInt(process.env.AVA_SELF_IMPROVE_RECENT_AVOID || '16', 10));
    if (!max) return [];
    const terms = [];
    for (const line of fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).slice(-200)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if ((j.ts || 0) < since) continue;
        const file = j.file ? path.basename(String(j.file)) : '';
        const why = String(j.why || j.issue || j.note || '').trim();
        const status = String(j.status || j.note || '').toLowerCase();
        if (!file && !why) continue;
        if (status.includes('proposed') || status.includes('applied') || status.includes('rejected') || status.includes('avoided repeated')) {
          terms.push([file, why].filter(Boolean).join(' ').slice(0, 260));
        }
      } catch {}
    }
    return [...new Set(terms.filter(Boolean))].slice(-max);
  } catch { return []; }
}

// --- Signal collection -------------------------------------------------------
function openIssues() {
  try {
    const p = path.join(DATA_DIR, 'moltbook-issues.json');
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.issues || []);
    return arr.filter(i => String(i.status || 'open').toLowerCase() !== 'resolved').slice(-12);
  } catch { return []; }
}

function recentFailures() {
  try {
    const convDir = path.join(process.cwd(), 'logs', 'conversations');
    if (!fs.existsSync(convDir)) return [];
    const since = Date.now() - 48 * 3600 * 1000;
    const out = [];
    for (const f of fs.readdirSync(convDir).filter(x => x.endsWith('.jsonl'))) {
      let content = '';
      try { content = fs.readFileSync(path.join(convDir, f), 'utf8'); } catch { continue; }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if ((j.ts || 0) < since) continue;
          const s = JSON.stringify(j).toLowerCase();
          if (/(error|failed|traceback|exception|could not|couldn'?t|not found|unsupported)/.test(s)) {
            out.push(String(JSON.stringify(j)).slice(0, 280));
          }
        } catch {}
      }
    }
    return out.slice(-15);
  } catch { return []; }
}

function conversationGuidance() {
  try {
    const convDir = path.join(process.cwd(), 'logs', 'conversations');
    if (!fs.existsSync(convDir)) return [];
    const since = Date.now() - 72 * 3600 * 1000;
    const out = [];
    for (const f of fs.readdirSync(convDir).filter(x => x.endsWith('.jsonl'))) {
      let content = '';
      try { content = fs.readFileSync(path.join(convDir, f), 'utf8'); } catch { continue; }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if ((j.ts || 0) < since) continue;
          const text = String(j.text || j.content || j.message || JSON.stringify(j)).trim();
          const low = text.toLowerCase();
          if (/(should|shouldn'?t|don'?t|stop|make sure|learn|proposal|accurate|wrong|mistake|fix|verify|retain)/.test(low)) {
            out.push(text.slice(0, 320));
          }
        } catch {}
      }
    }
    return out.slice(-20);
  } catch { return []; }
}

// Insights AVA has learned from Moltbook (other agents) — so they can also drive code proposals.
function moltbookLearnings() {
  try {
    const repo = path.resolve(process.cwd(), '..');
    const p = path.join(repo, 'ava-integration', 'memory', 'moltbook-learnings.json');
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = (j && (j.learnings || j)) || [];
    return (Array.isArray(arr) ? arr : []).slice(-300).map(l => ({
      topic: l.topic || l.title || '',
      source: l.source || '',
      insight: String(l.insight || l.summary || l.content || l.lesson || '').slice(0, 360),
    })).filter(l => l.topic || l.insight);
  } catch { return []; }
}

async function diagnostics() {
  try { const d = await pythonWorker.selfMod({ action: 'diagnose' }); return (d && (d.diagnosis || (d.result && d.result.diagnosis) || d.result || d)) || {}; }
  catch { return {}; }
}

async function pendingProposals() {
  try { const r = await pythonWorker.selfMod({ action: 'list_pending' }); return (r && (r.pending || (r.result && r.result.pending))) || []; }
  catch { return []; }
}

// Real, editable source files (absolute paths) the model may choose from — so it never invents
// a path that doesn't exist on this machine.
function candidateFiles() {
  const cwd = process.cwd();              // ava-server
  const repo = path.resolve(cwd, '..');   // ava
  const roots = [
    path.join(cwd, 'src', 'services'),
    path.join(cwd, 'src', 'routes'),
    path.join(repo, 'cmp-use', 'cmpuse', 'tools'),
    path.join(repo, 'ava-integration'),
  ];
  const out = [];
  for (const r of roots) {
    try {
      for (const f of fs.readdirSync(r)) {
        if (!/\.(js|py)$/.test(f) || /\.test\.js$/.test(f) || f === '__init__.py') continue;
        const fp = path.join(r, f);
        try { const st = fs.statSync(fp); if (st.size < 40 || st.size > 200000) continue; } catch { continue; }
        out.push(fp);
      }
    } catch {}
  }
  return out;
}

const fileLabel = (c) => `${path.basename(path.dirname(c))}/${path.basename(c)}`;

function avoidTerms(avoid) {
  return (Array.isArray(avoid) ? avoid : [])
    .map(x => String(x || '').toLowerCase().replace(/\\/g, '/').trim())
    .filter(Boolean);
}

function isAvoidedCandidate(file, avoid) {
  const terms = avoidTerms(avoid);
  if (!terms.length) return false;
  const label = fileLabel(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  const full = String(file || '').toLowerCase().replace(/\\/g, '/');
  return terms.some(t => t.includes(base) || t.includes(label) || full.includes(t));
}

function isAvoidedIdea(file, issue, avoid) {
  const terms = avoidTerms(avoid);
  if (!terms.length) return false;
  const hay = `${fileLabel(file || '')} ${path.basename(file || '')} ${issue || ''}`.toLowerCase();
  return terms.some(t => hay.includes(t) || t.includes(path.basename(file || '').toLowerCase()));
}

// Lessons AVA has learned from past denied proposals — injected into the prompts so she does
// not repeat the same mistakes. Written by the review/test harness on each denial.
function lessonsFile() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.cmpuse', 'selfmod_lessons.json');
}
function readLessons() {
  try {
    const p = lessonsFile();
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j.slice(-30) : [];
  } catch { return []; }
}
export function addLesson(rule) {
  try {
    const r = String(rule || '').trim();
    if (!r) return false;
    const cur = readLessons();
    if (cur.some(x => x.toLowerCase() === r.toLowerCase())) return false; // dedup
    cur.push(r);
    fs.writeFileSync(lessonsFile(), JSON.stringify(cur.slice(-50), null, 2));
    return true;
  } catch { return false; }
}

function priorMistakeLessons() {
  return readLessons().map(rule => ({ source: 'rejected_proposal_or_review', lesson: rule }));
}

function proposalTestLessons() {
  try {
    const repo = path.resolve(process.cwd(), '..');
    const p = path.join(repo, 'ava-integration', 'memory', 'proposal_tests.json');
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.tests || []);
    return arr.slice(-30).map(t => ({
      id: t.id || '',
      source: t.source || 'proposal_tests',
      lesson: String(t.lesson || '').slice(0, 260),
      reject_if: String(t.reject_if || '').slice(0, 220),
    })).filter(t => t.lesson);
  } catch { return []; }
}

// Models often emit Windows paths with single backslashes (C:\Users\…), which is invalid JSON.
// Escape any backslash that isn't part of a valid JSON escape, so the value parses.
function fixBackslashes(s) {
  return String(s).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

// Robust JSON extraction: tolerates code fences, surrounding prose, and unescaped backslashes
// by scanning for the first balanced {...} object and retrying with the backslash fix.
function parseJsonLoose(s) {
  let t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  let v = tryParse(t); if (v !== undefined) return v;
  v = tryParse(fixBackslashes(t)); if (v !== undefined) return v;
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { const sl = t.slice(start, i + 1); v = tryParse(sl); if (v !== undefined) return v; v = tryParse(fixBackslashes(sl)); return v === undefined ? null : v; } }
  }
  return null;
}

function normalizeReview(raw, reviewer, model) {
  const j = parseJsonLoose(raw) || {};
  const verdict = String(j.verdict || j.recommendation || '').toLowerCase();
  const recommendation = /^(approve|verify|accept|yes)$/.test(verdict) ? 'approve'
    : /^(deny|reject|decline|no)$/.test(verdict) ? 'deny'
    : 'review';
  return {
    reviewer,
    model,
    recommendation,
    reason: String(j.reason || j.issue || j.why || raw || '').slice(0, 600),
    risks: Array.isArray(j.risks) ? j.risks.slice(0, 5).map(x => String(x).slice(0, 180)) : [],
  };
}

async function runProposalReviewer({ reviewer, model, call, file, reason, find, replace, diff }) {
  const system = [
    'You are a strict senior engineer reviewing one AVA self-modification proposal before it is shown to the user.',
    'Judge only whether this proposal is accurate, needed, minimal, and safe.',
    'Be skeptical: approve only if the stated issue is supported by the proposed edit and the edit is the right layer.',
    'Respond STRICT JSON only: {"verdict":"approve"|"deny","reason":"short reason","risks":["optional risk"]}.',
  ].join('\n');
  const user = diff
    ? [
      `FILE: ${file}`,
      `STATED REASON: ${reason}`,
      '',
      'PROPOSED CHANGE:',
      String(diff || '').slice(0, 6000),
    ].join('\n')
    : [
      `FILE: ${file}`,
      `STATED REASON: ${reason}`,
      '',
      'FIND:',
      String(find || '').slice(0, 3000),
      '',
      'REPLACE:',
      String(replace || '').slice(0, 3000),
    ].join('\n');
  try {
    const r = await call({ messages: [{ role: 'user', content: user }], system, maxTokens: 700, model });
    return normalizeReview(r.content || r.text || '', reviewer, r.model || model || reviewer);
  } catch (e) {
    return { reviewer, model: model || reviewer, recommendation: 'unavailable', reason: String(e.message || e).slice(0, 600), risks: [] };
  }
}

async function reviewProposal({ file, reason, find, replace, diff }) {
  const env = process.env;
  const reviews = [];

  reviews.push(await runProposalReviewer({
    reviewer: 'codex',
    model: env.AVA_REVIEW_OPENAI || env.AVA_OPENAI_MODEL || 'gpt-5.1',
    call: (opts) => llmService.createCompletionOpenAI(opts),
    file,
    reason,
    find,
    replace,
    diff,
  }));

  reviews.push(await runProposalReviewer({
    reviewer: 'claude-coworker',
    model: env.AVA_REVIEW_CLAUDE || env.AVA_SM_CLAUDE || 'claude-opus-4-8',
    call: (opts) => llmService.createCompletionClaude(opts),
    file,
    reason,
    find,
    replace,
    diff,
  }));

  const available = reviews.filter(r => r.recommendation !== 'unavailable');
  const denies = available.filter(r => r.recommendation === 'deny');
  const approves = available.filter(r => r.recommendation === 'approve');
  const recommendation = denies.length ? 'deny' : (approves.length ? 'approve' : 'review');
  const reviewReason = denies.length
    ? denies.map(r => `${r.reviewer}: ${r.reason}`).join(' | ')
    : approves.length
      ? approves.map(r => `${r.reviewer}: ${r.reason}`).join(' | ')
      : reviews.map(r => `${r.reviewer}: ${r.reason}`).join(' | ');

  return { recommendation, reason: reviewReason.slice(0, 1000), reviewers: reviews };
}

// --- The scan ----------------------------------------------------------------
async function runScan({ reason = 'scheduled', max = 1, avoid = [], diag: triggerDiag = null } = {}) {
  if (_running) return { ok: false, error: 'a scan is already running' };
  if (!pythonWorker.isReady || !pythonWorker.isReady()) return { ok: false, error: 'python worker not ready' };
  _running = true;
  try {
    // Anti-flood: don't pile on if several changes already await review.
    const already = await pendingProposals();
    const MAX_PENDING = Math.max(1, parseInt(process.env.AVA_SELF_IMPROVE_MAX_PENDING || '6', 10));
    if (already.length >= MAX_PENDING) {
      logEntry({ reason, proposed: 0, note: `cap reached (${already.length} pending)` });
      return { ok: true, proposed: 0, note: `Holding off — ${already.length} changes already await your review.` };
    }

    const liveDiag = await diagnostics();
    const autoAvoid = recentProposalAvoidTerms();
    const combinedAvoid = [...autoAvoid, ...(Array.isArray(avoid) ? avoid : [])];
    const issues = openIssues();
    const failures = recentFailures();
    const guidance = conversationGuidance();
    const learnings = moltbookLearnings();
    const mistakes = priorMistakeLessons();
    const proposalTests = proposalTestLessons();
    const triggerIssues = triggerDiag && Array.isArray(triggerDiag.issues) ? triggerDiag.issues : [];
    const liveIssues = liveDiag && Array.isArray(liveDiag.issues) ? liveDiag.issues : [];
    const diagIssues = [...triggerIssues, ...liveIssues];
    if (!issues.length && !failures.length && !diagIssues.length && !learnings.length && !guidance.length && !mistakes.length && !proposalTests.length) {
      logEntry({ reason, proposed: 0, note: 'no actionable signals' });
      return { ok: true, proposed: 0, note: 'Nothing to improve — no recent failures, issues, learnings, or diagnostics.' };
    }

    const signals = {
      trigger_reason: String(reason || '').slice(0, 1200),
      diagnostics: diagIssues.slice(0, 8),
      proposal_tests: proposalTests,
      prior_mistake_lessons: mistakes,
      tracked_issues: issues.map(i => ({ category: i.category, description: i.description, context: i.context })),
      recent_failures: failures,
      conversation_guidance: guidance,
      moltbook_learnings: learnings,
      already_pending: already.map(m => ({ file: m.file, reason: m.reason })),
      already_covered: combinedAvoid.slice(-80),
    };

    // STEP 1 — pick ONE target file + describe the concrete change (the model has NOT seen file
    // contents yet, so it only chooses a file and states the fix; it must not invent snippets).
    let cands = candidateFiles();
    const filtered = cands.filter(c => !isAvoidedCandidate(c, combinedAvoid));
    if (filtered.length) cands = filtered;
    const listing = cands.map(fileLabel).join('\n');
    const lessons = readLessons();
    const lessonsBlock = lessons.length
      ? '\n\nLESSONS — past proposals of yours were REJECTED for these mistakes; do NOT repeat any of them:\n' + lessons.map(l => '- ' + l).join('\n')
      : '';
    const planSys = [
      "You are AVA's self-improvement engine, improving a local voice assistant (Node server +",
      'Python cmp-use tools + integration). From the signals, choose the single most impactful,',
      'clearly-evidenced problem and the ONE source file to change.',
      'If trigger_reason contains a recent user-requested diagnosis or a just-completed diagnosis,',
      'treat that as the highest-priority signal and propose a repair for that diagnosis when a',
      'concrete safe code/config change is possible.',
      'Output STRICT JSON only (no prose, no code fences):',
      '{"file_name":"<exact entry copied from CANDIDATE_FILES, e.g. tools/open_item.py>","issue":"<specific change to make and why>"}',
      'or {"skip":true,"why":"..."} if nothing is concrete and evidenced.',
      'Copy file_name EXACTLY as listed (dir/name). Do NOT output a full path or invent a name.',
      'Never choose the approval/safety gate: ava_self_modification.py, learning.js, security.js, autonomyPolicy.js.',
      'VARIETY IS REQUIRED: choose a DIFFERENT file AND a DIFFERENT kind of improvement than ANYTHING',
      'listed in already_pending or already_covered. Never re-propose the same fix or keep returning to',
      'the same file. Draw your idea from the FULL range of signals each time — recent_failures,',
      'tracked_issues, moltbook_learnings (what you learned from other agents), and diagnostics — and',
      'rotate across the codebase so each proposal targets a genuinely new area.',
      'If the strongest idea repeats a recently rejected file/reason, choose the next best distinct',
      'source signal instead. Preference order for variety: real failures, user corrections, Moltbook',
      'agent engineering lessons, diagnostics, then small polish fixes.',
      'UPGRADE DIRECTION (the developer explicitly asked for this — weigh it heavily when no urgent',
      'failure dominates): favor concrete, high-impact self-UPGRADES that make AVA more capable and',
      'reliable, not just tiny polish. Strongly preferred directions: deeper local-environment',
      'integration (live foreground-window / system-state awareness), tighter browser & desktop-app',
      'control (reliable tab switching, URL/login/captcha handling, File Explorer mapping, open/close/',
      'save/export on common apps), better self-diagnostics, smarter memory & governance, and richer',
      'visualization/interaction with the user. Fix a real failure or diagnosis first when present;',
      'otherwise propose ONE of these capability upgrades as a small, safe, concrete code change that',
      'is a genuine step toward the capability (never a vague stub or placeholder).',
    ].join('\n') + lessonsBlock;
    const planUser = `SIGNALS:\n${JSON.stringify(signals).slice(0, 24000)}\n\nCANDIDATE_FILES (choose one, copy its name exactly):\n${listing}`;
    let plan = null;
    let planModel = '';
    try {
      const r = await llmService.chatSelfMod(
        [{ role: 'system', content: planSys }, { role: 'user', content: planUser }],
        { temperature: 0.2, max_tokens: 3000, model: process.env.AVA_SELFMOD_MODEL || 'claude-opus-4-8' }
      );
      planModel = r.provider || r.model || '';
      const raw = String(r.text || r.content || '');
      plan = parseJsonLoose(raw);
      if (!plan) logEntry({ reason, proposed: 0, note: 'plan parse failed', planModel, raw: raw.slice(0, 400) });
    } catch (e) {
      logEntry({ reason, proposed: 0, note: 'plan chat error', error: e.message });
      return { ok: true, proposed: 0, note: 'Could not draft a clean proposal this pass.' };
    }
    if (!plan || plan.skip || !plan.file_name || !plan.issue) {
      logEntry({ reason, proposed: 0, skip: true, why: plan && plan.why });
      return { ok: true, proposed: 0, note: (plan && plan.why) || 'Nothing concrete enough to propose safely.' };
    }
    // Match the chosen name back to a real candidate (by dir/name, then by basename).
    const want = String(plan.file_name).replace(/\\/g, '/').split('/').slice(-2).join('/');
    plan.file = cands.find(c => fileLabel(c) === want)
      || cands.find(c => path.basename(c) === path.basename(String(plan.file_name)));
    if (!plan.file || !fs.existsSync(plan.file)) {
      logEntry({ reason, proposed: 0, note: 'no candidate matched', file_name: plan.file_name });
      return { ok: true, proposed: 0, note: 'Model picked a file that is not in the candidate list.' };
    }
    if (isAvoidedIdea(plan.file, plan.issue, combinedAvoid)) {
      logEntry({ reason, proposed: 0, note: 'avoided repeated idea', file: plan.file, issue: plan.issue });
      return { ok: true, proposed: 0, note: 'Skipped repeated avoided proposal idea.' };
    }

    // Read the actual file (server-side fs is the reliable path; the worker has no read_file action).
    let content = null;
    try { content = fs.readFileSync(plan.file, 'utf8'); } catch (e) { logEntry({ reason, note: 'fs read error', file: plan.file, error: e.message }); }
    if (content == null || content.trim().length < 20) {
      logEntry({ reason, proposed: 0, note: 'empty/unreadable target', file: plan.file, len: content == null ? -1 : content.length });
      return { ok: true, proposed: 0, note: `Couldn't read a usable ${path.basename(plan.file)}.` };
    }

    // STEP 2 — given the real file, produce an exact find/replace.
    const editSys = [
      'You are making one small, safe edit to the file below. Output STRICT JSON only:',
      '{"find":"<substring copied VERBATIM from the file, appearing exactly once>","replace":"<the corrected text>","reason":"<one line why>"}',
      'or {"skip":true,"why":"..."}.',
      'Rules: "find" must be copied exactly from the file (same whitespace) and be unique. Keep the',
      'change minimal and correct. Do not reformat unrelated code.',
    ].join('\n') + lessonsBlock;
    const editUser = `CHANGE TO MAKE: ${plan.issue}\n\nFILE: ${plan.file}\n\n<<<FILE CONTENT>>>\n${content.slice(0, 18000)}\n<<<END>>>`;
    let edit = null;
    let editModel = '';
    try {
      const r = await llmService.chatSelfMod(
        [{ role: 'system', content: editSys }, { role: 'user', content: editUser }],
        { temperature: 0.1, max_tokens: 1600, model: process.env.AVA_SELFMOD_MODEL || 'claude-opus-4-8' }
      );
      editModel = r.provider || r.model || '';
      const raw = String(r.text || r.content || '');
      edit = parseJsonLoose(raw);
      if (!edit) logEntry({ reason, proposed: 0, note: 'edit parse failed', file: plan.file, planModel, editModel, raw: raw.slice(0, 400) });
    } catch (e) {
      logEntry({ reason, proposed: 0, note: 'edit chat error', file: plan.file, planModel, error: e.message });
      return { ok: true, proposed: 0, note: 'Identified a fix but could not draft a clean edit.' };
    }
    if (!edit || edit.skip || !edit.find || edit.replace == null) {
      logEntry({ reason, proposed: 0, skip: true, file: plan.file, why: edit && edit.why });
      return { ok: true, proposed: 0, note: (edit && edit.why) || 'No safe exact edit found.' };
    }
    const occ = content.split(edit.find).length - 1;
    if (occ !== 1) {
      logEntry({ reason, proposed: 0, note: `snippet appears ${occ}x`, file: plan.file });
      return { ok: true, proposed: 0, note: `The snippet to change appears ${occ} times in ${path.basename(plan.file)} — too ambiguous, skipping.` };
    }
    let newContent = content.replace(edit.find, edit.replace);
    // Match the file's dominant line ending so the diff is a clean targeted hunk, not whole-file
    // CRLF/LF churn (which made every proposal look like a full-file rewrite).
    if (content.includes('\r\n')) newContent = newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    else newContent = newContent.replace(/\r\n/g, '\n');
    if (newContent === content) {
      logEntry({ reason, proposed: 0, note: 'no-op change', file: plan.file });
      return { ok: true, proposed: 0, note: 'Proposed change was a no-op.' };
    }
    plan.reason = edit.reason || plan.issue;

    const proposalReview = await reviewProposal({
      file: plan.file,
      reason: plan.reason,
      find: edit.find,
      replace: edit.replace,
    });

    // Stage the proposal (gate independently refuses protected files).
    const decisionModel = planModel && editModel && planModel !== editModel ? `${planModel} -> ${editModel}` : (editModel || planModel || '');
    const metadata = {
      decisionModel,
      planModel,
      editModel,
      generatorReason: reason,
      proposedAt: new Date().toISOString(),
      reviewRecommendation: proposalReview.recommendation,
      reviewReason: proposalReview.reason,
      reviewers: proposalReview.reviewers,
    };
    const pf = await pythonWorker.selfMod({ action: 'propose_fix', file: plan.file, content: newContent, reason: plan.reason || `auto-improvement (${reason})`, metadata });
    const res = (pf && (pf.result || pf)) || {};
    logEntry({
      reason,
      file: plan.file,
      status: res.status,
      id: res.modification_id,
      why: plan.reason,
      decisionModel,
      planModel,
      editModel,
      reviewRecommendation: proposalReview.recommendation,
      reviewReason: proposalReview.reason,
    });
    if (res.status === 'proposed') {
      logger.info('[selfImprove] queued a proposal', { id: res.modification_id, file: path.basename(plan.file), reviewRecommendation: proposalReview.recommendation });
      // Spoken heads-up — composed in HER OWN voice (no fixed "Heads up" opener). The voice
      // runner polls /voice/announcements and says this aloud.
      announceQueue.pushAnnouncement(await composeProposalAnnouncement({
        file: plan.file,
        reason: plan.reason,
        recommendation: proposalReview.recommendation,
        reviewReason: proposalReview.reason,
        id: res.modification_id,
      }));
      return {
        ok: true,
        proposed: 1,
        id: res.modification_id,
        file: plan.file,
        reason: plan.reason,
        status: 'proposed',
        decisionModel,
        planModel,
        editModel,
        reviewRecommendation: proposalReview.recommendation,
        reviewReason: proposalReview.reason,
        reviewers: proposalReview.reviewers,
      };
    }
    return { ok: true, proposed: 0, status: res.status, note: res.message || 'proposal not staged' };
  } finally {
    _running = false;
  }
}

// Re-propose a REJECTED change with a NEW edit that fixes WHY it was denied. Unlike runScan, the
// target file is GIVEN (the rejected proposal's own file), so it works even when that file isn't in
// CANDIDATE_FILES. This is REQUEST-ONLY (a person explicitly asks to re-propose); the autonomous
// scan still stays inside the candidate allowlist. The approval/safety gate is still respected.
const REPROPOSE_PROTECTED = ['ava_self_modification.py', 'learning.js', 'security.js', 'autonomyPolicy.js'];

async function reproposeForFile({ file, intent = '', rejectionReason = '', fromId = '' } = {}) {
  if (!pythonWorker.isReady || !pythonWorker.isReady()) return { ok: false, error: 'python worker not ready' };
  if (!file) return { ok: false, error: 'no file to re-propose for' };
  // Resolve to an existing absolute path (accept absolute, repo-relative, or basename).
  let target = String(file);
  try {
    if (!fs.existsSync(target)) {
      const base = path.basename(target);
      const all = candidateFiles();
      target = all.find(c => path.basename(c) === base)
        || all.find(c => fileLabel(c) === target.replace(/\\/g, '/').split('/').slice(-2).join('/'))
        || target;
    }
  } catch { /* ignore */ }
  if (!fs.existsSync(target)) return { ok: false, error: `couldn't locate the file to re-propose (${path.basename(String(file))})` };
  if (REPROPOSE_PROTECTED.includes(path.basename(target))) {
    return { ok: false, error: `${path.basename(target)} is a protected safety/approval file — I won't re-propose changes to it.` };
  }
  let content = null;
  try { content = fs.readFileSync(target, 'utf8'); } catch (e) { return { ok: false, error: `couldn't read ${path.basename(target)}: ${e.message}` }; }
  if (content == null || content.trim().length < 20) return { ok: false, error: `couldn't read a usable ${path.basename(target)}` };

  const editSys = [
    'You are revising a previously REJECTED change to the file below. Produce ONE small, safe, exact find/replace edit that:',
    '1) achieves the ORIGINAL INTENT, AND',
    '2) directly FIXES the reason the earlier proposal was rejected — do not repeat that mistake.',
    'Output STRICT JSON only: {"find":"<substring copied VERBATIM from the file, appearing exactly once>","replace":"<corrected text>","reason":"<one line: what you changed and how it addresses the rejection>"}',
    'or {"skip":true,"why":"..."} if the rejection means this change should NOT be made to this file at all (e.g. it belongs in a different file).',
    'Rules: "find" must be copied exactly (same whitespace) and be unique. Keep it minimal and correct; do not reformat unrelated code.',
  ].join('\n');
  const editUser = `ORIGINAL INTENT: ${intent || '(not recorded)'}\n\nWHY THE PREVIOUS PROPOSAL WAS REJECTED: ${rejectionReason || '(not recorded — infer the likely objections: wrong file/layer, too broad, mixed concerns, unsafe, or unverified — and avoid them)'}\n\nFILE: ${target}\n\n<<<FILE CONTENT>>>\n${content.slice(0, 18000)}\n<<<END>>>`;

  let edit = null, editModel = '';
  try {
    const r = await llmService.chatSelfMod(
      [{ role: 'system', content: editSys }, { role: 'user', content: editUser }],
      { temperature: 0.1, max_tokens: 1800, model: process.env.AVA_SELFMOD_MODEL || 'claude-opus-4-8' }
    );
    editModel = r.provider || r.model || '';
    edit = parseJsonLoose(String(r.text || r.content || ''));
  } catch (e) {
    return { ok: false, error: `couldn't draft the revised edit: ${e.message}` };
  }
  if (!edit || edit.skip || !edit.find || edit.replace == null) {
    return { ok: true, proposed: 0, note: (edit && edit.why) || "on a second look, a clean fix for that rejection on this file isn't obvious — I'd rather not propose a guess." };
  }
  const occ = content.split(edit.find).length - 1;
  if (occ !== 1) return { ok: true, proposed: 0, note: `the spot to change appears ${occ} times in ${path.basename(target)} — too ambiguous to edit cleanly.` };
  let newContent = content.replace(edit.find, edit.replace);
  if (content.includes('\r\n')) newContent = newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  else newContent = newContent.replace(/\r\n/g, '\n');
  if (newContent === content) return { ok: true, proposed: 0, note: 'the revised change came out as a no-op.' };

  const reasonText = edit.reason || `Re-proposal of ${fromId || 'a rejected change'} for ${path.basename(target)} — addresses the rejection.`;
  const proposalReview = await reviewProposal({ file: target, reason: reasonText, find: edit.find, replace: edit.replace });
  const metadata = {
    decisionModel: editModel, editModel,
    generatorReason: `reproposal of ${fromId || 'rejected change'}`,
    proposedAt: new Date().toISOString(),
    reviewRecommendation: proposalReview.recommendation,
    reviewReason: proposalReview.reason,
    reviewers: proposalReview.reviewers,
    repropose_of: fromId || '',
    addresses_rejection: String(rejectionReason || '').slice(0, 400),
  };
  const pf = await pythonWorker.selfMod({ action: 'propose_fix', file: target, content: newContent, reason: reasonText, metadata });
  const res = (pf && (pf.result || pf)) || {};
  if (res.status === 'proposed') {
    logger.info('[selfImprove] queued a RE-proposal', { id: res.modification_id, file: path.basename(target), from: fromId });
    try {
      announceQueue.pushAnnouncement(await composeProposalAnnouncement({
        file: target, reason: reasonText, recommendation: proposalReview.recommendation,
        reviewReason: proposalReview.reason, id: res.modification_id,
      }));
    } catch { /* announce optional */ }
    return {
      ok: true, proposed: 1, id: res.modification_id, file: target, reason: reasonText, status: 'proposed',
      reviewRecommendation: proposalReview.recommendation, reviewReason: proposalReview.reason,
    };
  }
  return { ok: true, proposed: 0, status: res.status, note: res.message || "the revised proposal wasn't staged (the gate may have refused this file)." };
}

// --- Scheduling --------------------------------------------------------------
function start() {
  if (process.env.AVA_SELF_IMPROVE_OFF === '1') { logger.info('[selfImprove] disabled via env'); return; }
  if (_timer) return;
  // Frequent for now: scan often so proposals surface autonomously, not just at restart.
  const everyMs = Math.max(5, parseInt(process.env.AVA_SELF_IMPROVE_EVERY_MIN || '15', 10)) * 60 * 1000; // default 15 min
  setTimeout(() => { runScan({ reason: 'startup' }).catch(() => {}); }, 90000);
  _timer = setInterval(() => { runScan({ reason: 'scheduled' }).catch(() => {}); }, everyMs);
  logger.info('[selfImprove] scheduled', { everyMinutes: everyMs / 60000 });
}

export default { runScan, start, reviewProposal, reproposeForFile };
export { runScan, start, reviewProposal, reproposeForFile };
