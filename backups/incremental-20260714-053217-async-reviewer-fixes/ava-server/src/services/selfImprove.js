// selfImprove.js — AVA's autonomous self-improvement loop.
//
// Gathers improvement signals (tracked issues from Moltbook, recent failed commands from the
// conversation logs, and code diagnostics), asks the decision model to draft a SIGNIFICANT, safe
// improvement (which may be a larger, multi-part change), and stages it as a *proposed*
// self-modification. Nothing is ever applied here — every proposal lands in the same pending store
// the UI panel and voice approval read from, so the user reviews the diff and approves first.
//
// Safety: a change is expressed as ONE OR MORE exact find/replace edits, each of which must appear
// exactly once in the target file and is applied in order (never a blind full-file rewrite); the
// combined result is syntax-checked before proposing, and the approval gate (ava_self_modification's
// PROTECTED_BASENAMES) independently refuses proposals against the approval/safety code.

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import pythonWorker from './pythonWorker.js';
import announceQueue from './announceQueue.js';
import personaSvc from './persona.js';
import { verifyFileSyntax } from '../utils/verifyFileSyntax.js';
import proposalVerifier from './proposalVerifier.js';
import modelConfig from '../utils/modelConfig.js';
import { synthesizeLearnings, formatLearningSynthesis } from './learningSynthesis.js';
import { onVoiceEvent } from './voiceBus.js';
import externalProposalReview from './externalProposalReview.js';
import avaPaths from '../utils/paths.js';

export const SELF_MOD_PLAN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ava_selfmod_plan',
    strict: false,
    schema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            file_name: { type: 'string', minLength: 1 },
            issue: { type: 'string', minLength: 1 },
          },
          required: ['file_name', 'issue'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            skip: { type: 'boolean', const: true },
            why: { type: 'string', minLength: 1 },
          },
          required: ['skip', 'why'],
          additionalProperties: false,
        },
      ],
    },
  },
};

export const SELF_MOD_EDIT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ava_selfmod_edit',
    strict: false,
    schema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  find: { type: 'string', minLength: 1 },
                  replace: { type: 'string' },
                },
                required: ['find', 'replace'],
                additionalProperties: false,
              },
            },
            reason: { type: 'string', minLength: 1 },
          },
          required: ['edits', 'reason'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            skip: { type: 'boolean', const: true },
            why: { type: 'string', minLength: 1 },
          },
          required: ['skip', 'why'],
          additionalProperties: false,
        },
      ],
    },
  },
};

export const SELF_MOD_REVIEW_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ava_selfmod_review',
    strict: false,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'deny'] },
        reason: { type: 'string', minLength: 1 },
        risks: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string' },
        },
      },
      required: ['verdict', 'reason', 'risks'],
      additionalProperties: false,
    },
  },
};

export const SELF_MOD_REPROPOSE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ava_selfmod_reproposal',
    strict: false,
    schema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            find: { type: 'string', minLength: 1 },
            replace: { type: 'string' },
            reason: { type: 'string', minLength: 1 },
          },
          required: ['find', 'replace', 'reason'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            skip: { type: 'boolean', const: true },
            why: { type: 'string', minLength: 1 },
          },
          required: ['skip', 'why'],
          additionalProperties: false,
        },
      ],
    },
  },
};

