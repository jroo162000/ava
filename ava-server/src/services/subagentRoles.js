// subagentRoles.js — named SUBAGENT ROLES, each with a description, a SCOPED toolset (allow/deny,
// Claude-SDK style), and a specialized system prompt. The lead assigns a role per subtask; the
// agent loop then restricts that subagent to its role's tools and gives it the role's instructions.
// Tool patterns support exact names and a trailing '*' wildcard (e.g. "fs_*"). allow:null = all tools.

const ROLES = {
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
  general: {
    description: 'General-purpose subagent with the FULL toolset (use when a task spans many categories).',
    allow: null,  // no restriction
    prompt: 'You are a general-purpose subagent with the full toolset. Use whatever tools your task needs.',
  },
};

const DEFAULT_ROLE = 'general';

function getRole(name) {
  const key = String(name || '').toLowerCase().trim();
  return ROLES[key] ? { name: key, ...ROLES[key] } : { name: DEFAULT_ROLE, ...ROLES[DEFAULT_ROLE] };
}

function listRoles() {
  return Object.entries(ROLES).map(([name, r]) => ({
    name, description: r.description, tools: r.allow ? r.allow.length : 'all',
  }));
}

// One-line "name — description" list for prompting the lead.
function rolesForPrompt() {
  return Object.entries(ROLES).map(([name, r]) => `  - ${name}: ${r.description}`).join('\n');
}

export { ROLES, DEFAULT_ROLE, getRole, listRoles, rolesForPrompt };
export default { ROLES, DEFAULT_ROLE, getRole, listRoles, rolesForPrompt };
