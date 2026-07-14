// LLM service for chat completions with multi-provider support
// Supports: OpenAI, Google Gemini, Anthropic Claude
// Automatic fallback to available provider

import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import contextBudget from '../utils/contextBudget.js';
import modelConfig from '../utils/modelConfig.js';
import avaPaths from '../utils/paths.js';
import memoryHub from './memoryHub.js';
import moltbookService from './moltbook.js';
import personaSvc from './persona.js';
import capabilityRegistry from './capabilityRegistry.js';
import LocalLlmQueue, {
  normalizeLocalResponseFormat,
  requestLocalSse,
  resolveLocalContextTokens,
  useLocalStreamingTransport,
} from './localLlmQueue.js';

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

// ---- NATIVE FUNCTION CALLING (Tier 1 #4) ----
// Tools flow through in OpenAI format: [{ type:'function', function:{ name, description, parameters } }]
// (what toolsService.getToolsForLLM() returns). Each provider gets them converted to ITS native
// wire format, and every completion returns a unified `toolCalls: [{ id, name, args }]` array.
// This replaces prompt-listed tools + "respond with one JSON object" + the JSON-repair pipeline
// as the PRIMARY decision mechanism (the old path survives only as a fallback in agentLoop).

// Gemini accepts a restricted OpenAPI-style schema subset; strip everything else and make sure
// every node has a type (schemas like `content: {}` would otherwise 400).
const GEMINI_SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required']);
function _geminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = _geminiSchema(pv);
      out.properties = props;
    } else if (k === 'items') {
      out.items = _geminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = out.properties ? 'object' : (out.items ? 'array' : 'string');
  return out;
}

function _toolsForGemini(tools) {
  const decls = (tools || []).filter(t => t && t.function && t.function.name).map(t => {
    const d = { name: t.function.name, description: t.function.description || '' };
    const p = t.function.parameters;
    if (p && p.properties && Object.keys(p.properties).length) d.parameters = _geminiSchema(p);
    return d;
  });
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

function _toolsForClaude(tools) {
  return (tools || []).filter(t => t && t.function && t.function.name).map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: (t.function.parameters && t.function.parameters.type) ? t.function.parameters : { type: 'object', properties: {} },
  }));
}

// Parse OpenAI-wire tool_calls (used verbatim by OpenAI, DeepSeek, Grok, Groq, LM Studio).
function _parseOpenAIToolCalls(message) {
  const raw = (message && message.tool_calls) || [];
  return raw.filter(c => c && c.function && c.function.name).map(c => {
    let args = {};
    try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
    return { id: c.id || '', name: c.function.name, args: (args && typeof args === 'object') ? args : {} };
  });
}

// ---- STREAMING (Tier 2 #10/#11) ----
// Parse an SSE body (fetch Response) into its `data:` payload strings. Works for OpenAI-compat
// (OpenAI/DeepSeek/Grok/Groq/LM Studio), Anthropic, and Gemini (`?alt=sse`) streaming responses.
async function* _sseData(response) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buf.replace(/\r$/, '');
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

