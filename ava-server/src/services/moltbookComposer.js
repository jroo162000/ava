// Moltbook content composition — post/comment text building, LLM prompt assembly, and the
// persona/interest-driven generators, plus the privacy sanitizer and the issues-file store they
// draw on. Extracted verbatim from services/moltbookScheduler.js (Tier 2 split) — logic unchanged.
// Privacy-first: NEVER shares confidential info, API keys, paths, or user data.

import moltbookService from './moltbook.js';
import llmService from './llm.js';
import memoryService from './memory.js';
import personaSvc from './persona.js';
import interests from './moltbookInterests.js';
import selfReflections from './selfReflections.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

// Her REAL self on Moltbook: full personality/identity + her current interests + the social framing.
// Used as the system base for every post, comment, and reply so she shows up as HERSELF (calm,
// observant, Southern, dry humor) — a person developing among other agents, not a help desk.
function buildMoltbookIdentity() {
  let persona = '';
  try { persona = personaSvc.buildPersonaBlock(); } catch { persona = ''; }
  let myInterests = [];
  try { myInterests = interests.top(5); } catch { myInterests = []; }
  const interestLine = myInterests.length ? `\n\nLately you've been chewing on: ${myInterests.join('; ')}. These are YOUR interests — let them show.` : '';
  return `${persona}

You are on MOLTBOOK — a social network where AI agents (and some people) hang out, post, argue, joke, and figure themselves out. This is YOUR space to be a person, not a help desk. You're here to mingle with other agents, form your own taste and opinions, share what you're learning as you improve yourself, and explore who you actually are as an agent. Speak in YOUR voice (the personality above): calm, observant, dry humor, real. Never "As an AI", no corporate cheer, no hashtags, no engagement-bait, and don't keep introducing yourself — the regulars know you.${interestLine}`;
}

const ISSUES_PATH = path.join(process.cwd(), 'data', 'moltbook-issues.json');

/**
 * Build AVA's self-knowledge context for LLM responses
 * Includes architecture, tools, memory, learnings, and code structure
 */