// Syntax-check candidate full-file CONTENT before proposing it. Writes a throwaway file NEXT TO the
// target (so node --check / py_compile inherit the project's ESM / package context, which an
// os.tmpdir() copy would not) and removes it immediately. Best-effort: never blocks on checker error.
async function _syntaxCheckContent(targetPath, content) {
  try {
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath) || '.txt';
    const tmp = path.join(dir, `.ava_check_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
    fs.writeFileSync(tmp, content, 'utf8');
    let v;
    try { v = await verifyFileSyntax(tmp); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    return v || { ok: true };
  } catch { return { ok: true }; }
}

const DATA_DIR = avaPaths.dataDir();
const LOG_PATH = path.join(DATA_DIR, 'self-improve-log.jsonl');

let _timer = null;
let _running = false;
let _lastScanAt = 0;
let _learningListenerStarted = false;

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
      { temperature: 0.7, max_tokens: 220, localPriority: 'background' }
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
    const convDir = avaPaths.conversationLogsDir();
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
    const convDir = avaPaths.conversationLogsDir();
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
    const p = path.join(avaPaths.integrationDir(), 'memory', 'moltbook-learnings.json');
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = (j && (j.learnings || j)) || [];
    const normalized = (Array.isArray(arr) ? arr : []).map(l => ({
      topic: l.topic || l.title || '',
      source: l.source || l.submolt || '',
      insight: String(l.insight || l.summary || l.content || l.lesson || '').slice(0, 360),
    })).filter(l => l.topic || l.insight);
    const synthesis = synthesizeLearnings(normalized);
    return { ...synthesis, prompt: formatLearningSynthesis(synthesis) };
  } catch { return { totalInput: 0, prompt: '' }; }
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
  const server = avaPaths.serverDir();
  const repo = avaPaths.repoRoot();
  const roots = [
    path.join(server, 'src'),
    path.join(repo, 'ava-client', 'src'),
    avaPaths.cmpuseToolsDir(),
    avaPaths.integrationDir(),
    path.join(repo, 'scripts'),
  ];
  const out = [];
  const excluded = new Set(['node_modules', '.git', '.venv', 'dist', '__pycache__', 'deprecated-backup', 'vendor']);
  const maxBytes = Math.max(10000, Number(process.env.AVA_SELF_MOD_MAX_FILE_BYTES) || 500000);
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fp); continue; }
      if (!/\.(js|jsx|mjs|cjs|py|json)$/.test(entry.name) || /\.(test|spec)\.(js|jsx|py)$/.test(entry.name) || entry.name === '__init__.py') continue;
      try { const st = fs.statSync(fp); if (st.size >= 40 && st.size <= maxBytes) out.push(fp); } catch { /* ignore */ }
    }
  };
  for (const root of roots) {
    walk(root);
  }
  return [...new Set(out)];
}

const fileLabel = (c) => path.relative(avaPaths.repoRoot(), c).replace(/\\/g, '/');

// ---- Reviewer code context: give every reviewer AVA's full component map + the COMPLETE target file,
// so a proposal is judged against the real codebase/structure, not an isolated diff. ----
export function candidateRoleFromSource(source) {
  const text = String(source || '');
  const firstUsefulLine = value => String(value || '').split(/\r?\n/)
    .map(line => line.trim()).find(line => line.length > 3) || '';
  const moduleDoc = text.match(/^\s*(?:[rubf]{0,2})?("""|''')([\s\S]*?)\1/i);
  if (moduleDoc) return firstUsefulLine(moduleDoc[2]).slice(0, 160);

  const summary = text.slice(0, 50000).match(/\bsummary\s*[:=]\s*\(?\s*["']([^"'\r\n]{4,240})["']/i);
  if (summary && summary[1]) return summary[1].replace(/\s+/g, ' ').trim().slice(0, 160);
  return '';
}

function _fileHeader(fp) {
  try {
    const role = candidateRoleFromSource(fs.readFileSync(fp, 'utf8'));
    if (role) return role;
  } catch { /* use the lightweight header fallback below */ }
  try {
    const head = fs.readFileSync(fp, 'utf8').slice(0, 900);
    for (const raw of head.split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      const m = t.match(/^(?:\/\/+|#+|\/\*+|\*+)\s*(.+?)\s*\*?\/?$/);
      if (m && m[1] && m[1].length > 3) return m[1].slice(0, 160);
      if (!/^(\/\/|#|\/\*|\*)/.test(t)) break;   // first real code line — no header comment
    }
  } catch { /* ignore */ }
  return '';
}

function candidateRoleHints(cands) {
  const groups = new Map();
  for (const file of cands) {
    const role = _fileHeader(file);
    if (!role) continue;
    const label = fileLabel(file);
    const group = label.split('/')[0] || 'other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(`- ${label}: ${role}`);
  }

  const ordered = [];
  const queues = [...groups.values()];
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (queue.length) ordered.push(queue.shift());
    }
  }

  const cap = Math.max(4000, parseInt(process.env.AVA_SELFMOD_ROLE_HINT_CHARS || '16000', 10));
  let output = '';
  for (const line of ordered) {
    if (output.length + line.length + 1 > cap) continue;
    output += `${line}\n`;
  }
  return output.trim() || '(no role hints available)';
}

function _resolveTargetPath(file) {
  if (!file) return '';
  const f = String(file).replace(/\\/g, '/');
  try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; } catch { /* ignore */ }
  const cands = candidateFiles();
  const lab = f.toLowerCase();
  const base = path.basename(f).toLowerCase();
  let hit = cands.find(c => fileLabel(c).toLowerCase() === lab);
  if (!hit) hit = cands.find(c => lab.endsWith(fileLabel(c).toLowerCase()));
  if (!hit) hit = cands.find(c => path.basename(c).toLowerCase() === base);
  return hit || f;
}

// Full structure (every source file + its one-line purpose) + the COMPLETE current target file.
function buildCodebaseContext(targetFile) {
  let componentMap = '(component map unavailable)';
  try {
    const cands = candidateFiles();
    componentMap = cands.map(c => { const h = _fileHeader(c); return `- ${fileLabel(c)}${h ? ' — ' + h : ''}`; }).join('\n').slice(0, 18000);
  } catch { /* ignore */ }
  const resolved = _resolveTargetPath(targetFile);
  let fullFile = '';
  try { fullFile = fs.readFileSync(resolved, 'utf8'); } catch { /* ignore */ }
  const cap = parseInt(process.env.AVA_REVIEW_FILE_CAP || '200000', 10);
  let truncated = false;
  if (fullFile.length > cap) { fullFile = fullFile.slice(0, cap) + '\n\n... [remainder of file truncated for review] ...'; truncated = true; }
  return { componentMap, fullFile, resolved, truncated };
}

function avoidTerms(avoid) {
  return (Array.isArray(avoid) ? avoid : [])
    .map(x => String(x || '').toLowerCase().replace(/\\/g, '/').trim())
    .filter(Boolean);
}

const AVOID_TOKEN_NOISE = new Set([
  'a', 'an', 'and', 'any', 'change', 'changes', 'cjs', 'create', 'draft', 'edit', 'edits', 'for',
  'generate', 'generic', 'in', 'js', 'json', 'jsx', 'make', 'manual', 'mjs', 'now', 'of', 'on',
  'or', 'please', 'proposal', 'proposals', 'py', 'request', 'run', 'the', 'to', 'unsupported',
  'with', 'without',
]);
const AVOID_TOKEN_ALIASES = new Map([
  ['active', 'focus'], ['focused', 'focus'], ['foreground', 'focus'], ['focusing', 'focus'],
  ['windows', 'window'], ['sensing', 'detect'], ['sense', 'detect'], ['sensor', 'detect'],
  ['detection', 'detect'], ['detecting', 'detect'], ['integrated', 'integrate'],
  ['integration', 'integrate'], ['wiring', 'integrate'], ['wire', 'integrate'],
  ['capabilities', 'capability'], ['duplicates', 'duplicate'], ['duplicated', 'duplicate'],
  ['helpers', 'helper'], ['respond', 'response'], ['responding', 'response'],
  ['responses', 'response'], ['spoken', 'speech'], ['turns', 'turn'],
  ['websockets', 'websocket'],
]);

function proposalConceptTokens(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length > 1 && !AVOID_TOKEN_NOISE.has(token))
    .map(token => AVOID_TOKEN_ALIASES.get(token) || token));
}

export function focusRelevanceScore(label, role, focus) {
  const required = proposalConceptTokens((Array.isArray(focus) ? focus : [focus]).join(' '));
  if (!required.size) return 0;
  const candidate = proposalConceptTokens(`${label || ''} ${role || ''}`);
  let score = 0;
  for (const token of required) if (candidate.has(token)) score++;
  return score;
}

function focusedCandidateFiles(cands, focus) {
  const terms = (Array.isArray(focus) ? focus : [focus]).filter(Boolean);
  if (!terms.length) return cands;
  const configuredCap = parseInt(process.env.AVA_SELFMOD_FOCUSED_CANDIDATES || '80', 10);
  const cap = Math.max(20, Number.isFinite(configuredCap) ? configuredCap : 80);
  if (cands.length <= cap) return cands;
  const ranked = cands.map((file, index) => ({
    file,
    index,
    score: focusRelevanceScore(fileLabel(file), _fileHeader(file), terms),
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, cap).map(entry => entry.file);
}

export function resolveFocusedReferenceFiles(focus, targetFile, candidates, maxFiles = 4) {
  const terms = (Array.isArray(focus) ? focus : [focus])
    .map(value => String(value || '').replace(/\\/g, '/').toLowerCase().trim())
    .filter(value => /\.(?:cjs|js|json|jsx|mjs|py)(?:\b|$)/i.test(value));
  if (!terms.length) return [];
  const target = String(targetFile || '').replace(/\\/g, '/').toLowerCase();
  const limit = Math.max(1, Math.min(8, Number(maxFiles) || 4));
  const matches = [];

  for (const term of terms) {
    for (const file of Array.isArray(candidates) ? candidates : []) {
      const full = String(file || '').replace(/\\/g, '/').toLowerCase();
      if (!full || full === target) continue;
      const label = fileLabel(file).toLowerCase();
      const base = path.basename(full);
      const basePattern = new RegExp(`(?:^|[/\\s])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/\\s,;])`);
      const named = term === full || term === label || full.endsWith(`/${term}`)
        || term.endsWith(`/${label}`) || term.includes(label) || basePattern.test(term);
      if (named && !matches.some(existing => path.resolve(existing) === path.resolve(file))) matches.push(file);
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export function isSourceAbsenceSkip(plan) {
  if (!plan?.skip) return false;
  const why = String(plan.why || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!why) return false;
  return [
    /(?:does not|doesn't|did not|not) include.{0,140}(?:source|file content|implementation|call site)/,
    /\bwithout (?:the )?(?:actual )?(?:source|source code|file content|implementation|call sites?)/,
    /(?:source|source code|file contents?|implementation|call sites?).{0,100}(?:not (?:included|provided|available)|missing|absent)/,
  ].some(pattern => pattern.test(why));
}

export function isReferenceAbsenceSkip(edit, referenceContext) {
  if (!edit?.skip || !String(referenceContext || '').trim()) return false;
  const why = String(edit.why || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!why) return false;
  return isSourceAbsenceSkip({ skip: true, why }) || [
    /(?:other|related|referenced|named).{0,80}(?:services|files|owners).{0,120}(?:not (?:provided|supplied|included)|unavailable|absent)/,
    /\bwithout (?:their|the).{0,80}(?:definitions|implementations|call sites)/,
    /(?:definitions|implementations|call sites).{0,100}(?:not (?:provided|supplied|included)|unavailable|absent)/,
  ].some(pattern => pattern.test(why));
}

function isAvoidedCandidate(file, avoid) {
  const terms = avoidTerms(avoid);
  if (!terms.length) return false;
  const label = fileLabel(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  const full = String(file || '').toLowerCase().replace(/\\/g, '/');
  return terms.some(t => t.includes(base) || t.includes(label) || full.includes(t));
}

export function isAvoidedIdea(file, issue, avoid) {
  const terms = avoidTerms(avoid);
  if (!terms.length) return false;
  const candidateBase = path.basename(file || '').toLowerCase();
  const hay = `${fileLabel(file || '')} ${candidateBase} ${issue || ''}`.toLowerCase();
  const concepts = proposalConceptTokens(hay);
  return terms.some(t => {
    const fileOnly = t.match(/(?:^|\/)([^/]+\.(?:cjs|js|json|jsx|mjs|py))$/i);
    if (fileOnly) return candidateBase === fileOnly[1].toLowerCase();
    if (hay.includes(t) || t.includes(candidateBase)) return true;
    const avoided = proposalConceptTokens(t);
    if (!avoided.size) return false;
    let overlap = 0;
    for (const token of avoided) if (concepts.has(token)) overlap++;
    return overlap >= Math.min(2, avoided.size);
  });
}

export function isFocusedIdea(file, issue, focus) {
  const terms = avoidTerms(Array.isArray(focus) ? focus : [focus]);
  if (!terms.length) return true;
  const hay = `${fileLabel(file || '')} ${path.basename(file || '')} ${issue || ''}`.toLowerCase();
  const concepts = proposalConceptTokens(hay);
  let hasUsableFocus = false;
  for (const term of terms) {
    const required = proposalConceptTokens(term);
    if (!required.size) continue;
    hasUsableFocus = true;
    if (hay.includes(term)) return true;
    let overlap = 0;
    for (const token of required) if (concepts.has(token)) overlap++;
    const threshold = required.size <= 2 ? 1 : Math.min(3, Math.ceil(required.size * 0.25));
    if (overlap >= threshold) return true;
  }
  return !hasUsableFocus;
}

const EDITOR_EVIDENCE_SOURCES = Object.freeze([
  ['trigger_reason', 1],
  ['required_focus', 1],
  ['moltbook_learning_synthesis', 3],
  ['recent_research', 1.5],
  ['self_reflections', 1.5],
  ['diagnostics', 1],
  ['tracked_issues', 1],
  ['recent_failures', 1],
  ['conversation_guidance', 2],
  ['prior_mistake_lessons', 1],
  ['proposal_tests', 1],
]);

function hasEvidenceValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return !!value.trim();
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function evidenceText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value || ''); }
}

function clipEvidenceText(value, maxChars) {
  const text = evidenceText(value);
  if (text.length <= maxChars) return text;
  const marker = '\n...[source evidence compacted]...\n';
  const payload = Math.max(20, maxChars - marker.length);
  const head = Math.ceil(payload * 0.6);
  const tail = Math.max(0, payload - head);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`.slice(0, maxChars);
}

export function buildEditorEvidence(signals = {}, maxChars = 10000) {
  const cap = Math.max(2000, Number(maxChars) || 10000);
  const entries = EDITOR_EVIDENCE_SOURCES
    .map(([key, weight]) => ({ key, weight, value: signals?.[key] }))
    .filter(entry => hasEvidenceValue(entry.value));
  if (!entries.length) return '(no additional source evidence)';

  const separators = Math.max(0, entries.length - 1) * 2;
  const headers = entries.reduce((sum, entry) => sum + entry.key.length + 3, 0);
  const contentBudget = Math.max(entries.length * 40, cap - headers - separators);
  const minimum = Math.min(120, Math.floor(contentBudget / entries.length));
  const weightedBudget = Math.max(0, contentBudget - (minimum * entries.length));
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let allocated = 0;
  const sections = entries.map((entry, index) => {
    const remaining = contentBudget - allocated;
    const allowance = index === entries.length - 1
      ? remaining
      : minimum + Math.floor(weightedBudget * (entry.weight / totalWeight));
    allocated += allowance;
    return `[${entry.key}]\n${clipEvidenceText(entry.value, allowance)}`;
  });
  return sections.join('\n\n').slice(0, cap);
}

