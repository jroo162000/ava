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

// Load AVA identity if available
function loadIdentity() {
  try {
    const identityPath = path.join(os.homedir(), 'ava-integration', 'ava_identity.json');
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

const SYSTEM_PROMPT = buildSystemPrompt();

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
      default: return null;
    }
  }

  // Simple chat method for agent loop
  async chat(messages, options = {}) {
    const result = await this.createCompletion({
      messages,
      system: messages.find(m => m.role === 'system')?.content,
      temperature: options.temperature || 0.7,
      maxTokens: options.max_tokens || 1000
    });
    return {
      text: result.content,
      content: result.content,
      usage: result.usage,
      provider: result.provider
    };
  }

  async createCompletionOpenAI({ messages, system, temperature = 0.7, maxTokens = 1000 }) {
    const apiKey = this.getApiKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const systemMessage = system || SYSTEM_PROMPT;
    const fullMessages = [
      { role: 'system', content: systemMessage },
      ...messages
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: fullMessages,
        temperature,
        max_tokens: maxTokens
      })
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

  async createCompletionGemini({ messages, system, temperature = 0.7, maxTokens = 1000 }) {
    const apiKey = this.getApiKey('gemini');
    if (!apiKey) throw new Error('Gemini API key not configured');

    const systemMessage = system || SYSTEM_PROMPT;
    
    // Convert messages to Gemini format
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
      model: 'gemini-2.0-flash',
      provider: 'gemini'
    };
  }

  async createCompletionClaude({ messages, system, temperature = 0.7, maxTokens = 1000 }) {
    const apiKey = this.getApiKey('claude');
    if (!apiKey) throw new Error('Claude API key not configured');

    const systemMessage = system || SYSTEM_PROMPT;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: maxTokens,
        system: systemMessage,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      })
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

    const systemMessage = system || SYSTEM_PROMPT;
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

  async createCompletion(options) {
    // Try providers in order until one works
    const providers = ['openai', 'gemini', 'claude', 'groq'];
    const errors = [];

    // Start with detected provider
    if (this.provider) {
      const idx = providers.indexOf(this.provider);
      if (idx > 0) {
        providers.splice(idx, 1);
        providers.unshift(this.provider);
      }
    }

    for (const provider of providers) {
      if (!this.getApiKey(provider)) continue;

      try {
        switch (provider) {
          case 'openai':
            return await this.createCompletionOpenAI(options);
          case 'gemini':
            return await this.createCompletionGemini(options);
          case 'claude':
            return await this.createCompletionClaude(options);
          case 'groq':
            return await this.createCompletionGroq(options);
        }
      } catch (error) {
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
      
      // Add memory context if available
      let systemPrompt = SYSTEM_PROMPT;
      
      if (options.includeMemory) {
        const persona = memoryService.generatePersona();
        const memoryResults = await memoryService.search(userMessage, 3);

        // Enhanced recall: Search conversation logs for patterns
        let conversationContext = '';
        try {
          const isRecallQuery = /what.*file.*asking|what.*been.*asking|remember.*conversation|past.*conversation|file.*requested|what.*file.*want/i.test(userMessage);

          if (isRecallQuery) {
            const conversationLogPath = path.join(process.cwd(), 'logs', 'conversations', 'conversation-2025-09-24.jsonl');

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

      // Get completion
      const result = await this.createCompletion({
        messages,
        system: systemPrompt,
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