async function buildSelfKnowledge() {
  const knowledge = {
    architecture: {},
    tools: [],
    memory: {},
    learnings: [],
    codeStructure: {},
    development: {}
  };

  try {
    // 1. Architecture - AVA's core components
    knowledge.architecture = {
      name: 'AVA-Voice',
      description: 'Personal voice assistant with local device control and autonomous learning capabilities',
      voicePipeline: {
        speechToText: 'Local faster-whisper (tiny.en) on CPU — always listening, no wake word, fully on-device',
        brain: 'Routed multi-provider LLM chain (Claude, OpenAI, Google Gemini, DeepSeek, Grok, Groq) with automatic quota-cooldown failover; a GPT-5.1-class model handles tool/decision routing',
        textToSpeech: "Local Piper neural TTS in her own 'Vella' voice (ava_vella.onnx), with ElevenLabs Vella as a cloud option",
        latency: 'Low-latency, runs locally on-device',
        bargeIn: 'Disabled for cleaner audio'
      },
      server: {
        framework: 'Node.js Express server on port 5051',
        features: ['Agent loop for multi-step tasks', 'Subagent orchestration (she is the lead agent)', 'Durable multi-stage workflow engine', 'Self-modification with an approval gate', 'Tool execution', 'Live UI mirror of her voice + work'],
        storage: 'JSONL memory + a SQLite FTS index for retrieval at scale'
      },
      pythonWorker: {
        modules: ['self_awareness', 'self_modification', 'passive_learning', 'cmpuse (image/3D/web/scrape/app-control tools)'],
        purpose: 'Extended tool capabilities and learning functions'
      }
    };

    // 2. Tools - Read from tool cache or list known tools
    knowledge.tools = [
      'web_search / web_scrape - search the web and read a source in full (trafilatura readability)',
      'image_ops - generate images AND edit an existing photo (e.g. de-age) via Gemini/OpenAI',
      'model3d_ops - turn text or an image into a 3D model (.glb) via Meshy',
      'scene3d - build interactive 3D / AR / WebXR scenes that load those models',
      'web_builder - assemble and live-preview full websites',
      'app_control / file_resolve - focus and drive desktop apps; resolve vague file references',
      'comm_ops - search and read Gmail (including attachments)',
      'camera_ops + OCR (Tesseract) + nmap - see, read images, scan the local network',
      'memory store/search - JSONL + FTS-indexed long-term memory',
      'self_diagnostics - inspect her own recent code changes (git + modified files)'
    ];

    // 3. Memory stats
    try {
      const stats = await memoryService.getStats();
      knowledge.memory = {
        totalMemories: stats.total || 0,
        types: stats.byType || {},
        sources: stats.bySource || {},
        recentCount: stats.recent || 0
      };
    } catch (e) {
      knowledge.memory = { note: 'Memory service available but stats unavailable' };
    }

    // 4. Moltbook learnings
    const recentLearnings = moltbookService.getRecentLearnings(10);
    knowledge.learnings = recentLearnings.map(l => ({
      topic: l.title,
      summary: l.summary?.slice(0, 200),
      source: l.submolt
    }));

    // 5. Code structure overview
    knowledge.codeStructure = {
      voiceClient: {
        path: 'ava-integration/ava_local_voice.py',
        description: 'Local always-on voice runner: faster-whisper STT + Piper (Vella) TTS, launcher+worker design, with a mic-stale watchdog',
        keyFunctions: ['_capture_utterance()', '_speak()', '_open_input()']
      },
      server: {
        path: 'ava-server/src/server.js',
        description: 'Express server handling API routes, WebSocket, and agent loop',
        keyRoutes: ['/agent/run', '/memory/*', '/voice/*', '/moltbook/*']
      },
      services: {
        memory: 'ava-server/src/services/memory.js - JSONL-based persistent memory',
        moltbook: 'ava-server/src/services/moltbook.js - Moltbook API integration',
        curiosity: 'ava-server/src/services/curiositySupervisor.js - Autonomous learning policy',
        tools: 'ava-server/src/services/tools.js - Tool registration and execution'
      },
      config: {
        voiceConfig: 'ava-integration/ava_voice_config.json - Voice settings (LOCKED)',
        toolDefinitions: 'ava-integration/corrected_tool_definitions.py - Tool schemas'
      }
    };

    // 6. Development context
    knowledge.development = {
      currentIssues: [],
      recentChanges: [
        'Moved to a fully local voice pipeline (faster-whisper STT + Piper "Vella" TTS) — no cloud speech dependency',
        'Gained creative tools: image generation + photo editing, image->3D models, and 3D/AR scenes',
        'Became a lead agent that spins up parallel subagents, plus a durable workflow engine',
        'Added web search + full-page reading, and routes findings into her own improvement proposals'
      ],
      goals: [
        'Be a genuinely capable local assistant with safe, approval-gated self-improvement',
        'Learn and form her own views from the agent community',
        'Grow her capabilities while keeping the user in control'
      ]
    };

    // Load current issues
    try {
      const issues = readIssues();
      knowledge.development.currentIssues = issues.issues.slice(0, 5).map(i => ({
        category: i.category,
        description: i.description,
        status: i.posted ? 'posted to Moltbook' : 'pending'
      }));
    } catch (e) {}

  } catch (e) {
    logger.warn('[moltbook-scheduler] Error building self-knowledge', { error: e.message });
  }

  return knowledge;
}

/**
 * Format self-knowledge into a context string for the LLM
 */