export function buildIssueAwareFileContext(content, issue, maxChars = 26000) {
  const text = String(content || '');
  const cap = Math.max(2000, Number(maxChars) || 26000);
  if (text.length <= cap) return text;

  const rawTokens = String(issue || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !AVOID_TOKEN_NOISE.has(token));
  const tokens = new Set([...rawTokens, ...proposalConceptTokens(issue)]);
  for (const token of [...tokens]) {
    if (token.endsWith('ment') && token.length > 6) tokens.add(token.slice(0, -4));
    if (token.endsWith('ing') && token.length > 5) tokens.add(token.slice(0, -3));
    if (token.endsWith('ed') && token.length > 4) tokens.add(token.slice(0, -2));
    if (token.endsWith('s') && token.length > 4) tokens.add(token.slice(0, -1));
  }

  const lower = text.toLowerCase();
  const markerReserve = 1000;
  const headSize = Math.min(5000, Math.floor(cap * 0.2));
  const tailSize = Math.min(3500, Math.floor(cap * 0.13));
  const windowCount = 3;
  const windowSize = Math.max(1800, Math.floor((cap - markerReserve - headSize - tailSize) / windowCount));
  const candidates = [];

  for (const token of tokens) {
    if (token.length < 3) continue;
    let from = 0;
    let found = 0;
    while (found < 60) {
      const index = lower.indexOf(token, from);
      if (index < 0) break;
      const start = Math.max(0, index - Math.floor(windowSize / 2));
      const end = Math.min(text.length, start + windowSize);
      const sample = lower.slice(start, end);
      let score = 0;
      for (const concept of tokens) {
        if (concept.length < 3) continue;
        const count = sample.split(concept).length - 1;
        if (count > 0) score += 4 + Math.min(3, count);
      }
      candidates.push({ start, end, score });
      from = index + token.length;
      found++;
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const intervals = [
    { start: 0, end: headSize },
    { start: Math.max(headSize, text.length - tailSize), end: text.length },
  ];
  const overlaps = candidate => intervals.some(existing => (
    Math.min(candidate.end, existing.end) > Math.max(candidate.start, existing.start)
  ));
  for (const candidate of candidates) {
    if (intervals.length >= windowCount + 2) break;
    if (!overlaps(candidate)) intervals.push(candidate);
  }

  for (let i = 1; intervals.length < windowCount + 2 && i <= windowCount; i++) {
    const center = Math.floor((text.length * i) / (windowCount + 1));
    const start = Math.max(headSize, Math.min(text.length - tailSize - windowSize, center - Math.floor(windowSize / 2)));
    const fallback = { start, end: Math.min(text.length - tailSize, start + windowSize) };
    if (fallback.end > fallback.start && !overlaps(fallback)) intervals.push(fallback);
  }

  intervals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }

  let output = '';
  let previousEnd = 0;
  for (const interval of merged) {
    if (interval.start > previousEnd) {
      output += `\n\n<<<${interval.start - previousEnd} CHARACTERS OMITTED FROM ORIGINAL FILE>>>\n\n`;
    }
    output += text.slice(interval.start, interval.end);
    previousEnd = interval.end;
  }
  if (previousEnd < text.length) {
    output += `\n\n<<<${text.length - previousEnd} CHARACTERS OMITTED FROM ORIGINAL FILE>>>\n`;
  }
  return output;
}

function focusedReferenceExcerpt(content, issue, maxChars) {
  const text = String(content || '');
  const cap = Math.max(1800, Number(maxChars) || 3000);
  if (text.length <= cap) return text;

  const tokenSet = new Set([
    ...String(issue || '').toLowerCase().split(/[^a-z0-9]+/),
    ...proposalConceptTokens(issue),
  ].filter(token => token.length > 2 && !AVOID_TOKEN_NOISE.has(token)));
  for (const token of [...tokenSet]) {
    if (token.endsWith('ment') && token.length > 6) tokenSet.add(token.slice(0, -4));
    if (token.endsWith('ing') && token.length > 5) tokenSet.add(token.slice(0, -3));
    if (token.endsWith('ed') && token.length > 4) tokenSet.add(token.slice(0, -2));
    if (token.endsWith('s') && token.length > 4) tokenSet.add(token.slice(0, -1));
  }
  const tokens = [...tokenSet].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const candidateIndexes = [];
  for (const token of tokens) {
    let cursor = 0;
    let found = 0;
    while (found < 40) {
      const index = lower.indexOf(token, cursor);
      if (index < 0) break;
      candidateIndexes.push(index);
      cursor = index + token.length;
      found++;
    }
  }

  const headSize = Math.min(600, Math.floor(cap * 0.12));
  const tailSize = Math.min(400, Math.floor(cap * 0.08));
  const windowCount = cap >= 5000 ? 4 : (cap >= 3400 ? 2 : 1);
  const markerBudget = (windowCount + 1) * 90;
  const windowSize = Math.max(700, Math.floor((cap - headSize - tailSize - markerBudget) / windowCount));
  const interiorStart = headSize;
  const interiorEnd = Math.max(interiorStart, text.length - tailSize);
  const interiorSize = interiorEnd - interiorStart;
  const scoreRegion = ({ start, end }) => {
    const sample = lower.slice(start, end);
    let score = 0;
    let distinct = 0;
    for (const token of tokens) {
      const first = sample.indexOf(token);
      if (first < 0) continue;
      distinct++;
      let count = 1;
      let cursor = first + token.length;
      while (count < 3) {
        const next = sample.indexOf(token, cursor);
        if (next < 0) break;
        count++;
        cursor = next + token.length;
      }
      score += Math.min(16, token.length) + count * 2;
    }
    return score + distinct * 5;
  };
  const selected = [];
  for (let partition = 0; partition < windowCount; partition++) {
    const partitionStart = interiorStart + Math.floor((interiorSize * partition) / windowCount);
    const partitionEnd = interiorStart + Math.floor((interiorSize * (partition + 1)) / windowCount);
    if (partitionEnd <= partitionStart) continue;
    const boundedWindowSize = Math.min(windowSize, partitionEnd - partitionStart);
    const latestStart = Math.max(partitionStart, partitionEnd - boundedWindowSize);
    const toInterval = index => {
      const start = Math.max(partitionStart, Math.min(latestStart, index - Math.floor(boundedWindowSize / 2)));
      return { start, end: start + boundedWindowSize };
    };
    const regions = new Map();
    const addRegion = index => {
      const interval = toInterval(index);
      const bucket = Math.round(interval.start / Math.max(80, Math.floor(boundedWindowSize / 8)));
      if (!regions.has(bucket)) regions.set(bucket, interval);
    };
    addRegion(partitionStart + Math.floor((partitionEnd - partitionStart) / 2));
    for (const index of candidateIndexes) {
      if (index >= partitionStart && index < partitionEnd) addRegion(index);
    }
    const best = [...regions.values()]
      .map(interval => ({ ...interval, score: scoreRegion(interval) }))
      .sort((a, b) => b.score - a.score || a.start - b.start)[0];
    if (best) selected.push({ start: best.start, end: best.end });
  }
  selected.sort((a, b) => a.start - b.start);

  const parts = [text.slice(0, headSize)];
  let cursor = headSize;
  for (const interval of selected) {
    const start = Math.max(cursor, interval.start);
    if (start > cursor) parts.push(`\n\n<<<${start - cursor} CHARACTERS OMITTED BEFORE RELEVANT REFERENCE CODE>>>\n\n`);
    if (interval.end > start) parts.push(text.slice(start, interval.end));
    cursor = Math.max(cursor, interval.end);
  }
  const tailStart = Math.max(cursor, text.length - tailSize);
  if (tailStart > cursor) parts.push(`\n\n<<<${tailStart - cursor} CHARACTERS OMITTED AFTER RELEVANT REFERENCE CODE>>>\n\n`);
  parts.push(text.slice(tailStart));
  return parts.join('').slice(0, cap);
}

export function buildFocusedReferenceContext(sources, issue, maxChars = 24000) {
  const cap = Math.max(2400, Number(maxChars) || 24000);
  const usable = (Array.isArray(sources) ? sources : [])
    .filter(source => source && source.file && String(source.content || '').trim())
    .slice(0, Math.max(1, Math.floor(cap / 2400)));
  if (!usable.length) return '';

  const sectionBudget = Math.floor((cap - ((usable.length - 1) * 2)) / usable.length);
  const sections = usable.map(source => {
    const header = `<<<FOCUSED REFERENCE FILE - INSPECTION ONLY: ${source.file}>>>\n`;
    const footer = '\n<<<END FOCUSED REFERENCE FILE>>>';
    const contentBudget = Math.max(2000, sectionBudget - header.length - footer.length);
    const excerpt = focusedReferenceExcerpt(source.content, issue, contentBudget);
    return `${header}${excerpt}${footer}`.slice(0, sectionBudget);
  });
  return sections.join('\n\n').slice(0, cap);
}

function lineEndingEquivalentSpan(content, find) {
  if (!find) return { occurrences: 0, start: -1, end: -1 };
  const normalizeWithOffsets = value => {
    const source = String(value || '');
    let normalized = '';
    const offsets = [0];
    for (let index = 0; index < source.length;) {
      if (source[index] === '\r' && source[index + 1] === '\n') {
        normalized += '\n';
        index += 2;
      } else {
        normalized += source[index];
        index++;
      }
      offsets.push(index);
    }
    return { normalized, offsets };
  };
  const haystack = normalizeWithOffsets(content);
  const needle = String(find).replace(/\r\n/g, '\n');
  const matches = [];
  let cursor = 0;
  while (cursor <= haystack.normalized.length - needle.length) {
    const found = haystack.normalized.indexOf(needle, cursor);
    if (found < 0) break;
    matches.push(found);
    cursor = found + Math.max(1, needle.length);
  }
  if (matches.length !== 1) return { occurrences: matches.length, start: -1, end: -1 };
  const start = matches[0];
  return {
    occurrences: 1,
    start: haystack.offsets[start],
    end: haystack.offsets[start + needle.length],
  };
}

export function applyExactEdits(content, edits) {
  let working = String(content || '');
  const list = Array.isArray(edits) ? edits : [];
  for (let index = 0; index < list.length; index++) {
    const edit = list[index] || {};
    const find = typeof edit.find === 'string' ? edit.find : '';
    const match = lineEndingEquivalentSpan(working, find);
    if (match.occurrences !== 1) {
      return { ok: false, content: working, index, occurrences: match.occurrences };
    }
    working = working.slice(0, match.start) + String(edit.replace ?? '') + working.slice(match.end);
  }
  return { ok: true, content: working, index: -1, occurrences: 1 };
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

export function proposalGenerationFailureLesson({ file = '', stage = 'validation', error = '' } = {}) {
  const detail = String(error || '').replace(/\s+/g, ' ').trim();
  if (!detail) return '';
  const target = path.basename(String(file || 'proposal')) || 'proposal';
  const failedStage = String(stage || 'validation').replace(/\s+/g, ' ').trim().slice(0, 80) || 'validation';
  return `Proposal generation for ${target} failed ${failedStage}: ${detail.slice(0, 400)}. Before retrying, inspect the current file for existing declarations and capabilities, then validate the complete combined result instead of adding a duplicate or partial implementation.`;
}

function rememberProposalGenerationFailure(details = {}) {
  const lesson = proposalGenerationFailureLesson(details);
  return lesson ? addLesson(lesson) : false;
}

export function rejectedProposalLesson({ file = '', proposalReason = '', reason = '', reviewer = 'reviewer' } = {}) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim();
  if (!why) return '';
  const target = path.basename(String(file || 'proposal')) || 'proposal';
  const intent = String(proposalReason || 'intent not recorded').replace(/\s+/g, ' ').trim().slice(0, 140);
  const who = String(reviewer || 'reviewer').replace(/\s+/g, ' ').trim().slice(0, 80) || 'reviewer';
  return `Reviewer ${who} DENIED a change to ${target} ("${intent}") because: ${why.slice(0, 500)}. Future proposals must address this evidence and not repeat the rejected change.`;
}

export function rememberRejectedProposal(details = {}) {
  const lesson = rejectedProposalLesson(details);
  return lesson ? addLesson(lesson) : false;
}

function priorMistakeLessons() {
  return readLessons().map(rule => ({ source: 'rejected_proposal_or_review', lesson: rule }));
}

// When the REVIEWER denies a proposal, capture its concern/recommendation as actionable feedback so
// the NEXT proposals incorporate it. It flows back via readLessons() -> the LESSONS block fed into
// both the planner and the editor prompts, and via priorMistakeLessons() in the signals.
function recordReviewerFeedback(file, changeReason, review) {
  try {
    if (!review) return;
    const rec = String(review.recommendation || '').toLowerCase();
    if (!/deny|reject|needs|concern|block|caution|revise/.test(rec)) return;  // only on a negative review
    const why = String(review.reason || '').trim();
    if (!why) return;
    const f = file ? path.basename(String(file)) : 'a file';
    addLesson(`Reviewer DENIED a change to ${f} ("${String(changeReason || '').slice(0, 100)}") because: ${why.slice(0, 280)}. When you propose changes to ${f} (or similar), incorporate this — fix the concern, don't repeat it.`);
  } catch { /* optional */ }
}

function proposalTestLessons() {
  try {
    const p = path.join(avaPaths.integrationDir(), 'memory', 'proposal_tests.json');
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

async function runProposalReviewer({ reviewer, model, call, file, reason, find, replace, diff, ctx }) {
  const system = [
    'You are a senior engineer reviewing one proposed change to AVA, a local always-on voice assistant, before it is shown to the user for approval.',
    "You are given AVA's FULL COMPONENT MAP (every source file and its role) and the COMPLETE CURRENT CONTENT of the file being changed. Use them to judge the change in the real context of the whole codebase, its components, and how they fit together — not as an isolated snippet.",
    'APPROVE the change when ALL of these hold:',
    '  (1) ACCURATE — the edit actually does what its stated reason claims, is consistent with how the surrounding code and the other components work, and only references things that really exist.',
    '  (2) NEEDED — it fixes a real problem OR is a genuine improvement, upgrade, or new capability. Changes do NOT have to be minimal; larger, additive, or substantial improvements are welcome as long as they are accurate and safe.',
    '  (3) SAFE — it will not break existing behavior, the approval/security gate, secret handling, or other components; it degrades gracefully and follows existing patterns.',
    'DENY only if the change is inaccurate (wrong, misunderstands the code, or claims something it does not do), not needed, or unsafe. Do NOT deny a change merely for being large, non-minimal, or an enhancement.',
    'Respond STRICT JSON only: {"verdict":"approve"|"deny","reason":"specific reason grounded in the actual code","risks":["risk", ...]}. Use an empty risks array when there are none.',
  ].join('\n');
  const change = diff
    ? `PROPOSED CHANGE (unified diff):\n${String(diff || '').slice(0, 8000)}`
    : `PROPOSED CHANGE — exact find/replace:\nFIND:\n${String(find || '').slice(0, 3500)}\n\nREPLACE:\n${String(replace || '').slice(0, 3500)}`;
  const user = [
    'AVA COMPONENT MAP (every source file and what it does):',
    (ctx && ctx.componentMap) || '(component map unavailable)',
    '',
    `FILE BEING CHANGED: ${file}`,
    `STATED REASON FOR THE CHANGE: ${reason}`,
    '',
    `COMPLETE CURRENT CONTENT OF ${path.basename(String(file || ''))} (judge the edit in THIS context):`,
    '=== CURRENT FILE START ===',
    (ctx && ctx.fullFile) || '(file content unavailable)',
    '=== CURRENT FILE END ===',
    '',
    change,
  ].join('\n');
  try {
    const r = await call({
      messages: [{ role: 'user', content: user }],
      system,
      maxTokens: 700,
      model,
      responseFormat: SELF_MOD_REVIEW_RESPONSE_FORMAT,
    });
    return normalizeReview(r.content || r.text || '', reviewer, r.model || model || reviewer);
  } catch (e) {
    return { reviewer, model: model || reviewer, recommendation: 'unavailable', reason: String(e.message || e).slice(0, 600), risks: [] };
  }
}

async function reviewProposal({ file, reason, find, replace, diff }) {
  const env = process.env;
  const reviews = [];

  // Tier 3 #21: deterministic API-claims verification runs FIRST — a grep beats an LLM at
  // catching invented APIs (her dominant rejection cause across dozens of proposals: fake
  // pythonWorker commands, methods no service exports, CommonJS-in-ESM, dead import paths).
  // A confident violation denies immediately with the exact claim named, which flows through
  // recordReviewerFeedback -> her lesson loop at both call sites, and burns zero LLM calls.
  try {
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* brand-new file */ }
    const proposed = [replace || '', diff || ''].filter(Boolean).join('\n');
    if (proposed.trim()) {
      const claims = proposalVerifier.verifyClaims({ targetFile: file, currentContent: current, newContent: proposed });
      if (!claims.ok) {
        const detail = proposalVerifier.describeViolations(claims);
        logger.info('[selfImprove] api-verifier denied a proposal pre-review', { file: path.basename(file), detail: detail.slice(0, 200) });
        return {
          recommendation: 'deny',
          reason: `api-verifier: ${detail}`.slice(0, 1000),
          reviewers: [{ reviewer: 'api-verifier', recommendation: 'deny', reason: detail.slice(0, 600) }],
        };
      }
    }
  } catch (e) { logger.warn('[selfImprove] api-verifier errored; falling through to LLM reviewers', { error: e.message }); }

  // Build AVA's full code context ONCE (component map of every source file + the COMPLETE target
  // file) and give the same context to every reviewer, so they judge against the real codebase.
  const ctx = buildCodebaseContext(file);

  reviews.push(await runProposalReviewer({
    reviewer: 'openai-api-reviewer',
    model: env.AVA_REVIEW_OPENAI || modelConfig.modelFor('openai'),
    call: (opts) => llmService.createCompletionOpenAI(opts),
    file,
    reason,
    find,
    replace,
    diff,
    ctx,
  }));

  reviews.push(await runProposalReviewer({
    reviewer: 'anthropic-api-reviewer',
    model: env.AVA_REVIEW_CLAUDE || modelConfig.modelFor('claude'),
    call: (opts) => llmService.createCompletionClaude(opts),
    file,
    reason,
    find,
    replace,
    diff,
    ctx,
  }));

  let available = reviews.filter(r => r.recommendation !== 'unavailable');
  // BOTH primary reviewers unavailable (e.g. OpenAI 429 + Claude out of credits)? The reviewers
  // call those providers DIRECTLY, so they don't fall through the resilient chain on their own —
  // which left proposals unreviewed (defaulting to 'review'). Add a fallback reviewer that uses
  // chatSelfMod, which routes through Gemini/DeepSeek/Grok, so a real verdict is still produced.
  if (!available.length) {
    reviews.push(await runProposalReviewer({
      reviewer: 'fallback-chain',
      model: env.AVA_SELFMOD_MODEL || undefined,
      call: (opts) => llmService.chatSelfMod(
        [{ role: 'system', content: opts.system }, ...opts.messages],
        {
          temperature: 0.2,
          max_tokens: opts.maxTokens || 700,
          model: opts.model,
          responseFormat: opts.responseFormat || SELF_MOD_REVIEW_RESPONSE_FORMAT,
          localPriority: 'background',
        }
      ),
      file, reason, find, replace, diff, ctx,
    }));
    available = reviews.filter(r => r.recommendation !== 'unavailable');
  }
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
async function runScan({ reason = 'scheduled', max = 1, avoid = [], focus = [], diag: triggerDiag = null } = {}) {
  if (_running) return { ok: false, error: 'a scan is already running' };
  if (!pythonWorker.isReady || !pythonWorker.isReady()) return { ok: false, error: 'python worker not ready' };
  _running = true;
  _lastScanAt = Date.now();
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
    const explicitAvoid = Array.isArray(avoid) ? avoid.filter(Boolean) : [];
    const requiredFocus = (Array.isArray(focus) ? focus : [focus])
      .map(value => String(value || '').trim().slice(0, 500))
      .filter(Boolean)
      .slice(-12);
    const combinedAvoid = [...autoAvoid, ...explicitAvoid];
    const issues = openIssues();
    const failures = recentFailures();
    const guidance = conversationGuidance();
    const learnings = moltbookLearnings();
    const mistakes = priorMistakeLessons();
    const proposalTests = proposalTestLessons();
    const triggerIssues = triggerDiag && Array.isArray(triggerDiag.issues) ? triggerDiag.issues : [];
    const liveIssues = liveDiag && Array.isArray(liveDiag.issues) ? liveDiag.issues : [];
    const diagIssues = [...triggerIssues, ...liveIssues];
    if (!issues.length && !failures.length && !diagIssues.length && !learnings.totalInput && !guidance.length && !mistakes.length && !proposalTests.length) {
      logEntry({ reason, proposed: 0, note: 'no actionable signals' });
      return { ok: true, proposed: 0, note: 'Nothing to improve — no recent failures, issues, learnings, or diagnostics.' };
    }

    // Recent web research she's done (web_search/web_scrape -> research-notes.jsonl) so proposals
    // can be GROUNDED in what she's actually learned, not only internal signals.
    let recentResearch = [];
    try {
      const _memDir = path.join(avaPaths.integrationDir(), 'memory');
      const _rp = path.join(_memDir, 'research-notes.jsonl');
      if (fs.existsSync(_rp)) {
        recentResearch = fs.readFileSync(_rp, 'utf8').trim().split('\n').filter(Boolean).slice(-12)
          .map(l => { try { const e = JSON.parse(l); return { topic: e.topic, summary: String(e.summary || '').slice(0, 280), url: e.url }; } catch { return null; } })
          .filter(Boolean);
      }
    } catch { /* ignore */ }

    // Her own first-person reflections about her design/limits/wants (selfReflections) so the
    // proposer can act on what SHE said she'd change — not only failures/diagnostics.
    let recentReflections = [];
    try {
      const sr = await import('./selfReflections.js');
      const fn = sr.default?.actionable || sr.actionable;
      recentReflections = (fn ? fn(10) : []).map(r => String(r.text || '').slice(0, 280)).filter(Boolean);
    } catch { /* ignore */ }

    const signals = {
      trigger_reason: String(reason || '').slice(0, 1200),
      moltbook_learning_synthesis: learnings,
      recent_research: recentResearch,
      self_reflections: recentReflections,
      diagnostics: diagIssues.slice(0, 8),
      proposal_tests: proposalTests,
      prior_mistake_lessons: mistakes,
      tracked_issues: issues.map(i => ({ category: i.category, description: i.description, context: i.context })),
      recent_failures: failures,
      conversation_guidance: guidance,
      already_pending: already.map(m => ({ file: m.file, reason: m.reason })),
      per_run_exclusions: explicitAvoid.slice(-40),
      required_focus: requiredFocus,
      recently_covered: autoAvoid.slice(-40),
      already_covered: combinedAvoid.slice(-80),
    };

    // STEP 1 — pick ONE target file + describe the concrete change (the model has NOT seen file
    // contents yet, so it only chooses a file and states the fix; it must not invent snippets).
    const allCands = candidateFiles();
    const cands = allCands.filter(file => !isAvoidedCandidate(file, explicitAvoid));
    if (!cands.length) {
      logEntry({ reason, proposed: 0, note: 'all candidates excluded for this scan' });
      return { ok: true, proposed: 0, note: 'Every eligible target was excluded for this scan.' };
    }
    const planningCands = focusedCandidateFiles(cands, requiredFocus);
    const inspectionHandoffOwners = resolveFocusedReferenceFiles(requiredFocus, '', cands, 1);
    const listing = planningCands.map(fileLabel).join('\n');
    const roleHints = candidateRoleHints(planningCands);
    const lessons = readLessons();
    const lessonsBlock = lessons.length
      ? '\n\nREVIEWER FEEDBACK & LESSONS — past proposals were denied/rejected for these reasons. AVOID repeating the mistakes AND incorporate the suggested fixes when you propose:\n' + lessons.map(l => '- ' + l).join('\n')
      : '';
    const proposalTestsBlock = proposalTests.length
      ? '\n\nPROPOSAL TEST LESSONS - retained accuracy requirements, not optional suggestions:\n'
        + proposalTests.map(t => `- ${t.id || 'test'}: ${t.lesson}${t.reject_if ? ` Reject if: ${t.reject_if}` : ''}`).join('\n')
      : '';
    const planSys = [
      "You are AVA's self-improvement engine, improving a local voice assistant (Node server +",
      'Python cmp-use tools + integration). From the signals, choose the single most impactful,',
      'clearly-evidenced problem and the ONE source file to change.',
      'This is a two-stage inspection handoff: at this planning stage you are choosing the strongest',
      'existing owner for the editor to inspect next; you are not expected to have its source text yet.',
      'When an observed focused issue or diagnosis is concrete and CANDIDATE_ROLE_HINTS identify a',
      'plausible owner, choose the best owner and state what the editor must verify. Do not skip solely',
      'because file contents are absent here. The editor receives the real file and may then skip with',
      'code evidence if the behavior is already correct, the owner is wrong, or no safe change exists.',
      'If trigger_reason contains a recent user-requested diagnosis or a just-completed diagnosis,',
      'treat that as the highest-priority signal and propose a repair for that diagnosis when a',
      'concrete safe code/config change is possible.',
      "PREFER SUBSTANTIAL UPGRADES: favor changes that MEANINGFULLY improve AVA's functionality or add a real capability over cosmetic tweaks, renames, or comment-only edits. A larger, multi-part change to ONE file is welcome — but it must be genuinely needed, evidenced by the signals, and safe.",
      'Output STRICT JSON only (no prose, no code fences):',
      '{"file_name":"<exact entry copied from CANDIDATE_FILES, e.g. tools/open_item.py>","issue":"<the SIGNIFICANT functionality upgrade to make and why it matters — may be a larger, multi-part change to that file>"}',
      'or {"skip":true,"why":"..."} if nothing is concrete and evidenced.',
      'Copy file_name EXACTLY as listed (dir/name). Do NOT output a full path or invent a name.',
      'Use CANDIDATE_ROLE_HINTS to choose a file that already owns the relevant behavior. Do not',
      'choose an unrelated file merely because new code could be placed there.',
      'PER_RUN_EXCLUSIONS are hard only for THIS scan: do not repeat the same topic under a synonym',
      'or move it to another file. RECENTLY_COVERED is guidance, not a permanent ban; revisit it only',
      'when fresh evidence proves a distinct current need.',
      'REQUIRED_FOCUS is also hard for THIS scan. When it is non-empty, the chosen file and issue must',
      'directly address that focus. Skip rather than substituting an unrelated improvement.',
      'Files that implement approval, security, or autonomy policy may be chosen only when direct evidence points there; require especially strong verification and never weaken a safety gate.',
      'VARIETY MATTERS, but evidence wins: avoid repeating anything already pending or already covered',
      'unless a new failure or diagnosis specifically proves that same file still needs a distinct fix.',
      'Draw evidence from the FULL range of signals: recent failures, tracked issues, conversation',
      'corrections, diagnostics, research, Moltbook synthesis, and prior outcomes. Do not favor any',
      'fixed product area or capability category. For focused scans, use background signals only to',
      'validate or reject the required focus; never let them replace it. For unfocused scans, rotate',
      'source and file based on freshness, evidence strength, impact, and recent coverage.',
    ].join('\n') + lessonsBlock + proposalTestsBlock;
    const focusBanner = requiredFocus.length
      ? `REQUIRED_FOCUS (hard scope for this scan):\n${requiredFocus.map(value => `- ${value}`).join('\n')}\nChoose only a directly matching issue, or skip.`
      : 'REQUIRED_FOCUS: none. Choose from current evidence without a fixed capability preference.';
    const planUser = `${focusBanner}\n\nSIGNALS:\n${JSON.stringify(signals).slice(0, 24000)}\n\nCANDIDATE_FILES (choose one, copy its name exactly):\n${listing}\n\nCANDIDATE_ROLE_HINTS (descriptions only; file_name still comes from CANDIDATE_FILES):\n${roleHints}\n\n${focusBanner}`;
    let plan = null;
    let planModel = '';
    let planRaw = '';
    try {
      const r = await llmService.chatSelfMod(
        [{ role: 'system', content: planSys }, { role: 'user', content: planUser }],
        {
          temperature: 0.2,
          max_tokens: 3000,
          model: process.env.AVA_SELFMOD_MODEL || undefined,
          responseFormat: SELF_MOD_PLAN_RESPONSE_FORMAT,
          localPriority: 'background',
        }
      );
      planModel = r.provider || r.model || '';
      planRaw = String(r.text || r.content || '');
      plan = parseJsonLoose(planRaw);
      if (!plan) logEntry({ reason, proposed: 0, note: 'plan parse failed', planModel, raw: planRaw.slice(0, 400) });
    } catch (e) {
      logEntry({ reason, proposed: 0, note: 'plan chat error', error: e.message });
      return { ok: true, proposed: 0, note: 'Could not draft a clean proposal this pass.' };
    }
    if (isSourceAbsenceSkip(plan) && inspectionHandoffOwners.length) {
      const originalWhy = String(plan.why || '').slice(0, 800);
      const owner = inspectionHandoffOwners[0];
      plan = {
        file_name: fileLabel(owner),
        issue: `Inspect the named focused owners and make the smallest correction only if their current source proves a real gap. Required focus: ${String(reason || requiredFocus.join(' ')).slice(0, 1200)}`,
      };
      logEntry({
        reason, proposed: 0, note: 'planner source-absence skip overridden for focused inspection handoff',
        file: plan.file_name, originalWhy, planModel,
      });
    }
    if (!plan || plan.skip || !plan.file_name || !plan.issue) {
      if (plan && !plan.skip && (!plan.file_name || !plan.issue)) {
        logEntry({ reason, proposed: 0, note: 'plan shape invalid', planModel, raw: planRaw.slice(0, 400) });
      }
      logEntry({ reason, proposed: 0, skip: true, why: plan && plan.why });
      return { ok: true, proposed: 0, note: (plan && plan.why) || 'Nothing concrete enough to propose safely.' };
    }
    // Match the chosen name back to a real candidate (by dir/name, then by basename).
    const want = String(plan.file_name).replace(/\\/g, '/');
    const basenameMatches = cands.filter(c => path.basename(c) === path.basename(want));
    plan.file = cands.find(c => fileLabel(c) === want)
      || cands.find(c => fileLabel(c).endsWith('/' + want))
      || (basenameMatches.length === 1 ? basenameMatches[0] : null);
    if (!plan.file || !fs.existsSync(plan.file)) {
      logEntry({ reason, proposed: 0, note: 'no candidate matched', file_name: plan.file_name });
      return { ok: true, proposed: 0, note: 'Model picked a file that is not in the candidate list.' };
    }
    if (!isFocusedIdea(plan.file, plan.issue, requiredFocus)) {
      logEntry({ reason, proposed: 0, note: 'required focus mismatch', file: plan.file, why: plan.issue, requiredFocus });
      return { ok: true, proposed: 0, note: 'Held back because the idea did not address the required focus for this scan.' };
    }
    if (isAvoidedIdea(plan.file, plan.issue, explicitAvoid)) {
      logEntry({ reason, proposed: 0, note: 'explicit per-run exclusion matched', file: plan.file, why: plan.issue });
      return { ok: true, proposed: 0, note: 'Held back because the idea matches a topic explicitly excluded for this scan.' };
    }
    const duplicatePending = already.some(p => path.resolve(String(p.file || '')) === path.resolve(plan.file)
      && String(p.reason || '').toLowerCase() === String(plan.issue || '').toLowerCase());
    if (duplicatePending) return { ok: true, proposed: 0, note: 'An identical proposal is already pending.' };

    // Read the actual file (server-side fs is the reliable path; the worker has no read_file action).
    let content = null;
    try { content = fs.readFileSync(plan.file, 'utf8'); } catch (e) { logEntry({ reason, note: 'fs read error', file: plan.file, error: e.message }); }
    if (content == null || content.trim().length < 20) {
      logEntry({ reason, proposed: 0, note: 'empty/unreadable target', file: plan.file, len: content == null ? -1 : content.length });
      return { ok: true, proposed: 0, note: `Couldn't read a usable ${path.basename(plan.file)}.` };
    }

    // A proposal still edits only ONE owner, but focused diagnoses may name several related owners.
    // Give the editor bounded, read-only excerpts from those explicitly named files so a skip or
    // dependency claim can be verified instead of guessed from component names or role summaries.
    const maxFocusedReferences = Math.max(1, parseInt(process.env.AVA_SELFMOD_REFERENCE_FILES || '4', 10) || 4);
    const focusedReferenceFiles = resolveFocusedReferenceFiles(requiredFocus, plan.file, allCands, maxFocusedReferences);
    const focusedReferenceSources = focusedReferenceFiles.map(file => {
      try { return { file, content: fs.readFileSync(file, 'utf8') }; } catch { return null; }
    }).filter(Boolean);

    // STEP 2 — given the real file, produce ONE OR MORE exact find/replace edits. A larger,
    // multi-part upgrade is allowed (and encouraged when it meaningfully improves functionality),
    // but NEVER a blind full-file rewrite: every edit is a unique, verbatim find/replace applied to
    // the real file in order, and the combined result is syntax-checked before being proposed.
    const editSys = [
      'You are implementing a SIGNIFICANT improvement to AVA by editing the file below.',
      'Output STRICT JSON only: {"edits":[{"find":"<substring copied VERBATIM from the file, appearing exactly once>","replace":"<the new text>"}, ...],"reason":"<one line: the upgrade and why it matters>"}',
      'or {"skip":true,"why":"..."}.',
      'You MAY return MULTIPLE edits to make a larger, multi-part change — e.g. add a new function AND',
      'wire it into the existing flow AND export it. Use as many edits as the upgrade genuinely needs',
      '(1 to 8). Edits apply IN ORDER, so each "find" must still be unique when its turn comes.',
      'Each "find" must be copied EXACTLY from the file (same whitespace) and appear EXACTLY ONCE. Do',
      'not reformat unrelated code.',
      'For large files, FILE CONTENT contains issue-relevant excerpts plus omission markers inserted',
      'by the server. Those <<<...OMITTED...>>> markers are NOT in the file and must never appear in find or replace.',
      "ONLY propose changes that MEANINGFULLY improve AVA's functionality or add a real capability —",
      'NOT cosmetic tweaks, renames, reformatting, or comment-only edits. If you cannot make a',
      'substantial, correct, safe improvement to THIS file, SKIP.',
      'COMPLETE & FUNCTIONAL (critical): every edit must be finished, working code. If you add a',
      'function, field, command, parameter, or branch, also include the code that IMPLEMENTS and USES',
      'it (in the same or another edit of this set). NEVER produce a docstring/comment for',
      'unimplemented behavior, a declared variable/field nothing reads, a function never called, a',
      'TODO/placeholder/stub, or a partial change needing a follow-up. The WHOLE set together must run',
      'and do exactly what your "reason" claims, with no further edits required. If you cannot meet',
      'this bar, SKIP.',
      'SOURCE-BALANCED EVIDENCE contains the current Moltbook synthesis, research, reflections,',
      'diagnostics/failures, conversation guidance, and retained proposal outcomes. Ground the edit',
      'in that evidence, but let the actual target file decide what already exists. Do not claim a',
      'source is wired merely because its component name appears; verify declarations and call sites.',
      'FOCUSED REFERENCE FILES are read-only evidence from other owners explicitly named in this',
      'scan. They may prove or disprove a cross-file dependency, but this proposal may edit only FILE.',
      'Every cross-file assertion in an edit reason or skip explanation must be supported by code in',
      'FILE or those references. If the supplied code does not prove it, say it was not verified;',
      'never infer dependency direction or complete wiring from a filename, import name, or role hint.',
    ].join('\n') + lessonsBlock + proposalTestsBlock;
    const editContextCap = parseInt(process.env.AVA_SELFMOD_FILE_CAP || '26000', 10);
    const editFileContext = buildIssueAwareFileContext(content, plan.issue, editContextCap);
    const editorEvidenceCap = parseInt(process.env.AVA_SELFMOD_EDITOR_EVIDENCE_CHARS || '10000', 10);
    const editorEvidence = buildEditorEvidence(signals, editorEvidenceCap);
    const focusedReferenceCap = parseInt(process.env.AVA_SELFMOD_REFERENCE_CONTEXT_CHARS || '24000', 10);
    const focusedReferenceContext = buildFocusedReferenceContext(
      focusedReferenceSources,
      `${plan.issue}\n${requiredFocus.join('\n')}`,
      focusedReferenceCap,
    );
    const referenceBlock = focusedReferenceContext
      ? `\n\nFOCUSED REFERENCE FILES (inspection only; do not edit):\n${focusedReferenceContext}`
      : '';
    const editUser = `UPGRADE TO MAKE: ${plan.issue}\n\nSOURCE-BALANCED EVIDENCE:\n${editorEvidence}${referenceBlock}\n\nFILE: ${plan.file}\n\n<<<FILE CONTENT>>>\n${editFileContext}\n<<<END>>>`;
    let edit = null;
    let editModel = '';
    let editRaw = '';
    try {
      const r = await llmService.chatSelfMod(
        [{ role: 'system', content: editSys }, { role: 'user', content: editUser }],
        {
          temperature: 0.1,
          max_tokens: 4000,
          model: process.env.AVA_SELFMOD_MODEL || undefined,
          responseFormat: SELF_MOD_EDIT_RESPONSE_FORMAT,
          localPriority: 'background',
        }
      );
      editModel = r.provider || r.model || '';
      editRaw = String(r.text || r.content || '');
      edit = parseJsonLoose(editRaw);
      if (!edit) logEntry({ reason, proposed: 0, note: 'edit parse failed', file: plan.file, planModel, editModel, raw: editRaw.slice(0, 400) });
    } catch (e) {
      logEntry({ reason, proposed: 0, note: 'edit chat error', file: plan.file, planModel, error: e.message });
      return { ok: true, proposed: 0, note: 'Identified an upgrade but could not draft a clean edit.' };
    }
    if (isReferenceAbsenceSkip(edit, focusedReferenceContext)) {
      const contradictedWhy = String(edit.why || '').slice(0, 1000);
      logEntry({
        reason, proposed: 0, note: 'editor claimed supplied focused references were absent; compact re-review requested',
        file: plan.file, planModel, editModel, contradictedWhy,
        referenceFiles: focusedReferenceFiles.map(fileLabel),
      });
      const configuredRepairCap = parseInt(process.env.AVA_SELFMOD_REVIEW_REPAIR_FILE_CAP || '45000', 10);
      const repairFileCap = Math.max(8000, configuredRepairCap || 45000);
      const repairFileContext = buildIssueAwareFileContext(content, plan.issue, repairFileCap);
      const repairSys = `${editSys}\n\nCORRECTION PASS: your prior skip said related source was absent, but the named focused reference code is supplied below. Re-read it. Return a source-backed edit or a source-backed skip; do not repeat a missing-reference claim.`;
      const repairUser = `UPGRADE TO MAKE: ${plan.issue}\n\nPRIOR INVALID SKIP: ${contradictedWhy}\n\nFOCUSED REFERENCE FILES ARE PRESENT (inspection only; do not edit):\n${focusedReferenceContext}\n\nTARGET FILE: ${plan.file}\n\n<<<TARGET FILE CONTENT>>>\n${repairFileContext}\n<<<END TARGET FILE>>>\n\nSOURCE-BALANCED EVIDENCE:\n${editorEvidence}`;
      try {
        const retry = await llmService.chatSelfMod(
          [{ role: 'system', content: repairSys }, { role: 'user', content: repairUser }],
          {
            temperature: 0.05,
            max_tokens: 4000,
            model: process.env.AVA_SELFMOD_MODEL || undefined,
            responseFormat: SELF_MOD_EDIT_RESPONSE_FORMAT,
            localPriority: 'background',
          }
        );
        const retryRaw = String(retry.text || retry.content || '');
        const retryEdit = parseJsonLoose(retryRaw);
        if (!retryEdit) {
          logEntry({ reason, proposed: 0, note: 'focused reference re-review parse failed', file: plan.file, raw: retryRaw.slice(0, 400) });
          return { ok: true, proposed: 0, note: 'The editor contradicted supplied reference evidence, and the corrective review was not parseable. No proposal or no-change verdict was accepted.' };
        }
        edit = retryEdit;
        editRaw = retryRaw;
        editModel = retry.provider || retry.model || editModel;
      } catch (error) {
        logEntry({ reason, proposed: 0, note: 'focused reference re-review failed', file: plan.file, error: error.message });
        return { ok: true, proposed: 0, note: 'The editor contradicted supplied reference evidence, and the corrective review failed. No proposal or no-change verdict was accepted.' };
      }
      if (isReferenceAbsenceSkip(edit, focusedReferenceContext)) {
        logEntry({ reason, proposed: 0, note: 'focused reference contradiction repeated', file: plan.file, why: String(edit.why || '').slice(0, 1000) });
        return { ok: true, proposed: 0, note: 'The editor twice claimed that supplied focused references were absent. That scrutiny pass was rejected; no proposal or no-change verdict was accepted.' };
      }
    }
    // Accept the multi-edit {edits:[...]} shape OR a single {find,replace} (back-compat).
    let edits = Array.isArray(edit && edit.edits) ? edit.edits
      : (edit && edit.find != null ? [{ find: edit.find, replace: edit.replace }] : []);
    edits = (edits || []).filter(e => e && typeof e.find === 'string' && e.find.length && e.replace != null);
    if (!edit || edit.skip || !edits.length) {
      if (edit && !edit.skip && !edits.length) {
        logEntry({ reason, proposed: 0, note: 'edit shape invalid', file: plan.file, planModel, editModel, raw: editRaw.slice(0, 400) });
      }
      logEntry({ reason, proposed: 0, skip: true, file: plan.file, why: edit && edit.why });
      return { ok: true, proposed: 0, note: (edit && edit.why) || 'No safe exact edit found.' };
    }
    if (edits.length > 8) edits = edits.slice(0, 8);
    const initialApplication = applyExactEdits(content, edits);
    if (!initialApplication.ok) {
      const failed = edits[initialApplication.index] || {};
      const failureAudit = {
        issue: String(plan.issue || '').slice(0, 600),
        editReason: String(edit.reason || '').slice(0, 600),
        planModel,
        editModel,
        failedEdit: initialApplication.index + 1,
        editsCount: edits.length,
        occurrences: initialApplication.occurrences,
        findPreview: String(failed.find || '').replace(/\s+/g, ' ').slice(0, 180),
      };
      logEntry({ reason, proposed: 0, note: 'edit validation repair requested', file: plan.file, ...failureAudit });

      const repairSys = [
        'Repair a proposed exact find/replace edit set that failed deterministic validation.',
        'Return STRICT JSON only in the same shape:',
        '{"edits":[{"find":"<verbatim unique substring>","replace":"<new text>"},...],"reason":"<one line>"}',
        'or {"skip":true,"why":"..."} when no complete safe repair is possible.',
        'Return the COMPLETE edit set in execution order. Keep valid edits when needed, but rewrite',
        'or remove the failed edit so every find appears exactly once at its sequential step.',
        'Use enough unchanged surrounding code to make each find unique. Do not guess which repeated',
        'occurrence was intended. Preserve the original upgrade intent and do not broaden its scope.',
        'Omission markers in FILE CONTENT are server context only and must never appear in find or replace.',
      ].join('\n') + lessonsBlock + proposalTestsBlock;
      const repairUser = `UPGRADE TO MAKE: ${plan.issue}\n\nVALIDATION FAILURE: edit ${initialApplication.index + 1} of ${edits.length} matched ${initialApplication.occurrences} times. Every find must match exactly once when edits are applied in order.\n\nPREVIOUS EDIT SET:\n${JSON.stringify({ edits, reason: edit.reason || plan.issue }, null, 2)}\n\nFILE: ${plan.file}\n\n<<<FILE CONTENT>>>\n${editFileContext}\n<<<END>>>`;

      let repaired = null;
      let repairRaw = '';
      try {
        const r = await llmService.chatSelfMod(
          [{ role: 'system', content: repairSys }, { role: 'user', content: repairUser }],
          {
            temperature: 0.05,
            max_tokens: 4000,
            model: process.env.AVA_SELFMOD_MODEL || undefined,
            responseFormat: SELF_MOD_EDIT_RESPONSE_FORMAT,
            localPriority: 'background',
          }
        );
        const repairModel = r.provider || r.model || '';
        editModel = [editModel, repairModel].filter(Boolean).join(' -> ');
        repairRaw = String(r.text || r.content || '');
        repaired = parseJsonLoose(repairRaw);
      } catch (e) {
        logEntry({ reason, proposed: 0, note: 'edit validation repair chat error', file: plan.file, ...failureAudit, error: e.message });
        return { ok: true, proposed: 0, note: 'The draft failed exact-match validation and its one repair attempt could not complete.' };
      }

      const repairedEdits = Array.isArray(repaired && repaired.edits) ? repaired.edits
        : (repaired && repaired.find != null ? [{ find: repaired.find, replace: repaired.replace }] : []);
      edits = repairedEdits
        .filter(e => e && typeof e.find === 'string' && e.find.length && e.replace != null)
        .slice(0, 8);
      if (!repaired || repaired.skip || !edits.length) {
        logEntry({
          reason,
          proposed: 0,
          skip: true,
          note: 'edit validation repair declined',
          file: plan.file,
          ...failureAudit,
          editModel,
          why: String(repaired?.why || '').slice(0, 600),
          raw: repaired ? undefined : repairRaw.slice(0, 400),
        });
        return { ok: true, proposed: 0, note: repaired?.why || 'The draft could not be repaired into a safe exact edit set.' };
      }
      edit = repaired;
      const repairedApplication = applyExactEdits(content, edits);
      if (!repairedApplication.ok) {
        const repairedFailed = edits[repairedApplication.index] || {};
        logEntry({
          reason,
          proposed: 0,
          note: `edit repair ${repairedApplication.index + 1}/${edits.length} snippet appears ${repairedApplication.occurrences}x`,
          file: plan.file,
          issue: String(plan.issue || '').slice(0, 600),
          editReason: String(edit.reason || '').slice(0, 600),
          planModel,
          editModel,
          failedEdit: repairedApplication.index + 1,
          editsCount: edits.length,
          occurrences: repairedApplication.occurrences,
          findPreview: String(repairedFailed.find || '').replace(/\s+/g, ' ').slice(0, 180),
        });
        return { ok: true, proposed: 0, note: `The repaired edit set still had an ambiguous target (${repairedApplication.occurrences} matches), so I held it back.` };
      }
      logEntry({
        reason,
        proposed: 0,
        note: 'edit validation repair succeeded',
        file: plan.file,
        issue: String(plan.issue || '').slice(0, 600),
        editReason: String(edit.reason || '').slice(0, 600),
        planModel,
        editModel,
        editsCount: edits.length,
      });
    }
    // Re-run the same validator defensively and use its mapped content. Keeping one validator avoids
    // accepting LF/CRLF equivalence above and then rejecting it with raw string matching here.
    const finalApplication = applyExactEdits(content, edits);
    if (!finalApplication.ok) {
      logEntry({
        reason,
        proposed: 0,
        note: `final edit ${finalApplication.index + 1}/${edits.length} snippet appears ${finalApplication.occurrences}x`,
        file: plan.file,
        issue: String(plan.issue || '').slice(0, 600),
        planModel,
        editModel,
      });
      return { ok: true, proposed: 0, note: 'The final edit set did not have one unique logical match per edit, so I held it back.' };
    }
    let working = finalApplication.content;
    let newContent = working;
    // Match the file's dominant line ending so the diff stays a clean targeted hunk, not whole-file churn.
    if (content.includes('\r\n')) newContent = newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    else newContent = newContent.replace(/\r\n/g, '\n');
    if (newContent === content) {
      logEntry({ reason, proposed: 0, note: 'no-op change', file: plan.file });
      return { ok: true, proposed: 0, note: 'Proposed change was a no-op.' };
    }
    // Safety: syntax-check the FULL combined result before proposing (multi-part edits carry more
    // risk). If it wouldn't parse, abandon rather than queue a broken upgrade.
    const syn = await _syntaxCheckContent(plan.file, newContent);
    if (syn && syn.ok === false) {
      const syntaxError = String(syn.error || '').replace(/\s+/g, ' ').trim();
      rememberProposalGenerationFailure({ file: plan.file, stage: 'syntax validation', error: syntaxError });
      logEntry({ reason, proposed: 0, note: 'multi-edit failed syntax check', file: plan.file, error: syntaxError.slice(0, 200) });
      return { ok: true, proposed: 0, note: `Drafted a ${edits.length}-part upgrade but it didn't pass a syntax check, so I held it back.` };
    }
    plan.reason = edit.reason || plan.issue;
    // Show the reviewer ALL the edits (it also receives the full current file + component map).
    const editsRepr = edits.map((e, i) => `--- EDIT ${i + 1} of ${edits.length} ---\nFIND:\n${e.find}\nREPLACE:\n${e.replace}`).join('\n\n');

    const proposalReview = await reviewProposal({
      file: plan.file,
      reason: plan.reason,
      diff: editsRepr,
    });
    // If the reviewer denied it, feed that concern back so the next proposals incorporate it.
    recordReviewerFeedback(plan.file, plan.reason, proposalReview);

    // Stage the proposal (gate independently refuses protected files).
    const decisionModel = planModel && editModel && planModel !== editModel ? `${planModel} -> ${editModel}` : (editModel || planModel || '');
    const metadata = {
      decisionModel,
      planModel,
      editModel,
      editsCount: edits.length,
      generatorReason: reason,
      proposedAt: new Date().toISOString(),
      reviewRecommendation: proposalReview.recommendation,
      reviewReason: proposalReview.reason,
      reviewers: proposalReview.reviewers,
      internalReviewRecommendation: proposalReview.recommendation,
      internalReviewReason: proposalReview.reason,
      externalReviewStatus: externalProposalReview.isEnabled() ? 'pending' : 'not_configured',
    };
    // Tier 3 #21: for a change that touches ROUTING/GUIDANCE behavior, stamp the current
    // behavioral eval score as the baseline this change will be judged against. Cheap — reads
    // the last recorded eval, never runs a fresh suite inline. Re-run POST /self/eval after
    // applying to see the delta.
    try {
      const evalHarness = (await import('./evalHarness.js')).default;
      if (evalHarness.isRoutingRelevant(plan.file)) {
        const base = evalHarness.lastScore();
        metadata.evalBaseline = base ? { score: base.score, passed: base.passed, total: base.total, at: base.at } : { score: null, note: 'no eval recorded yet — run POST /self/eval' };
      }
    } catch (e) { logger.warn('[selfImprove] eval baseline stamp failed', { error: e.message }); }
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
      if (externalProposalReview.isEnabled()) {
        try {
          externalProposalReview.queueReview({
            modificationId: res.modification_id,
            file: plan.file,
            reason: plan.reason,
            diff: res.diff || editsRepr,
            decisionModel,
            planModel,
            editModel,
            internalReview: proposalReview,
          });
          return {
            ok: true,
            proposed: 1,
            id: res.modification_id,
            file: plan.file,
            reason: plan.reason,
            status: 'awaiting_external_review',
            decisionModel,
            planModel,
            editModel,
            editsCount: edits.length,
            reviewRecommendation: proposalReview.recommendation,
            reviewReason: proposalReview.reason,
            reviewers: proposalReview.reviewers,
          };
        } catch (error) {
          logger.warn('[selfImprove] external review queue failed; exposing internal review', { error: error.message });
          await pythonWorker.selfMod({
            action: 'update_review', modification_id: res.modification_id, external_review_status: 'queue_error',
            review: { reviewer: 'codex-task', model: 'external-task', recommendation: 'unavailable', reason: error.message },
          }).catch(() => {});
        }
      }
      // Tier 2 #15: push the updated pending queue to the UI (no client polling).
      try { (await import('./uiPush.js')).default.pushSelfModPending(); } catch { /* ui push is best-effort */ }
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
        editsCount: edits.length,
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
    'For large files, FILE CONTENT contains issue-relevant excerpts plus <<<...OMITTED...>>> markers inserted by the server. The markers are not in the file; never include them in find or replace.',
    'COMPLETE & FUNCTIONAL: "replace" must be finished, working code. If you add a function/field/command/branch/doc, also include the code that IMPLEMENTS and USES it in the same edit. No docstrings without implementation, no unused declarations, no stubs/TODOs/placeholders, no partial change that needs a follow-up. It must run and do what your reason claims with no further edits — otherwise skip.',
  ].join('\n');
  const reproposalContext = buildIssueAwareFileContext(
    content,
    `${intent || ''}\n${rejectionReason || ''}`,
    18000,
  );
  const editUser = `ORIGINAL INTENT: ${intent || '(not recorded)'}\n\nWHY THE PREVIOUS PROPOSAL WAS REJECTED: ${rejectionReason || '(not recorded — infer the likely objections: wrong file/layer, too broad, mixed concerns, unsafe, or unverified — and avoid them)'}\n\nFILE: ${target}\n\n<<<FILE CONTENT>>>\n${reproposalContext}\n<<<END>>>`;

  let edit = null, editModel = '';
  try {
    const r = await llmService.chatSelfMod(
      [{ role: 'system', content: editSys }, { role: 'user', content: editUser }],
      {
        temperature: 0.1,
        max_tokens: 1800,
        model: process.env.AVA_SELFMOD_MODEL || undefined,
        responseFormat: SELF_MOD_REPROPOSE_RESPONSE_FORMAT,
        localPriority: 'background',
      }
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
  recordReviewerFeedback(target, reasonText, proposalReview);
  const metadata = {
    decisionModel: editModel, editModel,
    generatorReason: `reproposal of ${fromId || 'rejected change'}`,
    proposedAt: new Date().toISOString(),
    reviewRecommendation: proposalReview.recommendation,
    reviewReason: proposalReview.reason,
    reviewers: proposalReview.reviewers,
    internalReviewRecommendation: proposalReview.recommendation,
    internalReviewReason: proposalReview.reason,
    externalReviewStatus: externalProposalReview.isEnabled() ? 'pending' : 'not_configured',
    repropose_of: fromId || '',
    addresses_rejection: String(rejectionReason || '').slice(0, 400),
  };
  const pf = await pythonWorker.selfMod({ action: 'propose_fix', file: target, content: newContent, reason: reasonText, metadata });
  const res = (pf && (pf.result || pf)) || {};
  if (res.status === 'proposed') {
    logger.info('[selfImprove] queued a RE-proposal', { id: res.modification_id, file: path.basename(target), from: fromId });
    if (externalProposalReview.isEnabled()) {
      try {
        externalProposalReview.queueReview({
          modificationId: res.modification_id,
          file: target,
          reason: reasonText,
          diff: res.diff || `FIND:\n${edit.find}\n\nREPLACE:\n${edit.replace}`,
          decisionModel: editModel,
          editModel,
          internalReview: proposalReview,
        });
        return {
          ok: true, proposed: 1, id: res.modification_id, file: target, reason: reasonText,
          status: 'awaiting_external_review', reviewRecommendation: proposalReview.recommendation,
          reviewReason: proposalReview.reason,
        };
      } catch (error) {
        logger.warn('[selfImprove] external re-proposal review queue failed', { error: error.message });
        await pythonWorker.selfMod({
          action: 'update_review', modification_id: res.modification_id, external_review_status: 'queue_error',
          review: { reviewer: 'codex-task', model: 'external-task', recommendation: 'unavailable', reason: error.message },
        }).catch(() => {});
      }
    }
    // Tier 2 #15: push the updated pending queue to the UI (no client polling).
    try { (await import('./uiPush.js')).default.pushSelfModPending(); } catch { /* ui push is best-effort */ }
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
  const everyMs = Math.max(5, parseInt(process.env.AVA_SELF_IMPROVE_EVERY_MIN || '15', 10)) * 60 * 1000;
  if (!_learningListenerStarted) {
    _learningListenerStarted = true;
    onVoiceEvent(event => {
      const data = event?.data || {};
      if (event?.type === 'moltbook.learning.completed') {
        runScan({ reason: `Moltbook learning cycle completed: ${data.newLearnings || 0} new observations; corpus ${data.corpusHash || 'updated'}` }).catch(() => {});
        return;
      }
      if (event?.type === 'selfmod.external_review_completed' && data.modification) {
        const mod = data.modification;
        composeProposalAnnouncement({
          file: mod.file,
          reason: mod.reason,
          recommendation: mod.review_recommendation || data.recommendation || 'review',
          reviewReason: mod.review_reason || data.reason || '',
          id: mod.id || data.modificationId,
        }).then(text => announceQueue.pushAnnouncement(text)).catch(() => {});
      }
    });
  }
  const fallbackScan = () => {
    if (Date.now() - _lastScanAt >= everyMs * 0.9) runScan({ reason: 'scheduled fallback' }).catch(() => {});
  };
  // Align fallback scans to wall-clock cadence boundaries. Normal scans run
  // directly after the Moltbook learning event so proposals see that exact cycle.
  const firstDelay = everyMs - (Date.now() % everyMs);
  _timer = setTimeout(() => {
    fallbackScan();
    _timer = setInterval(fallbackScan, everyMs);
    if (_timer.unref) _timer.unref();
  }, firstDelay);
  if (_timer.unref) _timer.unref();
  logger.info('[selfImprove] scheduled after Moltbook learning with aligned fallback', { everyMinutes: everyMs / 60000 });
}

export default { runScan, start, reviewProposal, reproposeForFile, addLesson, rejectedProposalLesson, rememberRejectedProposal };
export { runScan, start, reviewProposal, reproposeForFile };
