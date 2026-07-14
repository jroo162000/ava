// Runtime-derived capability inventory. This is the single source of truth for
// what AVA can attempt now; prompts, self-description, Moltbook, and the UI all
// read the same snapshot rather than maintaining hand-written tool lists.
import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';
import avaPaths from '../utils/paths.js';
import logger from '../utils/logger.js';
import toolsService from './tools.js';
import pythonWorker from './pythonWorker.js';
import { emitVoiceEvent } from './voiceBus.js';

const SNAPSHOT_PATH = path.join(avaPaths.dataDir(), 'capabilities.json');
const REFRESH_MS = Math.max(15000, Number(process.env.AVA_CAPABILITY_REFRESH_MS) || 60000);
let current = loadSnapshot();
let timer = null;
let refreshing = null;
let providerState = null;

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); }
  catch { return { version: 1, generatedAt: null, tools: [], runtime: {}, providers: [] }; }
}

function saveSnapshot(snapshot) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const temp = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(temp, SNAPSHOT_PATH);
  } catch (error) {
    logger.warn('[capabilities] snapshot save failed', { error: error.message });
  }
}

function enumValues(schema, key) {
  const values = schema?.properties?.[key]?.enum;
  return Array.isArray(values) ? values.map(String) : [];
}

function summarizeTool(tool, builtinNames, workerReady) {
  const actions = [...new Set([
    ...enumValues(tool.schema, 'action'),
    ...enumValues(tool.schema, 'operation'),
    ...enumValues(tool.schema, 'mode'),
  ])];
  const builtin = builtinNames.has(tool.name);
  return {
    name: String(tool.name || ''),
    description: String(tool.description || '').replace(/\s+/g, ' ').trim(),
    actions,
    risk: tool.risk_level || 'unknown',
    requiresConfirmation: Boolean(tool.requires_confirm),
    backend: builtin ? 'node' : 'python-worker',
    status: builtin || workerReady ? 'registered' : 'unavailable',
    available: Boolean(builtin || workerReady),
    lastVerifiedAt: new Date().toISOString(),
  };
}

function providerSnapshot() {
  if (providerState) return providerState;
  const names = ['openai', 'claude', 'gemini', 'deepseek', 'grok', 'groq', 'local'];
  const configured = {
    openai: Boolean(config.OPENAI_API_KEY),
    claude: Boolean(config.ANTHROPIC_API_KEY || config.CLAUDE_API_KEY),
    gemini: Boolean(config.GOOGLE_API_KEY || config.GEMINI_API_KEY),
    deepseek: Boolean(config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY),
    grok: Boolean(config.GROK_API_KEY || process.env.GROK_API_KEY),
    groq: Boolean(config.GROQ_API_KEY),
    local: process.env.AVA_LOCAL_LLM_OFF !== '1',
  };
  return names.map(name => ({ name, configured: configured[name], status: configured[name] ? 'configured' : 'unavailable' }));
}

function voiceRuntime() {
  const integration = avaPaths.integrationDir();
  const runner = path.join(integration, 'ava_local_voice.py');
  const configPath = path.join(integration, 'ava_voice_config.json');
  let voiceConfig = {};
  try { voiceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* optional */ }
  const validation = voiceConfig.validation_mode && typeof voiceConfig.validation_mode === 'object'
    ? voiceConfig.validation_mode
    : {};
  const wakePhrases = Array.isArray(validation.wake_words)
    ? validation.wake_words
    : (Array.isArray(voiceConfig.wake_words) ? voiceConfig.wake_words : []);
  const route = String(voiceConfig.server_route || 'respond').replace(/^\/+/, '');
  const localHost = config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST;
  return {
    canonicalRunner: runner,
    runnerPresent: fs.existsSync(runner),
    configuredServer: voiceConfig.server_url || `http://${localHost}:${config.PORT}/${route}`,
    wakeWordMode: wakePhrases.length ? 'local-whisper-final-gate' : 'local-whisper-open-turn',
    wakePhrasesConfigured: wakePhrases.length,
  };
}

export async function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const tools = await toolsService.getAllTools(force).catch(() => []);
    const builtinNames = new Set(toolsService.getBuiltinTools().map(tool => tool.name));
    const workerReady = pythonWorker.isReady();
    const snapshot = {
      version: 1,
      generatedAt: new Date().toISOString(),
      tools: tools.filter(tool => tool?.name).map(tool => summarizeTool(tool, builtinNames, workerReady)),
      runtime: {
        platform: process.platform,
        server: { host: config.HOST, port: config.PORT, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
        pythonWorker: { ready: workerReady, modules: Object.keys(pythonWorker.getModules?.() || {}) },
        voice: voiceRuntime(),
        writeEnabled: ['1', 'true'].includes(String(process.env.ALLOW_WRITE || '').toLowerCase()),
      },
      providers: providerSnapshot(),
    };
    current = snapshot;
    saveSnapshot(snapshot);
    emitVoiceEvent('capabilities.updated', { generatedAt: snapshot.generatedAt, toolCount: snapshot.tools.length }, 'capabilities');
    return snapshot;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function setProviderState(providers) {
  providerState = Array.isArray(providers) ? providers : null;
}

export function snapshot() {
  return JSON.parse(JSON.stringify(current));
}

export function find(query, limit = 12) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  return current.tools.map(tool => {
    const hay = `${tool.name} ${tool.description} ${tool.actions.join(' ')}`.toLowerCase();
    return { ...tool, score: terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0) };
  }).filter(tool => tool.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function promptBlock({ maxTools = 80 } = {}) {
  const tools = current.tools.slice(0, maxTools);
  const lines = tools.map(tool => {
    const actions = tool.actions.length ? `; actions: ${tool.actions.join(', ')}` : '';
    const gate = tool.requiresConfirmation ? '; confirmation required' : '';
    return `- ${tool.name} [${tool.status}]: ${tool.description}${actions}${gate}`;
  });
  const providers = current.providers.map(p => `${p.name}:${p.status}`).join(', ');
  return [
    `RUNTIME CAPABILITY REGISTRY (generated ${current.generatedAt || 'during startup'}):`,
    ...lines,
    `LLM providers: ${providers || 'not yet checked'}`,
    'Use only this registry when describing your capabilities. "registered" means you may attempt the tool; it is not proof that an external dependency is healthy.',
    'Never claim an action succeeded until its tool receipt and postcondition say it succeeded. If a capability is unavailable, name the dependency or failed receipt rather than denying the capability exists.',
  ].join('\n');
}

export function start() {
  if (timer) return;
  refresh({ force: true }).catch(error => logger.warn('[capabilities] initial refresh failed', { error: error.message }));
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  if (timer.unref) timer.unref();
}

export default { refresh, start, snapshot, find, promptBlock, setProviderState, path: SNAPSHOT_PATH };
