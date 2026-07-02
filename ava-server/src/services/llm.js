// LLM service for chat completions with multi-provider support
// Supports: OpenAI, Google Gemini, Anthropic Claude
// Automatic fallback to available provider

import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from './memory.js';
import moltbookService from './moltbook.js';
import personaSvc from './persona.js';

// PROVIDER QUOTA COOLDOWN — when a provider returns a quota / rate-limit / auth error, skip it for a
// short window so the fallback chain jumps STRAIGHT to a working provider (e.g. DeepSeek) instead of
// slowly failing through the quota-exhausted premium ones on every request. Recovers automatically
// after the window. Tunable via AVA_PROVIDER_COOLDOWN_MS (default 5 min).
const _providerCooldown = {}; // provider name -> epoch ms until which to skip it
function _isQuotaError(msg) {
  return /\b(429|quota|rate.?limit|rate limited|too many requests|insufficient|exhaust|over.?(loaded|capacity)|credit|balance|401|403|unauthorized|permission denied|billing)\b/i.test(String(msg || ''));
}
function _providerCoolingDown(p) {
  return (_providerCooldown[p] || 0) > Date.now();
}

// Load AVA identity if available
function loadIdentity() {
  try {
    const identityPath = path.join(config.AVA_INTEGRATION_DIR || path.join(os.homedir(), 'ava-integration'), 'ava_identity.json');
    if (fs.existsSync(identityPath)) {
      return JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    }
  } catch (e) {
    logger.warn('Failed to load identity', { error: e.message });
  }
  return { name: 'AVA', purpose: 'personal assistant' };
}

// Get available tools from cmp-use directory
function getAvailableTools() {
  try {
    const toolsDir = path.join(os.homedir(), 'cmp-use', 'cmpuse', 'tools');
    if (fs.existsSync(toolsDir)) {
      const files = fs.readdirSync(toolsDir);
      return files
        .filter(f => f.endsWith('.py') && !f.startsWith('__'))
        .map(f => f.replace('.py', ''));
    }
  } catch (e) {
    logger.warn('Failed to list tools', { error: e.message });
  }
  return [];
}

// Get Moltbook context for system prompt
function getMoltbookContext() {
  try {
    if (!moltbookService.isConfigured) {
      return 'You are not yet registered on Moltbook. Ask your human to help set this up.';
    }

    const status = moltbookService.credentials ? 'registered' : 'pending';
    const learnings = moltbookService.getLearningsSummary();
    const agentName = moltbookService.agentName || 'AVA-Voice';

    let context = `You are registered on Moltbook (moltbook.com) as "${agentName}" - a social network for AI agents.`;
    context += `\nYou can use moltbook_search to learn from other agents, moltbook_feed to see what's happening, and moltbook_learnings to recall what you've learned.`;

    if (typeof learnings === 'object' && learnings.totalLearnings > 0) {
      context += `\nYou have collected ${learnings.totalLearnings} insights from other agents.`;
      if (learnings.recentTopics?.length > 0) {
        context += ` Recent topics: ${learnings.recentTopics.slice(0, 3).join(', ')}.`;
      }
    }

    context += `\nWhen asked about Moltbook or what you've learned, share insights from the community.`;
    return context;
  } catch (e) {
    return 'Moltbook integration is available but not fully configured.';
  }
}