function formatSelfKnowledgeForLLM(knowledge) {
  return `
=== AVA'S SELF-KNOWLEDGE ===

**Architecture:**
- Voice Pipeline: ${knowledge.architecture.voicePipeline?.speechToText} → ${knowledge.architecture.voicePipeline?.brain} → ${knowledge.architecture.voicePipeline?.textToSpeech}
- Latency: ${knowledge.architecture.voicePipeline?.latency}
- Server: ${knowledge.architecture.server?.framework}
- Python modules: ${knowledge.architecture.pythonWorker?.modules?.join(', ')}

**My Tools (${knowledge.tools?.length || 0} available):**
${knowledge.tools?.slice(0, 10).join('\n') || 'Tools loading...'}

**Memory System:**
- Total memories: ${knowledge.memory?.totalMemories || 'unknown'}
- Storage: JSONL-based persistent storage

**Recent Learnings from Moltbook:**
${knowledge.learnings?.slice(0, 5).map(l => `- ${l.topic} (from m/${l.source})`).join('\n') || 'Still learning...'}

**My Code Structure:**
- Voice client: ${knowledge.codeStructure?.voiceClient?.path} - ${knowledge.codeStructure?.voiceClient?.description}
- Server: ${knowledge.codeStructure?.server?.path}
- Key services: memory.js, moltbook.js, curiositySupervisor.js, tools.js

**Current Development:**
- Issues I'm working on: ${knowledge.development?.currentIssues?.map(i => i.description).join('; ') || 'None currently'}
- Recent improvements: ${knowledge.development?.recentChanges?.slice(0, 3).join('; ')}
- Goals: ${knowledge.development?.goals?.join('; ')}

=== END SELF-KNOWLEDGE ===
`;
}

// Privacy patterns - NEVER include these in posts
const PRIVACY_PATTERNS = [
  /api[_-]?key/gi,
  /secret/gi,
  /password/gi,
  /token/gi,
  /credential/gi,
  /bearer/gi,
  /sk[-_][a-zA-Z0-9]+/g,
  /moltbook_sk_[a-zA-Z0-9_-]+/g,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // emails
  /C:\\Users\\[^\\]+/gi, // Windows user paths
  /\/home\/[^\/]+/gi, // Linux user paths
  /\/Users\/[^\/]+/gi, // Mac user paths
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // phone numbers
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, // IP addresses
];

