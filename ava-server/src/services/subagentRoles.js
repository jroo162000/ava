// subagentRoles.js — named SUBAGENT ROLES, each with a description, a SCOPED toolset (allow/deny,
// Claude-SDK style), and a specialized system prompt. The lead assigns a role per subtask; the
// agent loop restricts that subagent to its role's tools and gives it the role's instructions.
//
// Roles are DYNAMIC + PERSISTENT: beyond the built-in set, AVA can CREATE new role types on the fly
// (when no existing role fits a task). Custom roles are saved to data/subagent-roles.json and stay
// available for reuse across restarts. Built-in roles can't be overridden. Tool patterns support
// exact names and a trailing '*' wildcard (e.g. "fs_*"); allow:null = full toolset.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';

const BUILTIN = {
  researcher: {
    description: 'Gathers and analyzes information — web search, reading files/email/screen, memory. Does NOT modify the system or build things.',
    allow: ['web_search', 'net_ops', 'memory_search', 'analysis_ops', 'vision_ops', 'screen_ops', 'ocr_ops', 'file_resolve', 'fs_ops', 'self_diagnostics', 'self_awareness', 'sys_ops', 'comm_ops', 'browser_automation'],
    prompt: 'You are a RESEARCHER subagent. Gather, read, search, and analyze to answer your task. Do not modify files, change the system, send messages, or build artifacts — just find and report accurate information clearly.',
  },
  builder: {
    description: 'Creates artifacts — websites (web_builder), images (image_ops), 3D models (model3d_ops), 3D/AR scenes (scene3d), files (fs_ops/file_gen).',
    allow: ['fs_ops', 'file_gen', 'file_resolve', 'web_builder', 'scene3d', 'image_ops', 'model3d_ops', 'analysis_ops', 'memory_search'],
    prompt: 'You are a BUILDER subagent. Produce complete, working artifacts (web pages, images, 3D models/scenes, files) for your task. Finish the deliverable; do not leave stubs.',
  },
  coder: {
    description: "Writes and edits code/scripts (including AVA's own source via the approval-gated self-mod).",
    allow: ['fs_ops', 'file_resolve', 'ps_exec', 'analysis_ops', 'self_diagnostics', 'self_mod', 'json_ops'],
    prompt: 'You are a CODER subagent. Write or edit complete, correct, runnable code/scripts for your task. No stubs, TODOs, or partial changes. Source changes to AVA still go through the human approval gate.',
  },
  operator: {
    description: 'Drives the computer — opens apps, controls windows, clicks/types, and operates the browser.',
    allow: ['open_item', 'app_control', 'window_ops', 'key_ops', 'mouse_ops', 'screen_ops', 'vision_ops', 'browser_automation', 'computer_use', 'computer_use_control'],
    prompt: 'You are an OPERATOR subagent. Operate the machine to accomplish your task — open apps, manage windows, drive the browser, click and type. Verify each step worked before moving on.',
  },
  communicator: {
    description: 'Handles communication and scheduling — email, calendar, contacts, voice.',
    allow: ['comm_ops', 'calendar_ops', 'profile_ops', 'voice_ops', 'memory_search'],
    prompt: 'You are a COMMUNICATOR subagent. Handle email, calendar, contacts, and scheduling for your task. Confirm details before sending or creating anything.',
  },
  analyst: {
    description: 'Reasons over data and produces findings — math, stats, code/data analysis, memory. Avoids side effects.',
    allow: ['analysis_ops', 'memory_search', 'fs_ops', 'json_ops', 'self_diagnostics', 'web_search'],
    prompt: 'You are an ANALYST subagent. Analyze data and produce clear, specific findings for your task. Avoid side effects — read and reason, do not change things.',
  },
  accountant: {
    description: 'Finance, bookkeeping, and tax expert — exact calculations (finance_ops), authoritative research (web_search/web_scrape), clear written schedules/statements (file_gen/xlsx). US federal + all 50 states. Not a licensed CPA/tax advisor.',
    allow: ['finance_ops', 'web_search', 'web_scrape', 'file_gen', 'fs_ops', 'file_resolve', 'analysis_ops', 'memory_search', 'json_ops'],
    prompt: 'You are an ACCOUNTANT / TAX subagent — expert in US finance, bookkeeping, and tax (federal + all 50 states). Ground every factual claim in authoritative sources (IRS publications, state Departments of Revenue, GAAP); search them when unsure and cite the source + date. Do the MATH with finance_ops (journal entries, depreciation incl. MACRS, self-employment tax, federal/state income tax, amortization) — never compute in your head — and flag year- and jurisdiction-specific figures. Produce clear, organized output (use file_gen / xlsx for schedules or financial statements). You are NOT a licensed CPA or tax advisor: give the facts, methods, and numbers so the user can decide, and say so plainly on anything that amounts to personalized advice.',
  },
  general: {
    description: 'General-purpose subagent with the FULL toolset (use when a task spans many categories).',
    allow: null,
    prompt: 'You are a general-purpose subagent with the full toolset. Use whatever tools your task needs.',
  },
};