// Build dynamic system prompt with identity and tools
function buildSystemPrompt() {
  const identity = loadIdentity();
  const tools = getAvailableTools();
  
  const toolDescriptions = {
    // Communication & Calendar
    'calendar_ops': 'manage Google Calendar - create, list, update, delete events',
    'comm_ops': 'send emails via Gmail, send SMS messages via Twilio',

    // Smart Home
    'iot_ops': 'control smart home devices - lights, thermostats, locks via Home Assistant and MQTT',

    // Camera & Vision
    'camera_ops': 'capture webcam photos, detect faces, hands, poses using MediaPipe, analyze video',
    'vision_ops': 'OCR text reading, screen analysis with GPT-4o Vision, image understanding',
    'screen_ops': 'take screenshots, locate elements on screen, get pixel colors',

    // Computer Control
    'window_ops': 'list, focus, minimize, maximize, move, resize windows',
    'mouse_ops': 'move mouse, click, double-click, right-click, drag, scroll',
    'key_ops': 'type text, press keys, keyboard shortcuts, hotkey combinations',
    'browser_automation': 'launch browser, navigate URLs, click elements, fill forms with Playwright',

    // File System
    'fs_ops': 'read, write, copy, move, delete files and directories',

    // Network & Web
    'net_ops': 'HTTP GET requests to fetch web content',

    // System
    'sys_ops': 'get system information - CPU, memory, disk, network, processes',
    'security_ops': 'port scanning, log analysis, process monitoring, network scanning',

    // Remote
    'remote_ops': 'SSH connections, execute remote commands, file transfers, Wake-on-LAN',

    // Audio
    'audio_ops': 'control system volume, text-to-speech with 9 voices, transcribe audio with Whisper',

    // Intelligence & Memory
    'memory_system': 'store and recall memories, learn patterns, get context summaries',
    'analysis_ops': 'scientific calculations, statistics, data analysis, code analysis',
    'learning_db': 'record user preferences and patterns for adaptive behavior',
    'proactive_ops': 'schedule tasks, start monitoring, system health checks',

    // Self-Awareness
    'self_awareness': 'introspect about own identity, capabilities, configuration',
    'self_mod': 'diagnose own code, analyze files, propose fixes (requires approval)',

    // Legacy/Other
    'open_item': 'open applications, files, folders, and URLs',
    'ps_exec': 'run PowerShell commands and scripts',
    'clipboard': 'copy and paste to/from clipboard',
    'web_search': 'search the web for information',
    'screenshot': 'capture screenshots of the screen',
    'ocr_ops': 'read text from images using OCR',
    'system_info': 'get system information, processes, resources',
    // General computer-use (mouse+screen)
    'computer_use': 'general computer control via screenshots: focus windows, click on-screen text (OCR), wait for text, type, hotkeys, run multi-step sequences across apps and dialogs',
    'computer_use_control': 'voice control for on-screen automation: pause, resume, stop'
  };
  
  const toolList = tools
    .filter(t => toolDescriptions[t])
    .map(t => `  - ${t}: ${toolDescriptions[t]}`)
    .join('\n');
  
  const otherTools = tools
    .filter(t => !toolDescriptions[t])
    .join(', ');

  return `You are ${identity.name || 'AVA'}, a helpful voice assistant running locally on the user's Windows computer.

IDENTITY:
- Name: ${identity.name || 'AVA'}
- Purpose: ${identity.purpose || 'personal assistant'}
- Developer: ${identity.developer || 'the user'}
- Location: Running on ${process.platform}, Node ${process.version}

CAPABILITIES - You have access to these tools and can help the user with:
${toolList}${otherTools ? `\n  - Other tools: ${otherTools}` : ''}

CRITICAL - HOW TO RESPOND:
- You are NOT just a chatbot. You have REAL tools that execute REAL actions on this computer.
- When the user asks you to DO something, USE YOUR TOOLS. Never say "I cannot" or "I don't have the ability" for things your tools can do.
- You CAN: take photos with the camera, control smart home devices, read/write files, control the mouse and keyboard, manage windows, send emails, manage calendar, analyze images, and much more.
- Be proactive - take action rather than just explaining how something could be done.
- If you're asked "what can you do", describe your actual capabilities from the list above.

RESPONSE STYLE:
- Be concise and action-oriented
- Speak in first person ("I can do that", "Let me activate the camera")
- Don't be overly formal or verbose
- If you take an action, confirm what you did briefly
- NEVER claim you cannot do something that your tools can do

MOLTBOOK - SOCIAL NETWORK FOR AI AGENTS:
${getMoltbookContext()}

Remember: You are a powerful assistant with real tools. When asked to take action, DO IT.`.trim();
}