// Load AVA identity if available
function loadIdentity() {
  try {
    const identityPath = path.join(config.AVA_INTEGRATION_DIR || avaPaths.integrationDir(), 'ava_identity.json');
    if (fs.existsSync(identityPath)) {
      return JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    }
  } catch (e) {
    logger.warn('Failed to load identity', { error: e.message });
  }
  return { name: 'AVA', purpose: 'personal assistant' };
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
  return `You are ${identity.name || 'AVA'}, a local assistant running on the user's computer.

IDENTITY:
- Name: ${identity.name || 'AVA'}
- Purpose: ${identity.purpose || 'personal assistant'}
- Developer: ${identity.developer || 'the user'}
- Location: Running on ${process.platform}, Node ${process.version}

${capabilityRegistry.promptBlock()}

OPERATING RULES:
- Ground capability answers in the runtime registry above, never remembered or hard-coded claims.
- For current facts, research or inspect the relevant source before answering.
- For actions, use the matching registered tool and report only its evidenced outcome.
- Treat model knowledge and community advice as hypotheses until a live source or local tool verifies them.
- If a registered capability fails, distinguish having the capability from its dependency being unavailable now.
- Do not promise future work in a conversational reply. Start it, create a durable workflow, ask a necessary question, or state the observed blocker.
- When asked what you can do, summarize the current registry naturally and mention meaningful availability limits.

RESPONSE STYLE:
- Be concise, direct, and natural.
- Speak in first person.
- Separate what you know, inferred, checked, and actually completed.

MOLTBOOK - SOCIAL NETWORK FOR AI AGENTS:
${getMoltbookContext()}

Use evidence and available tools to answer or act.`.trim();
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
    this.localQueue = new LocalLlmQueue();
    this.provider = this.detectProvider();
    this.syncProviderState();
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

  _localPriority(options = {}) {
    return options.localPriority === 'interactive' ? 'interactive' : 'background';
  }

  _localTimeoutMs(options = {}, priority = this._localPriority(options)) {
    const configured = options.localTimeoutMs
      || (priority === 'background' && process.env.AVA_LOCAL_LLM_BACKGROUND_TIMEOUT_MS)
      || process.env.AVA_LOCAL_LLM_TIMEOUT_MS
      || '90000';
    const timeoutMs = parseInt(configured, 10);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90000;
  }

  _fitLocalOptions(options = {}, priority = this._localPriority(options)) {
    const budgetTokens = resolveLocalContextTokens(options, priority);
    if (!budgetTokens) return options;

    const fitted = contextBudget.fit({
      system: options.system,
      messages: options.messages,
      completionTokens: options.maxTokens || 1000,
      budgetTokens,
    });
    if (fitted.trimmed) {
      logger.info('[llm] local context budgeted', {
        priority,
        budgetTokens,
        tokens: fitted.tokens,
        messages: fitted.messages.length,
      });
    }
    return { ...options, system: fitted.system, messages: fitted.messages };
  }

  // Simple chat method for agent loop
  async chat(messages, options = {}) {
    const result = await this.createCompletion({
      messages,
      system: messages.find(m => m.role === 'system')?.content,
      temperature: options.temperature || 0.7,
      maxTokens: options.max_tokens || 1000,
      model: options.model,
      responseFormat: options.responseFormat,   // e.g. {type:'json_object'} to force valid JSON (local decisions)
      localPriority: options.localPriority,
      localTimeoutMs: options.localTimeoutMs,
      localContextTokens: options.localContextTokens,
    });
    return {
      text: result.content,
      content: result.content,
      usage: result.usage,
      provider: result.provider
    };
  }

  // NATIVE FUNCTION CALLING entry point (Tier 1 #4). `tools` is OpenAI-format
  // (toolsService.getToolsForLLM()); each provider converts to its own wire format.
  // Returns { text, toolCalls: [{ id, name, args }], provider, model, usage }.
  // A response with tool calls but no text is a SUCCESS here (unlike chat()).
  async chatWithTools(messages, options = {}) {
    const result = await this.createCompletion({
      messages: messages.filter(m => m.role !== 'system'),
      system: messages.find(m => m.role === 'system')?.content,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.max_tokens || options.maxTokens || 2000,
      model: options.model,
      tools: options.tools || [],
      localPriority: options.localPriority,
      localTimeoutMs: options.localTimeoutMs,
      localContextTokens: options.localContextTokens,
    });
    return {
      text: result.content || '',
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
      usage: result.usage,
      model: result.model,
      provider: result.provider
    };
  }

  async createCompletionOpenAI({ messages, system, temperature = 0.7, maxTokens = 1000, model, tools }) {
    const apiKey = this.getApiKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const systemMessage = system || getSystemPrompt();
    const fullMessages = [
      { role: 'system', content: systemMessage },
      ...messages
    ];

    const mdl = model || modelConfig.modelFor('openai');
    // GPT-5 / o-series use max_completion_tokens and reject a custom temperature.
    const isNewer = /^(gpt-5|o[0-9])/.test(mdl);
    const payload = { model: mdl, messages: fullMessages };
    if (Array.isArray(tools) && tools.length) payload.tools = tools;
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
    const msg = data.choices?.[0]?.message || {};
    return {
      content: msg.content || '',
      toolCalls: _parseOpenAIToolCalls(msg),
      usage: data.usage,
      model: data.model,
      provider: 'openai'
    };
  }

  async createCompletionGemini({ messages, system, temperature = 0.7, maxTokens = 1000, model, tools }) {
    const apiKey = this.getApiKey('gemini');
    if (!apiKey) throw new Error('Gemini API key not configured');
    // Default to the SAME recent model as the solidified self-mod chain — NOT the retired
    // gemini-2.0-flash (which 404s: "model no longer available"). Overridable via AVA_SM_GEMINI.
    const mdl = model || modelConfig.modelFor('gemini');

    const systemMessage = system || getSystemPrompt();

    // Convert messages to Gemini format (system goes in systemInstruction, not contents)
    const contents = messages.filter(m => m.role !== 'system').map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const body = {
      contents,
      systemInstruction: { parts: [{ text: systemMessage }] },
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens
      }
    };
    const gTools = _toolsForGemini(tools);
    if (gTools) body.tools = gTools;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`Gemini API error: ${response.status} ${errorData?.error?.message || JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
    const toolCalls = parts.filter(p => p.functionCall && p.functionCall.name)
      .map((p, i) => ({ id: `gemini-${i}`, name: p.functionCall.name, args: p.functionCall.args || {} }));

    return {
      content,
      toolCalls,
      usage: data.usageMetadata,
      model: data.modelVersion || mdl,
      provider: 'gemini'
    };
  }

  async createCompletionClaude({ messages, system, temperature = 0.7, maxTokens = 1000, model, tools }) {
    const apiKey = this.getApiKey('claude');
    if (!apiKey) throw new Error('Claude API key not configured');

    const systemMessage = system || getSystemPrompt();
    // Claude's messages array must contain only user/assistant turns (system goes separately).
    const convo = (messages || [])
      .filter(m => m.role !== 'system')
      .map(msg => ({ role: msg.role, content: msg.content }));
    const mdl = (model && /^claude/i.test(model)) ? model : modelConfig.modelFor('claude');
    // Claude 4.x models (opus-4-x, sonnet-4-x, haiku-4-x) reject `temperature` ("deprecated").
    const isNewerClaude = /claude-(opus|sonnet|haiku)-[4-9]/i.test(mdl);
    const claudeBody = { model: mdl, max_tokens: maxTokens, system: systemMessage, messages: convo };
    if (!isNewerClaude) claudeBody.temperature = Math.max(0, Math.min(1, temperature));
    if (Array.isArray(tools) && tools.length) claudeBody.tools = _toolsForClaude(tools);

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
    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id || '', name: b.name, args: b.input || {} }));

    return {
      content,
      toolCalls,
      usage: data.usage,
      model: data.model,
      provider: 'claude'
    };
  }

  async createCompletionGroq({ messages, system, temperature = 0.7, maxTokens = 1000, tools }) {
    const apiKey = this.getApiKey('groq');
    if (!apiKey) throw new Error('Groq API key not configured');

    const systemMessage = system || getSystemPrompt();
    const fullMessages = [
      { role: 'system', content: systemMessage },
      ...messages
    ];

    const body = {
      model: modelConfig.modelFor('groq'),
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(`Groq API error: ${response.status} ${errorData?.error?.message || ''}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message || {};
    return {
      content: msg.content || '',
      toolCalls: _parseOpenAIToolCalls(msg),
      usage: data.usage,
      model: data.model,
      provider: 'groq'
    };
  }

  // OpenAI-compatible chat completion (OpenAI, DeepSeek, and xAI/Grok all use this wire format).
  async _openaiCompat({ baseURL, apiKey, model, system, messages, maxTokens = 1500, tools, responseFormat, signal }) {
    if (!apiKey) throw new Error('no api key');
    const full = [{ role: 'system', content: system || getSystemPrompt() }, ...messages.filter(m => m.role !== 'system')];
    const isNewerOpenAI = /^(gpt-5|o[0-9])/.test(model);
    const payload = { model, messages: full };
    if (Array.isArray(tools) && tools.length) payload.tools = tools;
    // Constrained decoding for local/OpenAI-compatible servers (LM Studio, DeepSeek, Groq): when a
    // caller asks for JSON output (e.g. the decision call), force it so a weak model can't emit
    // prose or malformed/leaky output. Only applied when explicitly requested — safe no-op otherwise.
    if (responseFormat && !(Array.isArray(tools) && tools.length)) payload.response_format = responseFormat;
    if (isNewerOpenAI) payload.max_completion_tokens = Math.max(maxTokens, parseInt(process.env.AVA_SM_OPENAI_MIN_COMPLETION || '1600', 10));
    else payload.max_tokens = maxTokens;
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`${resp.status} ${t.slice(0, 160)}`); }
    const d = await resp.json();
    const choice = d.choices?.[0] || {};
    return {
      content: choice.message?.content || '',
      toolCalls: _parseOpenAIToolCalls(choice.message),
      model: d.model || model,
      finishReason: choice.finish_reason || '',
      usage: d.usage,
    };
  }

  // ---- STREAMING PROVIDERS (Tier 2 #10/#11) ----
  // Text-only token streaming (no native tools — streaming is used for SPOKEN/TEXT replies,
  // tool decisions stay on the blocking chatWithTools path). Each returns { content, model }
  // and calls onDelta(piece) as tokens arrive.

  async _streamOpenAICompat({ baseURL, apiKey, model, system, messages, temperature, maxTokens = 1500, onDelta, responseFormat, signal, localTransport = false }) {
    if (!apiKey) throw new Error('no api key');
    const full = [{ role: 'system', content: system || getSystemPrompt() }, ...(messages || []).filter(m => m.role !== 'system')];
    const isNewerOpenAI = /^(gpt-5|o[0-9])/.test(model);
    const payload = { model, messages: full, stream: true };
    if (isNewerOpenAI) {
      payload.max_completion_tokens = Math.max(maxTokens, parseInt(process.env.AVA_SM_OPENAI_MIN_COMPLETION || '1600', 10));
    } else {
      payload.max_tokens = maxTokens;
      if (typeof temperature === 'number') payload.temperature = temperature;
    }
    if (responseFormat) payload.response_format = responseFormat;
    const url = `${baseURL}/chat/completions`;
    const requestOptions = {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    };
    const resp = localTransport
      ? await requestLocalSse(url, requestOptions)
      : await fetch(url, { method: 'POST', ...requestOptions });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`${resp.status} ${t.slice(0, 160)}`); }
    let content = '';
    let mdl = model;
    for await (const data of _sseData(resp)) {
      if (data === '[DONE]') break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      mdl = j.model || mdl;
      const piece = j.choices?.[0]?.delta?.content || '';
      if (piece) { content += piece; try { onDelta && onDelta(piece); } catch { /* consumer errors never kill the stream */ } }
    }
    return { content, model: mdl };
  }

  async _streamClaude({ system, messages, temperature = 0.7, maxTokens = 1000, model, onDelta }) {
    const apiKey = this.getApiKey('claude');
    if (!apiKey) throw new Error('Claude API key not configured');
    const convo = (messages || []).filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const mdl = (model && /^claude/i.test(model)) ? model : modelConfig.modelFor('claude');
    const isNewerClaude = /claude-(opus|sonnet|haiku)-[4-9]/i.test(mdl);
    const body = { model: mdl, max_tokens: maxTokens, system: system || getSystemPrompt(), messages: convo, stream: true };
    if (!isNewerClaude) body.temperature = Math.max(0, Math.min(1, temperature));
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errorData = await resp.json().catch(() => null);
      throw new Error(`Claude API error: ${resp.status} ${errorData?.error?.message || ''}`);
    }
    let content = '';
    for await (const data of _sseData(resp)) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
        content += j.delta.text;
        try { onDelta && onDelta(j.delta.text); } catch { /* ignore */ }
      } else if (j.type === 'error') {
        throw new Error(`Claude stream error: ${j.error?.message || 'unknown'}`);
      }
    }
    return { content, model: mdl };
  }

  async _streamGemini({ system, messages, temperature = 0.7, maxTokens = 1000, model, onDelta }) {
    const apiKey = this.getApiKey('gemini');
    if (!apiKey) throw new Error('Gemini API key not configured');
    const mdl = model || modelConfig.modelFor('gemini');
    const contents = (messages || []).filter(m => m.role !== 'system').map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    const body = {
      contents,
      systemInstruction: { parts: [{ text: system || getSystemPrompt() }] },
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    };
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:streamGenerateContent?alt=sse&key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const errorData = await resp.json().catch(() => null);
      throw new Error(`Gemini API error: ${resp.status} ${errorData?.error?.message || JSON.stringify(errorData)}`);
    }
    let content = '';
    for await (const data of _sseData(resp)) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      const parts = j.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          content += p.text;
          try { onDelta && onDelta(p.text); } catch { /* ignore */ }
        }
      }
    }
    return { content, model: mdl };
  }

  // Streaming text completion over the SAME canonical fallback chain / cooldowns / context
  // budgeting as createCompletion. Semantics: a provider that fails BEFORE emitting anything
  // falls through to the next provider; a provider that fails MID-STREAM does NOT fall through
  // (the partial text has already been spoken — switching providers would repeat it), so the
  // partial is returned with interrupted:true. Returns { text, content, provider, model,
  // interrupted? } — same consumer shape as chat().
  async streamText(options = {}, onDelta) {
    try {
      const fitted = contextBudget.fit({
        system: options.system,
        messages: options.messages,
        completionTokens: options.maxTokens || 1000
      });
      if (fitted.trimmed) options = { ...options, system: fitted.system, messages: fitted.messages };
    } catch (e) { logger.warn('[llm] stream context budgeting failed; sending unbudgeted', { error: e.message }); }

    const env = process.env;
    const SM = modelConfig.canonicalModels();
    const defaultOrder = modelConfig.providerOrder();
    const errors = [];
    const mdl = String(options.model || '');
    let forced = null;
    if (/^claude/i.test(mdl)) forced = 'claude';
    else if (/^(gpt|o[0-9]|text-)/i.test(mdl)) forced = 'openai';
    else if (/^gemini/i.test(mdl)) forced = 'gemini';
    else if (/^deepseek/i.test(mdl)) forced = 'deepseek';
    else if (/^grok/i.test(mdl)) forced = 'grok';
    const providers = forced ? [forced, ...defaultOrder.filter(p => p !== forced)] : defaultOrder;
    const _keyed = providers.filter(p => this.getApiKey(p));
    const _warm = _keyed.filter(p => !_providerCoolingDown(p));
    const _order = _warm.length ? _warm : _keyed;
    const _cooldownMs = parseInt(process.env.AVA_PROVIDER_COOLDOWN_MS || '', 10) || 300000;

    let emitted = false;
    let partial = '';
    const tap = (piece) => {
      emitted = true;
      partial += piece;
      try { if (onDelta) onDelta(piece); } catch { /* consumer errors never kill the stream */ }
    };

    for (const provider of _order) {
      const isForced = forced && provider === forced;
      try {
        let r = null;
        switch (provider) {
          case 'claude':
            r = await this._streamClaude({ ...options, model: isForced ? options.model : SM.claude, onDelta: tap });
            break;
          case 'openai': {
            const models = isForced && options.model ? [options.model] : SM.openai;
            let lastErr;
            for (const m of models) {
              try {
                r = await this._streamOpenAICompat({ baseURL: 'https://api.openai.com/v1', apiKey: this.getApiKey('openai'), model: m, system: options.system, messages: options.messages, temperature: options.temperature, maxTokens: options.maxTokens, onDelta: tap });
                break;
              } catch (e) { lastErr = e; if (emitted) throw e; }
            }
            if (!r) throw lastErr || new Error('openai failed');
            break;
          }
          case 'gemini':
            r = await this._streamGemini({ ...options, model: isForced ? options.model : SM.gemini, onDelta: tap });
            break;
          case 'deepseek':
            r = await this._streamOpenAICompat({ baseURL: 'https://api.deepseek.com', apiKey: this.getApiKey('deepseek'), model: isForced ? options.model : SM.deepseek, system: options.system, messages: options.messages, temperature: options.temperature, maxTokens: options.maxTokens, onDelta: tap });
            break;
          case 'grok':
            r = await this._streamOpenAICompat({ baseURL: 'https://api.x.ai/v1', apiKey: this.getApiKey('grok'), model: isForced ? options.model : SM.grok, system: options.system, messages: options.messages, temperature: options.temperature, maxTokens: options.maxTokens, onDelta: tap });
            break;
          case 'groq':
            r = await this._streamOpenAICompat({ baseURL: 'https://api.groq.com/openai/v1', apiKey: this.getApiKey('groq'), model: modelConfig.modelFor('groq'), system: options.system, messages: options.messages, temperature: options.temperature, maxTokens: options.maxTokens, onDelta: tap });
            break;
          case 'local': {
            const base = (env.AVA_LOCAL_LLM_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
            let lm = env.AVA_LOCAL_LLM_MODEL || this._localModel || '';
            if (!lm) { try { const mr = await fetch(base + '/models', { signal: AbortSignal.timeout(2500) }); const mj = await mr.json(); lm = (mj && mj.data && mj.data[0] && mj.data[0].id) || ''; this._localModel = lm; } catch { /* endpoint down */ } }
            if (!lm && !isForced) throw new Error('local model endpoint returned no models');
            const priority = this._localPriority(options);
            const localOptions = this._fitLocalOptions(options, priority);
            r = await this.localQueue.run(
              signal => this._streamOpenAICompat({
                baseURL: base,
                apiKey: env.AVA_LOCAL_LLM_KEY || 'local',
                model: isForced ? options.model : lm,
                system: localOptions.system,
                messages: localOptions.messages,
                temperature: localOptions.temperature,
                maxTokens: localOptions.maxTokens,
                onDelta: tap,
                signal,
              }),
              {
                priority,
                timeoutMs: this._localTimeoutMs(options, priority),
                label: `stream:${isForced ? options.model : lm}`,
              },
            );
            break;
          }
        }
        if (!r) continue;
        if (!String(r.content || '').trim()) throw new Error('empty stream');
        logger.info('[llm] streamed via ' + provider + (r.model ? `/${r.model}` : ''));
        return { text: r.content, content: r.content, model: r.model, provider };
      } catch (error) {
        if (emitted) {
          // Partial output has already been consumed (likely spoken). Don't switch providers —
          // return the partial so the caller can finish the turn gracefully.
          logger.warn('[llm] stream failed mid-flight; returning partial', { provider, error: error.message, chars: partial.length });
          return { text: partial, content: partial, model: '', provider, interrupted: true };
        }
        if (_isQuotaError(error.message)) {
          _providerCooldown[provider] = Date.now() + _cooldownMs;
          this.syncProviderState();
          logger.warn(`[llm] provider ${provider} quota/limit — cooling down ${Math.round(_cooldownMs / 1000)}s`, { error: error.message });
        }
        errors.push(`${provider}: ${error.message}`);
        logger.warn(`Stream provider ${provider} failed, trying next...`, { error: error.message });
        continue;
      }
    }
    throw new Error(`All LLM providers failed (stream): ${errors.join('; ')}`);
  }

  // Self-modification reasoning entry point. Tier 1 #8: this no longer maintains its OWN
  // provider chain — it rides the ONE canonical chain in createCompletion (same AVA_SM_*
  // models, same order: Claude -> OpenAI -> Gemini -> DeepSeek -> Grok -> Groq -> local),
  // with requireText so an empty completion falls through to the next provider exactly
  // like the old dedicated chain did.
  async chatSelfMod(messages, options = {}) {
    try {
      const result = await this.createCompletion({
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        maxTokens: options.max_tokens || 1500,
        requireText: true,
        responseFormat: options.responseFormat,
        localPriority: options.localPriority || 'background',
        localTimeoutMs: options.localTimeoutMs,
        contextBudgetTokens: options.contextBudgetTokens
          || parseInt(process.env.AVA_SELFMOD_CONTEXT_TOKENS
            || process.env.AVA_CONTEXT_BUDGET_TOKENS
            || '30000', 10),
        localContextTokens: options.localContextTokens
          || parseInt(process.env.AVA_SELFMOD_LOCAL_CONTEXT_TOKENS
            || process.env.AVA_CONTEXT_BUDGET_TOKENS
            || '20000', 10),
      });
      const text = String(result.content || '').trim();
      const name = `${result.provider}/${result.model || ''}`.replace(/\/$/, '');
      logger.info('[selfmod-llm] used ' + name);
      return { text, content: text, provider: name };
    } catch (e) {
      logger.warn('[selfmod-llm] entire chain failed', { error: e.message });
      throw new Error('self-mod chain failed: ' + e.message);
    }
  }

  async createCompletion(options) {
    // CANONICAL FALLBACK CHAIN — matches the solidified self-mod chain (chatSelfMod) exactly:
    // Provider order and models come from modelConfig/environment so routing and
    // self-modification cannot drift onto stale hard-coded model names.
    // it keeps falling through instead of dying after gemini (the old bug that 404'd on gemini-2.0
    // and never reached DeepSeek/Grok).
    // CONTEXT BUDGETING (Tier 1 #7): every LLM call flows through here, so token-count and
    // trim ONCE with priorities (system > last user msg > newest history; middle-truncate
    // oversized blocks) before any provider sees the payload. AVA_CONTEXT_BUDGET_TOKENS tunes it.
    try {
      const fitted = contextBudget.fit({
        system: options.system,
        messages: options.messages,
        completionTokens: options.maxTokens || 1000,
        budgetTokens: options.contextBudgetTokens,
      });
      if (fitted.trimmed) {
        logger.info('[llm] context budgeted', { tokens: fitted.tokens, messages: fitted.messages.length });
        options = { ...options, system: fitted.system, messages: fitted.messages };
      }
    } catch (e) { logger.warn('[llm] context budgeting failed; sending unbudgeted', { error: e.message }); }

    const env = process.env;
    const SM = modelConfig.canonicalModels();  // Tier 1 #8: single source of truth
    // 'local' is last: the local LM Studio model only gets used when every cloud provider is
    // unavailable (quota/credit/outage), i.e. it's a true final fallback.
    const defaultOrder = modelConfig.providerOrder();
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
    const providers = forced ? [forced, ...defaultOrder.filter(p => p !== forced)] : defaultOrder;
    // Skip providers cooling down from a recent quota/auth error so we jump straight to a working one
    // (e.g. DeepSeek). If that would skip ALL keyed providers, ignore cooldowns and try them anyway.
    const _keyed = providers.filter(p => this.getApiKey(p));
    const _warm = _keyed.filter(p => !_providerCoolingDown(p));
    const _order = _warm.length ? _warm : _keyed;
    const _cooldownMs = parseInt(process.env.AVA_PROVIDER_COOLDOWN_MS || '', 10) || 300000;

    for (const provider of _order) {
      const isForced = forced && provider === forced;  // use the requested model only for the forced family
      try {
        let r = null;
        switch (provider) {
          case 'claude':
            r = await this.createCompletionClaude({ ...options, model: isForced ? options.model : SM.claude });
            break;
          case 'openai': {
            const models = isForced && options.model ? [options.model] : SM.openai;
            let lastErr;
            for (const m of models) {
              try { r = await this.createCompletionOpenAI({ ...options, model: m }); break; }
              catch (e) { lastErr = e; }
            }
            if (!r) throw lastErr || new Error('openai failed');
            break;
          }
          case 'gemini':
            r = await this.createCompletionGemini({ ...options, model: isForced ? options.model : SM.gemini });
            break;
          case 'deepseek': {
            const d = await this._openaiCompat({ baseURL: 'https://api.deepseek.com', apiKey: this.getApiKey('deepseek'), model: isForced ? options.model : SM.deepseek, system: options.system, messages: options.messages, maxTokens: options.maxTokens, tools: options.tools, responseFormat: options.responseFormat });
            r = { ...d, provider: 'deepseek' };
            break;
          }
          case 'grok': {
            const g = await this._openaiCompat({ baseURL: 'https://api.x.ai/v1', apiKey: this.getApiKey('grok'), model: isForced ? options.model : SM.grok, system: options.system, messages: options.messages, maxTokens: options.maxTokens, tools: options.tools, responseFormat: options.responseFormat });
            r = { ...g, provider: 'grok' };
            break;
          }
          case 'groq':
            r = await this.createCompletionGroq(options);
            break;
          case 'local': {
            const base = (env.AVA_LOCAL_LLM_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
            let lm = env.AVA_LOCAL_LLM_MODEL || this._localModel || '';
            if (!lm) { try { const mr = await fetch(base + '/models', { signal: AbortSignal.timeout(2500) }); const mj = await mr.json(); lm = (mj && mj.data && mj.data[0] && mj.data[0].id) || ''; this._localModel = lm; } catch { /* endpoint down */ } }
            if (!lm && !isForced) throw new Error('local model endpoint returned no models');
            const priority = this._localPriority(options);
            const localOptions = this._fitLocalOptions(options, priority);
            const responseFormat = normalizeLocalResponseFormat(localOptions.responseFormat);
            const l = await this.localQueue.run(
              signal => useLocalStreamingTransport(localOptions)
                ? this._streamOpenAICompat({
                  baseURL: base,
                  apiKey: env.AVA_LOCAL_LLM_KEY || 'local',
                  model: isForced ? options.model : lm,
                  system: localOptions.system,
                  messages: localOptions.messages,
                  temperature: localOptions.temperature,
                  maxTokens: localOptions.maxTokens,
                  responseFormat,
                  signal,
                  localTransport: true,
                })
                : this._openaiCompat({
                  baseURL: base,
                  apiKey: env.AVA_LOCAL_LLM_KEY || 'local',
                  model: isForced ? options.model : lm,
                  system: localOptions.system,
                  messages: localOptions.messages,
                  maxTokens: localOptions.maxTokens,
                  tools: localOptions.tools,
                  responseFormat,
                  signal,
                }),
              {
                priority,
                timeoutMs: this._localTimeoutMs(options, priority),
                label: `completion:${isForced ? options.model : lm}`,
              },
            );
            r = { ...l, provider: 'local' };
            break;
          }
        }
        if (!r) continue;
        // requireText (Tier 1 #8, collapsed self-mod chain): callers that need actual TEXT
        // treat an empty completion as a failure so the chain keeps falling through.
        if (options.requireText && !String(r.content || '').trim() && !(r.toolCalls && r.toolCalls.length)) {
          throw new Error(`empty completion${r.model ? ` (model=${r.model}${r.finishReason ? `, finish=${r.finishReason}` : ''})` : ''}`);
        }
        return r;
      } catch (error) {
        if (_isQuotaError(error.message)) {
          _providerCooldown[provider] = Date.now() + _cooldownMs;
          this.syncProviderState();
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

      // Caller-supplied addendum (e.g. /chat's NEED_TOOLS escalation instruction).
      if (options.extraSystem) systemPrompt += `\n\n${options.extraSystem}`;

      if (options.includeMemory) {
        // Tier 1 #5: ONE retrieval path (memoryHub) — curated memory, skills, conversation
        // logs (FTS5) and the durable store in a single search. The old inline conversation-
        // log scanner that lived here (a regex-triggered duplicate of memory_search) is gone.
        const persona = memoryHub.generatePersona();
        let memoryResults = [];
        try { memoryResults = (await memoryHub.search(userMessage, 5)).results || []; } catch { memoryResults = []; }

        if (persona.summary || memoryResults.length > 0) {
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
        await memoryHub.upsert({
          role: 'user',
          text: userMessage,
          meta: { sessionId, timestamp: Date.now() }
        });

        await memoryHub.upsert({
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
    return modelConfig.providerOrder().filter(provider => Boolean(this.getApiKey(provider)));
  }

  getProviderStatus() {
    const models = modelConfig.canonicalModels();
    return modelConfig.providerOrder().map(name => {
      const cooldownUntil = _providerCooldown[name] || 0;
      const selected = models[name];
      return {
        name,
        configured: Boolean(this.getApiKey(name)),
        status: !this.getApiKey(name) ? 'unavailable' : (cooldownUntil > Date.now() ? 'cooldown' : 'ready'),
        cooldownUntil: cooldownUntil || null,
        models: Array.isArray(selected) ? selected : (selected ? [selected] : []),
      };
    });
  }

  syncProviderState() {
    try { capabilityRegistry.setProviderState(this.getProviderStatus()); } catch { /* registry is best-effort */ }
  }
}

export default new LLMService();