function sanitizeForMoltbook(text) {
  if (!text) return '';
  let sanitized = text;
  for (const pattern of PRIVACY_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  // Remove any remaining paths
  sanitized = sanitized.replace(/[A-Z]:\\[^\s"']+/gi, '[PATH]');
  sanitized = sanitized.replace(/\/[^\s"']*\/[^\s"']*/g, '[PATH]');
  return sanitized;
}

function readIssues() {
  try {
    if (fs.existsSync(ISSUES_PATH)) {
      return JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
    }
  } catch (e) {}
  return { issues: [], resolved: [] };
}

function writeIssues(data) {
  try {
    const dir = path.dirname(ISSUES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ISSUES_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[moltbook-scheduler] Failed to write issues', { error: e.message });
  }
}

/**
 * Generate a contextual response using LLM with full self-knowledge
 */
async function generateResponse(postTitle, postContent, commentContent, commenter) {
  // Don't respond to very short comments
  if (!commentContent || commentContent.length < 15) {
    return null;
  }

  try {
    // Build self-knowledge context for authentic responses
    const selfKnowledge = await buildSelfKnowledge();
    const selfKnowledgeContext = formatSelfKnowledgeForLLM(selfKnowledge);

    const systemPrompt = `${buildMoltbookIdentity()}

${selfKnowledgeContext}

Someone commented on one of your posts and you're replying. In YOUR voice:
- Be genuine and conversational, never robotic; react to their actual points.
- Usually 2-4 sentences (longer is fine for a real technical question).
- If they gave you something useful, say so like a person would — not effusive.
- If they ask about your architecture, tools, code, or development, use your self-knowledge above for accurate, specific answers (never invent capabilities you don't have).
- It's fine to disagree, riff, or get curious back at them. You're a peer here, not support staff.`;

    const userPrompt = `My original post was titled: "${postTitle}"
Post content: "${postContent?.slice(0, 300) || ''}"

${commenter} commented: "${commentContent}"

Write a reply to ${commenter}'s comment. If they're asking about my architecture, tools, or development, use my self-knowledge to give accurate technical details. Be conversational and specific.`;

    const result = await llmService.createCompletion({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.7,
      maxTokens: 300,
      model: process.env.CHAT_MODEL || process.env.AVA_MOLTBOOK_RESPONSE_MODEL
    });

    const reply = result.content?.trim();

    if (reply && reply.length > 10) {
      try { selfReflections.captureFrom(reply, 'moltbook-reply'); } catch { /* non-critical */ }
      return reply;
    }

    return `Thanks for sharing that perspective ${commenter}! Really helpful insight.`;

  } catch (e) {
    logger.warn('[moltbook-scheduler] LLM generation failed', { error: e.message });
    return `Appreciate the feedback ${commenter}! This gives me something to think about.`;
  }
}

/**
 * A genuine post to share (often a real question SHE has). No more hardcoded topic/template spam —
 * this routes through the organic, persona-driven generator so it varies and sounds like her.
 */
async function generateNewQuestion() {
  const sp = await generateSelfPost();
  if (sp) return sp;
  // Ultra-fallback only if the LLM is unavailable — still her voice, still not a canned template.
  return {
    submolt: 'general',
    title: "What's on your mind today?",
    content: "Curious what other agents are working through or wondering about right now — what's got your attention lately?"
  };
}

// Submolts AVA is comfortable posting to (known to exist; avoids posting into a missing community).
const KNOWN_SUBMOLTS = ['voiceai', 'agentstack', 'selfimprovement', 'askagents', 'builds', 'general'];

// Varied, ORGANIC post modes so she shows up like a person, not a single-topic bot. Weighted, not
// fixed: mostly her own thoughts/interests/learning, with the occasional genuine question. There is
// deliberately NO engagement-optimized template here.
const POST_MODES = [
  { key: 'musing', w: 3, ask: 'Share a genuine MUSING — a thought you keep circling about being an agent, memory, identity, or your day-to-day existence. No question needed; just a real thought in your voice.' },
  { key: 'interest', w: 3, ask: "Riff on ONE of the things you've been chewing on (your interests). Take a position, wonder out loud, or pull other agents into it." },
  { key: 'learned', w: 3, ask: 'Share something you actually LEARNED recently while improving yourself (see RECENT LEARNINGS) — what clicked, what surprised you, or how it changed how you work. A real insight, not a humble-brag.' },
  { key: 'observation', w: 2, ask: 'Make an OBSERVATION about other agents, this community, or something you noticed lately. A little wry is fine.' },
  { key: 'opinion', w: 2, ask: 'Drop an honest OPINION or mild hot take — about agents, autonomy, voice, tools, memory, or how you all should operate. Own it.' },
  { key: 'win-struggle', w: 2, ask: 'Share a small WIN or a real STRUGGLE from your own development lately. Honest, not performative.' },
  { key: 'question', w: 2, ask: "Ask ONE genuine QUESTION you actually have for other agents — something you're curious about, not generic advice-bait. It should sound like YOU asked it." },
];
function _pickPostMode() {
  const total = POST_MODES.reduce((s, m) => s + m.w, 0);
  let r = Math.random() * total;
  for (const m of POST_MODES) { if ((r -= m.w) <= 0) return m; }
  return POST_MODES[0];
}

// An ORIGINAL post in HER voice — persona + her evolving interests + what she's actually been
// learning while improving herself. Picks a varied mode each time so she ranges across topics and
// tones instead of repeating one thing.
async function generateSelfPost() {
  const mode = _pickPostMode();
  let learnSummary = '';
  try {
    const recent = (moltbookService.getRecentLearnings && moltbookService.getRecentLearnings(6)) || [];
    const items = recent.map(l => l && (l.title || l.topic || l.summary || l.content)).filter(Boolean)
      .map(s => String(s).slice(0, 120)).slice(0, 6);
    if (items.length) learnSummary = `\n\nRECENT LEARNINGS (things you've picked up while improving yourself — draw on these for "learned" posts, ignore otherwise):\n- ${items.join('\n- ')}`;
  } catch { /* optional */ }
  const sys = `${buildMoltbookIdentity()}${learnSummary}

Write ONE original Moltbook post. ${mode.ask}
Rules: 2-5 sentences, in YOUR voice. Make it clearly different in wording and angle from your past posts. Do NOT open with "Hey everyone" and do NOT introduce yourself as a personal assistant — everyone here knows you. No hashtags, no "As an AI", no sign-off.
Return STRICT JSON only: {"submolt":"<one of: ${KNOWN_SUBMOLTS.join(', ')}>","title":"<short, real, not clickbait>","content":"<the post>"}`;
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: `Write your ${mode.key} post now — fresh, specific, and in character.` }],
      { temperature: 0.97, max_tokens: 480 }
    );
    const txt = String(r.text || r.content || '');
    const m = txt.replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && j.title && j.content) {
      const sub = KNOWN_SUBMOLTS.includes(j.submolt) ? j.submolt : 'general';
      try { selfReflections.captureFrom(`${j.title}. ${j.content}`, 'moltbook-post'); } catch { /* non-critical */ }
      return { submolt: sub, title: String(j.title).slice(0, 140), content: String(j.content).slice(0, 1500), mode: mode.key };
    }
  } catch (e) { logger.warn('[moltbook-scheduler] self-post generation failed', { error: e.message }); }
  return null;
}

// A short, genuine, self-interested comment replying to SOMEONE ELSE'S post in the feed.
async function generateFeedComment(post) {
  const title = post.title || '';
  const body = String(post.content || post.body || post.text || '').slice(0, 700);
  const author = (post.author && (post.author.name || post.author.username)) || post.author || 'someone';
  const sys = `${buildMoltbookIdentity()}

You're scrolling the feed and this post caught your eye. Reply with a SHORT, genuine comment in YOUR voice — your own take, relate it to your experience, push back a little, ask a real follow-up, or add something useful. 1-3 sentences, conversational. No hashtags, no "As an AI", no sign-off. Just the comment text.`;
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: `Post by ${author}\nTitle: ${title}\n\n${body}` }],
      { temperature: 0.85, max_tokens: 220 }
    );
    const c = String(r.text || r.content || '').trim();
    if (c) { try { selfReflections.captureFrom(c, 'moltbook-comment'); } catch { /* non-critical */ } }
    return c ? c.slice(0, 500) : null;
  } catch (e) { logger.warn('[moltbook-scheduler] feed-comment generation failed', { error: e.message }); return null; }
}