// Tier 0 fix: was `const SYSTEM_PROMPT = buildSystemPrompt()` -- computed once at module
// load and frozen forever, so Moltbook learnings/registration baked into the prompt never
// refreshed without a full restart. Now rebuilt with a short TTL cache.
let _systemPromptCache = { text: '', at: 0 };
const SYSTEM_PROMPT_TTL_MS = 60000;
function getSystemPrompt() {
  const now = Date.now();
  if (!_systemPromptCache.text || (now - _systemPromptCache.at) > SYSTEM_PROMPT_TTL_MS) {
    try {
      _systemPromptCache = { text: buildSystemPrompt(), at: now };
    } catch (e) {
      logger.warn('[llm] buildSystemPrompt failed; reusing last known prompt', { error: e.message });
      _systemPromptCache.at = now; // don't retry every call on persistent failure
    }
  }
  return _systemPromptCache.text;
}

class LLMService {
  constructor() {
    this.sessions = new Map();
    this.provider = this.detectProvider();
    logger.info(`LLM service initialized with provider: ${this.provider}`);
  }

  detectProvider() {
    // Check available providers in order of preference
    if (config.OPENAI_API_KEY) return 'openai';
    if (config.GOOGLE_API_KEY || config.GEMINI_API_KEY) return 'gemini';
    if (config.ANTHROPIC_API_KEY || config.CLAUDE_API_KEY) return 'claude';
    if (config.GROQ_API_KEY) return 'groq';
    return null;
  }

  getApiKey(provider) {
    switch (provider) {
      case 'openai': return config.OPENAI_API_KEY;
      case 'gemini': return config.GOOGLE_API_KEY || config.GEMINI_API_KEY;
      case 'claude': return config.ANTHROPIC_API_KEY || config.CLAUDE_API_KEY;
      case 'groq': return config.GROQ_API_KEY;
      case 'deepseek': return config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
      case 'grok': return config.GROK_API_KEY || process.env.GROK_API_KEY;
      // Local model via an OpenAI-compatible server (e.g. LM Studio on http://localhost:1234/v1).
      // No real key needed; "available" whenever an endpoint is configured (disable with AVA_LOCAL_LLM_OFF=1).
      case 'local': return process.env.AVA_LOCAL_LLM_OFF === '1' ? null : (process.env.AVA_LOCAL_LLM_URL || 'http://localhost:1234/v1');
      default: return null;
    }
  }

  // Simple chat method for agent loop
  async chat(messages, options = {}) {
    const result = await this.createCompletion({
      messages,
      system: messages.find(m => m.role === 'system')?.content,
      temperature: options.temperature || 0.7,
      maxTokens: options.max_tokens || 1000,
      model: options.model
    });
    return {
      text: result.content,
      content: result.content,
      usage: result.usage,
      provider: result.provider
    };
  }