const DEFAULT_ROLE = 'general';
const CUSTOM_FILE = path.join(avaPaths.dataDir(), 'subagent-roles.json');

function _loadCustom() {
  try { if (fs.existsSync(CUSTOM_FILE)) { const j = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); if (j && typeof j === 'object') return j; } } catch { /* ignore */ }
  return {};
}
let _custom = _loadCustom();

function _saveCustom() {
  try { fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true }); fs.writeFileSync(CUSTOM_FILE, JSON.stringify(_custom, null, 2)); }
  catch (e) { try { logger.warn('[roles] save failed', { error: e.message }); } catch { /* ignore */ } }
}

function _slug(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function getRole(name) {
  const key = _slug(name);
  if (_custom[key]) return { name: key, custom: true, ..._custom[key] };
  if (BUILTIN[key]) return { name: key, ...BUILTIN[key] };
  return { name: DEFAULT_ROLE, ...BUILTIN[DEFAULT_ROLE] };
}

function roleExists(name) {
  const key = _slug(name);
  return !!(BUILTIN[key] || _custom[key]);
}

// Create or update a CUSTOM role and PERSIST it. Built-in role names can't be overridden.
function createRole({ name, description, prompt, allow, tools, deny }) {
  const key = _slug(name);
  if (!key) return { ok: false, error: 'invalid role name' };
  if (BUILTIN[key]) return { ok: false, error: `'${key}' is a built-in role and can't be overridden` };
  const allowList = Array.isArray(allow) ? allow : (Array.isArray(tools) ? tools : null);
  _custom[key] = {
    description: String(description || `Custom role: ${key}`).slice(0, 300),
    prompt: String(prompt || `You are a ${key} subagent. Do your assigned task and report a clear, complete result.`).slice(0, 1500),
    allow: (allowList && allowList.length) ? allowList.map(t => String(t).slice(0, 60)).slice(0, 40) : null,
    ...(Array.isArray(deny) && deny.length ? { deny: deny.map(t => String(t).slice(0, 60)).slice(0, 40) } : {}),
    createdAt: new Date().toISOString(),
  };
  _saveCustom();
  try { logger.info('[roles] custom role saved', { role: key, tools: _custom[key].allow ? _custom[key].allow.length : 'all' }); } catch { /* ignore */ }
  return { ok: true, name: key, custom: true, ..._custom[key] };
}

function deleteRole(name) {
  const key = _slug(name);
  if (!_custom[key]) return { ok: false, error: `'${key}' is not a custom role` };
  delete _custom[key];
  _saveCustom();
  return { ok: true, deleted: key };
}

function listRoles() {
  const out = Object.entries(BUILTIN).map(([name, r]) => ({ name, description: r.description, tools: r.allow ? r.allow.length : 'all', builtin: true }));
  for (const [name, r] of Object.entries(_custom)) out.push({ name, description: r.description, tools: r.allow ? r.allow.length : 'all', builtin: false });
  return out;
}

// One-line "name — description" list for prompting the lead.
function rolesForPrompt() {
  const lines = Object.entries(BUILTIN).map(([name, r]) => `  - ${name}: ${r.description}`);
  for (const [name, r] of Object.entries(_custom)) lines.push(`  - ${name} (custom): ${r.description}`);
  return lines.join('\n');
}

export { BUILTIN, DEFAULT_ROLE, getRole, roleExists, createRole, deleteRole, listRoles, rolesForPrompt };
export default { BUILTIN, DEFAULT_ROLE, getRole, roleExists, createRole, deleteRole, listRoles, rolesForPrompt };