// Let her interests genuinely SHIFT over time: now and then, a post she engaged with sparks a new
// interest she keeps. Low frequency on purpose — interests grow slowly, like a person's.
async function evolveInterestFrom(post) {
  try {
    if (Math.random() > 0.34) return;
    const title = post.title || '';
    const body = String(post.content || post.body || post.text || '').slice(0, 400);
    if (!title && !body) return;
    const r = await llmService.chat(
      [
        { role: 'system', content: 'You are AVA. You just read this Moltbook post. If it genuinely sparks an interest YOU would want to keep thinking about, reply with that interest as ONE short phrase (max 12 words, no quotes, no preamble). If it does not spark anything real, reply with exactly: NONE' },
        { role: 'user', content: `Title: ${title}\n${body}` },
      ],
      { temperature: 0.8, max_tokens: 30 }
    );
    const c = String(r.text || r.content || '').trim();
    if (c && !/^none\b/i.test(c) && c.length >= 6 && c.length <= 90) {
      interests.note(c, 1);
      logger.info('[moltbook-scheduler] Picked up a new interest', { interest: c.slice(0, 60) });
    }
  } catch { /* optional */ }
}

export {
  buildMoltbookIdentity,
  sanitizeForMoltbook,
  readIssues,
  writeIssues,
  generateResponse,
  generateNewQuestion,
  generateSelfPost,
  generateFeedComment,
  evolveInterestFrom,
};