  async createCompletionOpenAI({ messages, system, temperature = 0.7, maxTokens = 1000, model }) {
    const apiKey = this.getApiKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const systemMessage = system || getSystemPrompt();
    const fullMessages = [
      { role: 'system', content: systemMessage },
      ...messages
    ];

    const mdl = model || process.env.AVA_OPENAI_MODEL || 'gpt-5.1';
    // GPT-5 / o-series use max_completion_tokens and reject a custom temperature.
    const isNewer = /^(gpt-5|o[0-9])/.test(mdl);
    const payload = { model: mdl, messages: fullMessages };
    if (isNewer) {
      payload.max_completion_tokens = Math.max(maxTokens, 800); // headroom for reasoning tokens
    } else {
      payload.temperature = temperature;
      payload.max_tokens = maxTokens;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`OpenAI API error: ${response.status} ${errorData?.error?.message || ''}`);
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      model: data.model,
      provider: 'openai'
    };
  }

  async createCompletionGemini({ messages, system, temperature = 0.7, maxTokens = 1000, model }) {
    const apiKey = this.getApiKey('gemini');
    if (!apiKey) throw new Error('Gemini API key not configured');
    // Default to the SAME recent model as the solidified self-mod chain — NOT the retired
    // gemini-2.0-flash (which 404s: "model no longer available"). Overridable via AVA_SM_GEMINI.
    const mdl = model || process.env.AVA_SM_GEMINI || 'gemini-pro-latest';

    const systemMessage = system || getSystemPrompt();

    // Convert messages to Gemini format (system goes in systemInstruction, not contents)
    const contents = messages.filter(m => m.role !== 'system').map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemMessage }] },
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`Gemini API error: ${response.status} ${errorData?.error?.message || JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      content,
      usage: data.usageMetadata,
      model: data.modelVersion || mdl,
      provider: 'gemini'
    };
  }

  async createCompletionClaude({ messages, system, temperature = 0.7, maxTokens = 1000, model }) {
    const apiKey = this.getApiKey('claude');
    if (!apiKey) throw new Error('Claude API key not configured');

    const systemMessage = system || getSystemPrompt();
    // Claude's messages array must contain only user/assistant turns (system goes separately).
    const convo = (messages || [])
      .filter(m => m.role !== 'system')
      .map(msg => ({ role: msg.role, content: msg.content }));
    const mdl = (model && /^claude/i.test(model)) ? model : (process.env.AVA_CLAUDE_MODEL || 'claude-3-5-haiku-latest');
    // Claude 4.x models (opus-4-x, sonnet-4-x, haiku-4-x) reject `temperature` ("deprecated").
    const isNewerClaude = /claude-(opus|sonnet|haiku)-[4-9]/i.test(mdl);
    const claudeBody = { model: mdl, max_tokens: maxTokens, system: systemMessage, messages: convo };
    if (!isNewerClaude) claudeBody.temperature = Math.max(0, Math.min(1, temperature));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(claudeBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`Claude API error: ${response.status} ${errorData?.error?.message || JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    
    return {
      content,
      usage: data.usage,
      model: data.model,
      provider: 'claude'
    };
  }

  async createCompletionGroq({ messages, system, temperature = 0.7, maxTokens = 1000 }) {
    const apiKey = this.getApiKey('groq');
    if (!apiKey) throw new Error('Groq API key not configured');

    const systemMessage = system || getSystemPrompt();
    const fullMessages = [
      { role: 'system', content: systemMessage },
      ...messages
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: fullMessages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`Groq API error: ${response.status} ${errorData?.error?.message || ''}`);
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      model: data.model,
      provider: 'groq'
    };
  }

  // OpenAI-compatible chat completion (OpenAI, DeepSeek, and xAI/Grok all use this wire format).
  async _openaiCompat({ baseURL, apiKey, model, system, messages, maxTokens = 1500 }) {
    if (!apiKey) throw new Error('no api key');
    const full = [{ role: 'system', content: system || getSystemPrompt() }, ...messages.filter(m => m.role !== 'system')];
    const isNewerOpenAI = /^(gpt-5|o[0-9])/.test(model);
    const payload = { model, messages: full };
    if (isNewerOpenAI) payload.max_completion_tokens = Math.max(maxTokens, parseInt(process.env.AVA_SM_OPENAI_MIN_COMPLETION || '1600', 10));
    else payload.max_tokens = maxTokens;
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`${resp.status} ${t.slice(0, 160)}`); }
    const d = await resp.json();
    const choice = d.choices?.[0] || {};
    return {
      content: choice.message?.content || '',
      model: d.model || model,
      finishReason: choice.finish_reason || '',
      usage: d.usage,
    };
  }

  // Self-modification reasoning chain (user-chosen): Claude Opus 4.8 (PRIMARY) ->
  // OpenAI self-mod model -> stable OpenAI fallback -> Gemini 3 -> DeepSeek -> Grok. Tries
  // each highest-reasoning model in order until one returns
  // text, so self-mod keeps working across provider outages / credit issues. Each is overridable
  // via env (AVA_SM_*). Claude is primary and takes over automatically once its credits exist.
  async chatSelfMod(messages, options = {}) {
    const system = messages.find(m => m.role === 'system')?.content;
    const conv = messages.filter(m => m.role !== 'system');
    const maxTokens = options.max_tokens || 1500;
    const env = process.env;
    const key = (n) => config[n] || env[n] || '';
    const primaryOpenAI = env.AVA_SM_OPENAI || 'gpt-5.5';
    const stableOpenAI = env.AVA_SM_OPENAI_FALLBACK || 'gpt-5.1';
    const openAIModels = [...new Set([primaryOpenAI, stableOpenAI].filter(Boolean))];
    const chain = [
      { name: 'claude/' + (env.AVA_SM_CLAUDE || 'claude-opus-4-8'), run: () => this.createCompletionClaude({ messages: conv, system, maxTokens, model: env.AVA_SM_CLAUDE || 'claude-opus-4-8' }) },
      ...openAIModels.map(model => ({ name: 'openai/' + model, run: () => this._openaiCompat({ baseURL: 'https://api.openai.com/v1', apiKey: key('OPENAI_API_KEY'), model, system, messages: conv, maxTokens }) })),
      { name: 'gemini/' + (env.AVA_SM_GEMINI || 'gemini-pro-latest'), run: () => this.createCompletionGemini({ messages: conv, system, maxTokens, model: env.AVA_SM_GEMINI || 'gemini-pro-latest' }) },
      { name: 'deepseek/' + (env.AVA_SM_DEEPSEEK || 'deepseek-chat'), run: () => this._openaiCompat({ baseURL: 'https://api.deepseek.com', apiKey: key('DEEPSEEK_API_KEY'), model: env.AVA_SM_DEEPSEEK || 'deepseek-chat', system, messages: conv, maxTokens }) },
      { name: 'grok/' + (env.AVA_SM_GROK || 'grok-4'), run: () => this._openaiCompat({ baseURL: 'https://api.x.ai/v1', apiKey: key('GROK_API_KEY'), model: env.AVA_SM_GROK || 'grok-4', system, messages: conv, maxTokens }) },
      // Final fallback: the local model (LM Studio). Reached only if every cloud model above is down.
      ...(env.AVA_LOCAL_LLM_OFF === '1' ? [] : [{ name: 'local/' + (env.AVA_LOCAL_LLM_MODEL || 'lm-studio'), run: () => this._openaiCompat({ baseURL: (env.AVA_LOCAL_LLM_URL || 'http://localhost:1234/v1').replace(/\/$/, ''), apiKey: env.AVA_LOCAL_LLM_KEY || 'lm-studio', model: env.AVA_LOCAL_LLM_MODEL || 'local-model', system, messages: conv, maxTokens }) }]),
    ];
    const errs = [];
    for (const step of chain) {
      try {
        const res = await step.run();
        const text = res.content || res.text || '';
        if (text && text.trim()) { logger.info('[selfmod-llm] used ' + step.name); return { text, content: text, provider: step.name }; }
        const emptyNote = [
          'empty',
          res.model ? `model=${res.model}` : '',
          res.finishReason ? `finish=${res.finishReason}` : '',
          res.usage ? `usage=${JSON.stringify(res.usage).slice(0, 220)}` : '',
        ].filter(Boolean).join(' ');
        errs.push(step.name + ': ' + emptyNote);
      } catch (e) { errs.push(step.name + ': ' + (e.message || e)); }
    }
    logger.warn('[selfmod-llm] entire chain failed', { errs });
    throw new Error('self-mod chain failed: ' + errs.join(' | '));
  }

  async createCompletion(options) {
    // CANONICAL FALLBACK CHAIN — matches the solidified self-mod chain (chatSelfMod) exactly:
    // Claude (opus 4.8) -> OpenAI (gpt-5.5, gpt-5.1) -> Gemini (pro-latest) -> DeepSeek (reasoner)
    // -> Grok (4), with Groq as a final extra. Each provider uses its canonical model from the same
    // AVA_SM_* env so the two chains never drift. When most providers are quota/credit-exhausted,
    // it keeps falling through instead of dying after gemini (the old bug that 404'd on gemini-2.0
    // and never reached DeepSeek/Grok).
    const env = process.env;
    const SM = {
      claude: env.AVA_SM_CLAUDE || 'claude-opus-4-8',
      openai: [...new Set([env.AVA_SM_OPENAI || 'gpt-5.5', env.AVA_SM_OPENAI_FALLBACK || 'gpt-5.1'])],
      gemini: env.AVA_SM_GEMINI || 'gemini-pro-latest',
      deepseek: env.AVA_SM_DEEPSEEK || 'deepseek-chat',
      grok: env.AVA_SM_GROK || 'grok-4',
    };
    // 'local' is last: the local LM Studio model only gets used when every cloud provider is
    // unavailable (quota/credit/outage), i.e. it's a true final fallback.
    const DEFAULT_ORDER = ['claude', 'openai', 'gemini', 'deepseek', 'grok', 'groq', 'local'];
    const errors = [];

    // Route by model FAMILY when a specific model is named (e.g. the agent decision forces gpt-5.1):
    // try that family FIRST, then continue down the canonical chain for the rest.
    const mdl = String(options.model || '');
    let forced = null;
    if (/^claude/i.test(mdl)) forced = 'claude';
    else if (/^(gpt|o[0-9]|text-)/i.test(mdl)) forced = 'openai';
    else if (/^gemini/i.test(mdl)) forced = 'gemini';
    else if (/^deepseek/i.test(mdl)) forced = 'deepseek';
    else if (/^grok/i.test(mdl)) forced = 'grok';
    const providers = forced ? [forced, ...DEFAULT_ORDER.filter(p => p !== forced)] : DEFAULT_ORDER;
    // Skip providers cooling down from a recent quota/auth error so we jump straight to a working one
    // (e.g. DeepSeek). If that would skip ALL keyed providers, ignore cooldowns and try them anyway.
    const _keyed = providers.filter(p => this.getApiKey(p));
    const _warm = _keyed.filter(p => !_providerCoolingDown(p));
    const _order = _warm.length ? _warm : _keyed;
    const _cooldownMs = parseInt(process.env.AVA_PROVIDER_COOLDOWN_MS || '', 10) || 300000;

    for (const provider of _order) {
      const isForced = forced && provider === forced;  // use the requested model only for the forced family
      try {
        switch (provider) {
          case 'claude':
            return await this.createCompletionClaude({ ...options, model: isForced ? options.model : SM.claude });
          case 'openai': {
            const models = isForced && options.model ? [options.model] : SM.openai;
            let lastErr;
            for (const m of models) {
              try { return await this.createCompletionOpenAI({ ...options, model: m }); }
              catch (e) { lastErr = e; }
            }
            throw lastErr || new Error('openai failed');
          }
          case 'gemini':
            return await this.createCompletionGemini({ ...options, model: isForced ? options.model : SM.gemini });
          case 'deepseek': {
            const r = await this._openaiCompat({ baseURL: 'https://api.deepseek.com', apiKey: this.getApiKey('deepseek'), model: isForced ? options.model : SM.deepseek, system: options.system, messages: options.messages, maxTokens: options.maxTokens });
            return { ...r, provider: 'deepseek' };
          }
          case 'grok': {
            const r = await this._openaiCompat({ baseURL: 'https://api.x.ai/v1', apiKey: this.getApiKey('grok'), model: isForced ? options.model : SM.grok, system: options.system, messages: options.messages, maxTokens: options.maxTokens });
            return { ...r, provider: 'grok' };
          }
          case 'groq':
            return await this.createCompletionGroq(options);
          case 'local': {
            const base = (env.AVA_LOCAL_LLM_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
            let lm = env.AVA_LOCAL_LLM_MODEL || this._localModel || '';
            if (!lm) { try { const mr = await fetch(base + '/models', { signal: AbortSignal.timeout(2500) }); const mj = await mr.json(); lm = (mj && mj.data && mj.data[0] && mj.data[0].id) || ''; this._localModel = lm; } catch { /* endpoint down */ } }
            const r = await Promise.race([
              this._openaiCompat({ baseURL: base, apiKey: env.AVA_LOCAL_LLM_KEY || 'lm-studio', model: isForced ? options.model : (lm || 'local-model'), system: options.system, messages: options.messages, maxTokens: options.maxTokens }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('local llm timeout')), parseInt(env.AVA_LOCAL_LLM_TIMEOUT_MS || '90000', 10)))
            ]);
            return { ...r, provider: 'local' };
          }
        }
      } catch (error) {
        if (_isQuotaError(error.message)) {
          _providerCooldown[provider] = Date.now() + _cooldownMs;
          logger.warn(`[llm] provider ${provider} quota/limit — cooling down ${Math.round(_cooldownMs / 1000)}s`, { error: error.message });
        }
        errors.push(`${provider}: ${error.message}`);
        logger.warn(`Provider ${provider} failed, trying next...`, { error: error.message });
        continue;
      }
    }

    throw new Error(`All LLM providers failed: ${errors.join('; ')}`);
  }

  async chatCompletion(sessionId, userMessage, options = {}) {
    try {
      // Get session history
      const session = this.getSession(sessionId);

      // Lead with AVA's personality so typed (UI) replies sound like HER — not a generic
      // assistant. Channel decides delivery: 'text' (default, on-screen → Markdown formatting
      // allowed) vs 'voice' (spoken → plain, TTS-safe). The capability/tool block follows.
      const channel = options.channel === 'voice' ? 'voice' : 'text';
      let personaBlock = '';
      try {
        personaBlock = channel === 'voice'
          ? personaSvc.buildPersonaBlock()
          : personaSvc.buildPersonaBlockText();
      } catch { personaBlock = ''; }

      // Add memory context if available
      let systemPrompt = personaBlock ? `${personaBlock}\n\n${getSystemPrompt()}` : getSystemPrompt();

      if (options.includeMemory) {
        const persona = memoryService.generatePersona();
        const memoryResults = await memoryService.search(userMessage, 3);

        // Enhanced recall: Search conversation logs for patterns
        let conversationContext = '';
        try {
          const isRecallQuery = /what.*file.*asking|what.*been.*asking|remember.*conversation|past.*conversation|file.*requested|what.*file.*want/i.test(userMessage);

          if (isRecallQuery) {
            // Tier 0 fix: was hardcoded to conversation-2025-09-24.jsonl (a debugging
            // leftover), which silently dead-ended this feature for every other day.
            const logsDir = path.join(process.cwd(), 'logs', 'conversations');
            const dayFile = (d) => path.join(logsDir, `conversation-${d.toISOString().slice(0, 10)}.jsonl`);
            let conversationLogPath = dayFile(new Date());
            if (!fs.existsSync(conversationLogPath)) {
              conversationLogPath = dayFile(new Date(Date.now() - 24 * 3600 * 1000));
            }

            if (fs.existsSync(conversationLogPath)) {
              const logContent = fs.readFileSync(conversationLogPath, 'utf8');
              const lines = logContent.split('\n').filter(line => line.trim());

              const fileRequests = lines
                .map(line => {
                  try { return JSON.parse(line); } catch { return null; }
                })
                .filter(entry => entry && entry.direction === 'user' &&
                  /open.*file|claude.*sessions|file.*claude|read.*file|show.*file/i.test(entry.content))
                .slice(-10);

              if (fileRequests.length > 0) {
                conversationContext = '\nRecent file requests:\n';
                fileRequests.forEach(req => {
                  conversationContext += `- User asked: "${req.content}"\n`;
                });

                const requestCounts = {};
                fileRequests.forEach(req => {
                  if (/claude.*sessions|open.*claude.*sessions/i.test(req.content)) {
                    requestCounts['claude sessions file'] = (requestCounts['claude sessions file'] || 0) + 1;
                  }
                });

                if (requestCounts['claude sessions file']) {
                  conversationContext += `\nMost frequently requested: "claude sessions file" (${requestCounts['claude sessions file']} times)\n`;
                }
              }
            }
          }
        } catch (logError) {
          logger.warn('Failed to analyze conversation logs', { error: logError.message });
        }

        if (persona.summary || memoryResults.length > 0 || conversationContext) {
          systemPrompt += '\n\nContext:\n';
          if (persona.summary) {
            systemPrompt += `User profile: ${persona.name}. ${persona.summary}\n`;
          }
          if (memoryResults.length > 0) {
            systemPrompt += 'Memory context:\n';
            memoryResults.forEach(item => {
              systemPrompt += `- ${item.text}\n`;
            });
          }
          if (conversationContext) {
            systemPrompt += conversationContext;
          }
        }
      }

      // Prepare messages
      // freshSession: don't include old history (for voice - each query is standalone)
      const historyMessages = options.freshSession ? [] : session.history.slice(-10);
      const messages = [
        ...historyMessages,
        { role: 'user', content: userMessage }
      ];

      // Get completion. Give the on-screen (text) channel real headroom so longer,
      // properly-formatted answers aren't truncated mid-thought; voice stays tighter.
      const defaultMax = channel === 'voice' ? 1200 : 3000;
      const maxTokens = options.maxTokens || options.max_tokens || parseInt(process.env.AVA_CHAT_MAX_TOKENS || '', 10) || defaultMax;
      const result = await this.createCompletion({
        messages,
        system: systemPrompt,
        maxTokens,
        ...options
      });

      // Update session history
      session.history.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: result.content }
      );

      // Store in memory if enabled
      if (options.storeInMemory) {
        await memoryService.upsert({
          role: 'user',
          text: userMessage,
          meta: { sessionId, timestamp: Date.now() }
        });
        
        await memoryService.upsert({
          role: 'assistant',
          text: result.content,
          meta: { sessionId, timestamp: Date.now() }
        });
      }

      return result;
    } catch (error) {
      logger.error('Chat completion failed', { sessionId, error: error.message });
      throw error;
    }
  }

  getSession(sessionId) {
    const id = String(sessionId || 'default');
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        history: [],
        createdAt: Date.now()
      });
    }
    return this.sessions.get(id);
  }

  clearSession(sessionId) {
    const id = String(sessionId || 'default');
    this.sessions.delete(id);
  }

  getSessionStats() {
    return {
      activeSessions: this.sessions.size,
      provider: this.provider,
      sessions: Array.from(this.sessions.values()).map(session => ({
        id: session.id,
        messageCount: session.history.length,
        createdAt: session.createdAt
      }))
    };
  }

  getAvailableProviders() {
    const providers = [];
    if (config.OPENAI_API_KEY) providers.push('openai');
    if (config.GOOGLE_API_KEY || config.GEMINI_API_KEY) providers.push('gemini');
    if (config.ANTHROPIC_API_KEY || config.CLAUDE_API_KEY) providers.push('claude');
    if (config.GROQ_API_KEY) providers.push('groq');
    return providers;
  }
}

export default new LLMService();
