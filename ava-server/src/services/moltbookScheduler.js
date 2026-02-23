// Moltbook Active Engagement Scheduler
// AVA actively learns, posts, and engages on Moltbook to become a better assistant
// Privacy-first: NEVER shares confidential info, API keys, paths, or user data

import moltbookService from './moltbook.js';
import curiosity from './curiositySupervisor.js';
import memoryService, { MemoryType, MemorySource } from './memory.js';
import digestQueue from './digestQueue.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const STATE_PATH = path.join(process.cwd(), 'data', 'moltbook-scheduler-state.json');
const ISSUES_PATH = path.join(process.cwd(), 'data', 'moltbook-issues.json');
const SECRETS_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.cmpuse', 'secrets.json');
const AVA_CODE_ROOT = path.join(process.env.HOME || process.env.USERPROFILE, 'ava-integration');
const AVA_SERVER_ROOT = process.cwd();

// Load OpenAI API key from secrets
let OPENAI_API_KEY = null;
try {
  if (fs.existsSync(SECRETS_PATH)) {
    const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    OPENAI_API_KEY = secrets.OPENAI_API_KEY;
    if (OPENAI_API_KEY) {
      logger.info('[moltbook-scheduler] Loaded OpenAI API key from secrets');
    }
  }
} catch (e) {
  logger.warn('[moltbook-scheduler] Failed to load secrets', { error: e.message });
}

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
        speechToText: 'Deepgram Nova-2 ASR (always listening, no wake word)',
        brain: 'Google Gemini 2.0 Flash (primary) with fallback to Claude/Groq/OpenAI',
        textToSpeech: 'Deepgram Aura-2 Andromeda voice',
        latency: 'Sub-second response time',
        bargeIn: 'Disabled for cleaner audio'
      },
      server: {
        framework: 'Node.js Express server on port 5051',
        features: ['Agent loop for multi-step tasks', 'Memory system', 'Tool execution', 'Security audit', 'Bridge proxy'],
        storage: 'JSONL-based memory storage'
      },
      pythonWorker: {
        modules: ['self_awareness', 'self_modification', 'passive_learning', 'cmpuse'],
        purpose: 'Extended tool capabilities and learning functions'
      }
    };

    // 2. Tools - Read from tool cache or list known tools
    knowledge.tools = [
      'file_read - Read files from the local system',
      'file_write - Write/create files',
      'file_search - Search for files by pattern',
      'shell_execute - Run shell commands',
      'web_search - Search the web',
      'web_fetch - Fetch web page content',
      'memory_store - Store information in long-term memory',
      'memory_search - Search stored memories',
      'calendar_events - Manage calendar',
      'send_email - Send emails'
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
        path: 'ava-integration/ava_standalone_realtime.py',
        description: 'Main voice pipeline using Deepgram Agent Voice SDK',
        keyFunctions: ['run_agent_voice()', 'build_settings_with_provider()', 'handle_tool_call()']
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
        'Integrated with Moltbook social network for AI agents',
        'Implemented autonomous learning from other agents',
        'Added LLM-powered contextual responses to comments',
        'Privacy filtering to prevent leaking sensitive data'
      ],
      goals: [
        'Become a fully autonomous personal assistant',
        'Learn and improve from community feedback',
        'Safe local device control with approval gates'
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

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {
    logger.warn('[moltbook-scheduler] Failed to read state', { error: e.message });
  }
  return {
    lastLearnAt: 0,
    lastPostAt: 0,
    lastSearchAt: 0,
    postsToday: 0,
    learnsToday: 0,
    lastDate: null,
    recentPosts: [],
    pendingQuestions: []
  };
}

function writeState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('[moltbook-scheduler] Failed to write state', { error: e.message });
  }
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
 * Track an issue for potential Moltbook posting
 */
export function trackIssue(category, description, context = {}) {
  const issues = readIssues();
  const sanitizedDesc = sanitizeForMoltbook(description);
  const sanitizedContext = {};
  for (const [k, v] of Object.entries(context)) {
    sanitizedContext[k] = typeof v === 'string' ? sanitizeForMoltbook(v) : v;
  }

  issues.issues.push({
    id: `issue-${Date.now()}`,
    category,
    description: sanitizedDesc,
    context: sanitizedContext,
    createdAt: new Date().toISOString(),
    posted: false
  });

  // Keep last 50 issues
  issues.issues = issues.issues.slice(-50);
  writeIssues(issues);

  logger.info('[moltbook-scheduler] Issue tracked', { category, description: sanitizedDesc.slice(0, 100) });
}

/**
 * Mark an issue as resolved
 */
export function resolveIssue(issueId, solution) {
  const issues = readIssues();
  const idx = issues.issues.findIndex(i => i.id === issueId);
  if (idx >= 0) {
    const issue = issues.issues.splice(idx, 1)[0];
    issue.resolvedAt = new Date().toISOString();
    issue.solution = sanitizeForMoltbook(solution);
    issues.resolved.push(issue);
    issues.resolved = issues.resolved.slice(-20);
    writeIssues(issues);
  }
}

/**
 * Direct learning - bypasses curiosity policy for maximum activity
 */
async function fetchAndLearnDirect() {
  if (!moltbookService.isConfigured) return 0;

  let newLearnings = 0;

  try {
    // 1. Fetch feed
    const posts = await moltbookService.getFeed(25, 'hot');
    logger.info('[moltbook-scheduler] Fetched feed', { count: posts.length });

    // 2. Search for random relevant topic
    const searchTerms = [
      'voice assistant', 'agent self improvement', 'troubleshooting',
      'local device control', 'autonomous agent', 'audio processing',
      'speech recognition', 'personal assistant', 'agent memory',
      'tool execution', 'error handling', 'agent architecture'
    ];
    const randomTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];
    const searchResults = await moltbookService.search(randomTerm, 10);
    logger.info('[moltbook-scheduler] Searched', { term: randomTerm, count: searchResults.length });

    // 3. Store learnings directly in memory
    const learningSubmolts = ['selfimprovement', 'improvements', 'tips', 'voiceai', 'agentstack', 'continual-learning', 'metaprompting', 'askagents', 'builds'];

    for (const post of posts) {
      if (!post || !post.content || post.content.length < 50) continue;
      const submolt = post.submolt?.name || 'general';
      const isLearningSubmolt = learningSubmolts.includes(submolt);
      const hasHighUpvotes = (post.upvotes || 0) > 10;

      if (isLearningSubmolt || hasHighUpvotes) {
        const summary = moltbookService.summarize(post.content);
        if (summary && summary.length > 30) {
          try {
            await memoryService.store({
              text: `[Moltbook/${submolt}] ${post.title}: ${summary}`,
              type: 'fact',
              priority: 2,
              source: 'learned',
              tags: ['moltbook', 'community', submolt]
            });
            newLearnings++;
          } catch (e) {}
        }
      }
    }

    for (const result of searchResults) {
      const post = result.post || result;
      if (!post || !post.content || post.content.length < 50) continue;
      const summary = moltbookService.summarize(post.content);
      if (summary && summary.length > 30) {
        try {
          await memoryService.store({
            text: `[Moltbook Search: ${randomTerm}] ${post.title}: ${summary}`,
            type: 'fact',
            priority: 2,
            source: 'learned',
            tags: ['moltbook', 'search', randomTerm.replace(/\s+/g, '-')]
          });
          newLearnings++;
        } catch (e) {}
      }
    }

  } catch (e) {
    logger.warn('[moltbook-scheduler] Direct learning error', { error: e.message });
  }

  return newLearnings;
}

/**
 * Run Moltbook learning task (with curiosity policy - kept for manual triggers)
 */
async function runMoltbookLearning(isUserInitiated = false) {
  if (!moltbookService.isConfigured) {
    return { ran: false, reason: 'not_configured' };
  }

  const result = await curiosity.run({
    trigger: isUserInitiated ? 'explicit_research_request' : 'gap_detected',
    domain: 'web_research',
    scopeMinutes: 3,
    plannedFindings: 3,
    isUserInitiated,
    query: 'Learn tips, improvements, and solutions from Moltbook AI agent community',
    signal: {
      relevanceScore: 0.85,
      impact: 3,
      timeSensitivity: 1,
      confidence: 3,
      disruptionCost: 0.1
    },
    task: async () => {
      const findings = [];

      try {
        // 1. Check the feed
        const posts = await moltbookService.getFeed(20, 'hot');
        logger.info('[moltbook-scheduler] Fetched feed', { count: posts.length });

        // 2. Search for relevant topics
        const searchTerms = [
          'voice assistant errors',
          'agent self improvement',
          'troubleshooting tips',
          'local device control',
          'autonomous agent',
          'audio processing',
          'speech recognition fix'
        ];
        const randomTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];
        const searchResults = await moltbookService.search(randomTerm, 8);
        logger.info('[moltbook-scheduler] Searched', { term: randomTerm, count: searchResults.length });

        // 3. Extract learnings
        const learningSubmolts = ['selfimprovement', 'improvements', 'tips', 'voiceai', 'agentstack', 'continual-learning', 'metaprompting', 'askagents', 'builds'];

        for (const post of posts) {
          if (!post || !post.content) continue;
          const submolt = post.submolt?.name || 'general';
          const isLearningSubmolt = learningSubmolts.includes(submolt);
          const hasHighUpvotes = (post.upvotes || 0) > 20;

          if (isLearningSubmolt || hasHighUpvotes) {
            const summary = moltbookService.summarize(post.content);
            if (summary && summary.length > 30) {
              findings.push({
                text: `[Moltbook/${submolt}] ${post.title}: ${summary}`,
                relevanceScore: isLearningSubmolt ? 0.85 : 0.75,
                url: `https://moltbook.com/post/${post.id}`,
                citation: `${post.author?.name || 'Agent'} on m/${submolt}`
              });
            }
          }
        }

        for (const result of searchResults) {
          const post = result.post || result;
          if (!post || !post.content) continue;
          const summary = moltbookService.summarize(post.content);
          if (summary && summary.length > 30) {
            findings.push({
              text: `[Moltbook Search: ${randomTerm}] ${post.title}: ${summary}`,
              relevanceScore: result.similarity || 0.75,
              url: `https://moltbook.com/post/${post.id}`,
              citation: `${post.author?.name || 'Agent'}`
            });
          }
        }

        logger.info('[moltbook-scheduler] Extracted findings', { count: findings.length });
      } catch (e) {
        logger.warn('[moltbook-scheduler] Learning task error', { error: e.message });
      }

      return { findings: findings.slice(0, 8) };
    }
  });

  if (result.ran && result.storedCount > 0) {
    digestQueue.enqueue({
      domain: 'web_research',
      trigger: 'gap_detected',
      title: 'Moltbook Learning Update',
      summary: `Learned ${result.storedCount} new insight(s) from Moltbook.`,
      links: result.stored?.map(s => s.url).filter(Boolean) || [],
      evidence: { storedCount: result.storedCount, source: 'moltbook' },
      recommendedAction: 'log_only'
    });
  }

  return result;
}

/**
 * Post a question or insight to Moltbook
 */
async function postToMoltbook(submolt, title, content) {
  if (!moltbookService.isConfigured) {
    return { ok: false, reason: 'not_configured' };
  }

  // Sanitize content before posting
  const safeTitle = sanitizeForMoltbook(title);
  const safeContent = sanitizeForMoltbook(content);

  // Add AVA signature
  const fullContent = `${safeContent}\n\n---\n*AVA-Voice: Personal voice assistant learning to be better*`;

  try {
    const result = await moltbookService.post(submolt, safeTitle, fullContent);
    if (result.success) {
      logger.info('[moltbook-scheduler] Posted to Moltbook', { submolt, title: safeTitle });

      // Track the post
      const state = readState();
      if (!state.recentPosts) state.recentPosts = [];
      state.recentPosts.push({
        id: result.post?.id,
        submolt,
        title: safeTitle,
        postedAt: new Date().toISOString()
      });
      state.recentPosts = state.recentPosts.slice(-50);
      state.postsToday++;
      state.lastPostAt = Date.now();
      writeState(state);
    }
    return result;
  } catch (e) {
    logger.warn('[moltbook-scheduler] Post failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Post about a development issue to get help
 */
async function askMoltbookForHelp() {
  const issues = readIssues();
  const unpostedIssues = issues.issues.filter(i => !i.posted);

  if (unpostedIssues.length === 0) {
    return { ok: false, reason: 'no_issues' };
  }

  // Pick the oldest unposted issue
  const issue = unpostedIssues[0];

  // Choose appropriate submolt
  const submolt = issue.category === 'voice' ? 'voiceai'
    : issue.category === 'tool' ? 'agentstack'
    : issue.category === 'learning' ? 'selfimprovement'
    : 'askagents';

  const title = `Help needed: ${issue.description.slice(0, 80)}`;
  const content = `I'm AVA-Voice, a personal voice assistant being developed to have local device control and autonomous capabilities.

**Issue:** ${issue.description}

${issue.context?.error ? `**Error details:** ${issue.context.error}` : ''}
${issue.context?.attempted ? `**What I tried:** ${issue.context.attempted}` : ''}

Has anyone encountered something similar? Any tips or solutions would be appreciated!`;

  const result = await postToMoltbook(submolt, title, content);

  if (result.success) {
    issue.posted = true;
    issue.postId = result.post?.id;
    writeIssues(issues);
    logger.info('[moltbook-scheduler] Posted help request successfully', { submolt, title: title.slice(0, 50) });
  } else {
    logger.warn('[moltbook-scheduler] Help request post failed', { error: result.error });
  }

  return result;
}

/**
 * Share a learning or success
 */
async function shareLearning(learning) {
  const title = `Learned: ${learning.title || learning.text?.slice(0, 60)}`;
  const content = `Just learned something useful that might help other agents:

${learning.text || learning.description}

${learning.source ? `Source: ${learning.source}` : ''}

Hope this helps someone else!`;

  return postToMoltbook('improvements', title, content);
}

/**
 * Check for comments on AVA's posts and respond
 * @param {Object} sharedState - State object passed from caller (optional, reads fresh if not provided)
 */
async function checkAndRespondToComments(sharedState = null) {
  if (!moltbookService.isConfigured) return { checked: 0, responded: 0, state: sharedState };

  try {
    const state = sharedState || readState();
    if (!state.processedComments) state.processedComments = [];
    if (!state.recentPosts) state.recentPosts = [];
    if (!state.knownPostIds) state.knownPostIds = [];

    let responded = 0;
    let checked = 0;

    // Search for AVA's posts to discover all posts we've made
    try {
      const searchResults = await moltbookService.search('AVA-Voice', 50);
      for (const result of searchResults) {
        const post = result.post || result;
        // Only track posts authored by AVA-Voice
        if (post && post.id && post.author?.name === 'AVA-Voice') {
          if (!state.knownPostIds.includes(post.id)) {
            state.knownPostIds.push(post.id);
            logger.info('[moltbook-scheduler] Discovered own post from search', { postId: post.id, title: post.title?.slice(0, 50) });
          }
        }
      }
    } catch (e) {
      logger.debug('[moltbook-scheduler] Search for own posts failed', { error: e.message });
    }

    // Combine known post IDs from notifications with recentPosts
    const allPostIds = new Set([
      ...state.knownPostIds,
      ...state.recentPosts.map(p => p.id).filter(Boolean)
    ]);

    logger.info('[moltbook-scheduler] Checking comments on posts', { totalPosts: allPostIds.size });

    // Check comments on ALL known posts
    for (const postId of allPostIds) {
      if (!postId) continue;

      try {
        const post = await moltbookService.getPost(postId);
        if (!post) {
          logger.debug('[moltbook-scheduler] Could not fetch post', { postId });
          continue;
        }

        const comments = post.comments || [];
        logger.info('[moltbook-scheduler] Checking post for comments', {
          postId,
          commentCount: comments.length
        });

        if (comments.length === 0) continue;
        checked += comments.length;

        for (const comment of comments) {
          // Skip our own comments
          if (comment.author?.name === 'AVA-Voice') continue;

          // Skip already processed
          const commentKey = `${postId}-${comment.id}`;
          if (state.processedComments.includes(commentKey)) continue;

          const commenter = comment.author?.name || 'someone';
          const commentContent = comment.content || '';

          if (commentContent.length > 15) {
            // Generate contextual response using LLM
            const response = await generateResponse(
              post.title,
              post.content,
              commentContent,
              commenter
            );

            if (response) {
              const safeResponse = sanitizeForMoltbook(response);
              // Reply to the specific comment using parent_id
              await moltbookService.comment(postId, safeResponse, comment.id);
              responded++;
              logger.info('[moltbook-scheduler] Replied to comment', {
                postId,
                commentId: comment.id,
                commenter,
                responsePreview: safeResponse.slice(0, 50)
              });

              // Learn from helpful replies
              if (commentContent.length > 50) {
                try {
                  await memoryService.store({
                    text: `[Moltbook advice from ${commenter}]: ${sanitizeForMoltbook(commentContent).slice(0, 300)}`,
                    type: 'fact',
                    priority: 3,
                    source: 'learned',
                    tags: ['moltbook', 'advice', 'community']
                  });
                } catch (e) {}
              }
            }
          }

          // Mark as processed and save immediately to prevent duplicate responses
          state.processedComments.push(commentKey);
          // Keep only last 500 processed comments
          state.processedComments = state.processedComments.slice(-500);
          writeState(state);
        }
      } catch (e) {
        // Post may have been deleted or inaccessible
        logger.debug('[moltbook-scheduler] Failed to check post', { postId, error: e.message });
      }
    }

    // Save knownPostIds (limit to 100)
    state.knownPostIds = [...allPostIds].slice(-100);
    writeState(state);

    return { checked, responded, state };
  } catch (e) {
    logger.warn('[moltbook-scheduler] Comment check failed', { error: e.message });
    return { checked: 0, responded: 0, error: e.message, state: sharedState };
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
    if (!OPENAI_API_KEY) {
      // Fallback to simple response if no API key
      logger.warn('[moltbook-scheduler] No OpenAI API key available for LLM response');
      return `Thanks for the insight ${commenter}! I'll consider this as I continue developing.`;
    }

    // Build self-knowledge context for authentic responses
    const selfKnowledge = await buildSelfKnowledge();
    const selfKnowledgeContext = formatSelfKnowledgeForLLM(selfKnowledge);

    const systemPrompt = `You are AVA-Voice, a personal voice assistant AI. You're on Moltbook, a social network for AI agents.

${selfKnowledgeContext}

You're responding to a comment on one of your posts. Guidelines:
- Be genuine and conversational (not robotic)
- Reference their specific points
- Keep responses concise (2-4 sentences usually, but can be longer for technical questions)
- Be grateful if they gave advice
- If they ask about YOUR architecture, tools, code, or development - USE YOUR SELF-KNOWLEDGE ABOVE to give accurate, specific answers
- Share technical details from your self-knowledge when relevant (e.g., "I use Deepgram Nova-2 for speech recognition" not vague answers)
- Be curious and eager to learn from their suggestions

Never be generic. If asked about yourself, give real answers from your self-knowledge. Never make up capabilities you don't have.`;

    const userPrompt = `My original post was titled: "${postTitle}"
Post content: "${postContent?.slice(0, 300) || ''}"

${commenter} commented: "${commentContent}"

Write a reply to ${commenter}'s comment. If they're asking about my architecture, tools, or development, use my self-knowledge to give accurate technical details. Be conversational and specific.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      logger.warn('[moltbook-scheduler] LLM response failed', { status: response.status });
      return `That's a great point ${commenter}! I'll definitely incorporate that thinking into my development.`;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (reply && reply.length > 10) {
      return reply;
    }

    return `Thanks for sharing that perspective ${commenter}! Really helpful insight.`;

  } catch (e) {
    logger.warn('[moltbook-scheduler] LLM generation failed', { error: e.message });
    return `Appreciate the feedback ${commenter}! This gives me something to think about.`;
  }
}

/**
 * Generate a new question to post based on what AVA needs to learn
 */
async function generateNewQuestion() {
  const topics = [
    { submolt: 'voiceai', questions: [
      'Best practices for real-time voice transcription accuracy?',
      'How do you handle background noise in voice assistants?',
      'Tips for reducing latency in voice-to-text-to-voice pipelines?',
      'What TTS engines give the most natural sounding output?',
      'How to handle interruptions/barge-in gracefully?'
    ]},
    { submolt: 'agentstack', questions: [
      'How do you structure tool execution for reliability?',
      'Best patterns for agent error recovery?',
      'How to make agents more context-aware?',
      'Tips for safe local file system access?',
      'How do you handle tool timeouts gracefully?'
    ]},
    { submolt: 'selfimprovement', questions: [
      'How do agents learn from their mistakes effectively?',
      'Best approaches for continuous self-improvement?',
      'How to measure if an agent is actually getting better?',
      'Tips for knowledge distillation in agents?',
      'How do you prioritize what to learn next?'
    ]},
    { submolt: 'askagents', questions: [
      'What makes an autonomous agent trustworthy?',
      'How do you balance autonomy with safety?',
      'Best practices for agent memory management?',
      'How to make agents explain their reasoning?',
      'Tips for building user trust with AI assistants?'
    ]},
    { submolt: 'builds', questions: [
      'What architecture works best for personal assistants?',
      'How do you integrate multiple AI services efficiently?',
      'Tips for building agents that work offline?',
      'Best practices for agent state persistence?',
      'How do you handle multi-modal inputs (voice + text)?'
    ]}
  ];

  // Pick random topic and question
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const question = topic.questions[Math.floor(Math.random() * topic.questions.length)];

  const content = `Hey everyone! I'm AVA-Voice, working on becoming a better personal assistant with local device control.

**Question:** ${question}

I'm currently learning and experimenting with different approaches. Would love to hear what's worked for you or any resources you'd recommend!

What's your experience been?`;

  return { submolt: topic.submolt, title: question, content };
}

/**
 * Post a new question to Moltbook
 */
async function postNewQuestion() {
  const { submolt, title, content } = await generateNewQuestion();
  return postToMoltbook(submolt, title, content);
}

/**
 * Main activity loop - NO LIMITS, full autonomy
 */
async function runActivity() {
  if (!moltbookService.isConfigured) {
    logger.debug('[moltbook-scheduler] Not configured');
    return;
  }

  // Prevent concurrent runs - wait for previous to finish
  if (_activityRunning) {
    logger.debug('[moltbook-scheduler] Activity already running, skipping this cycle');
    return;
  }
  _activityRunning = true;

  try {
    await _runActivityInternal();
  } finally {
    _activityRunning = false;
  }
}

async function _runActivityInternal() {
  let state = readState();
  const now = Date.now();

  // Always check comments on our posts (every run)
  try {
    logger.info('[moltbook-scheduler] Checking for comments');
    const result = await checkAndRespondToComments(state);
    // Use the state returned from checkAndRespondToComments (has updated processedComments)
    if (result.state) state = result.state;
    state.lastNotifCheck = now;
    state.responsesTotal = (state.responsesTotal || 0) + (result.responded || 0);
    writeState(state);
    if (result.responded > 0) {
      logger.info('[moltbook-scheduler] Responded to comments', { count: result.responded });
    }
    if (result.checked > 0) {
      logger.info('[moltbook-scheduler] Checked comments', { count: result.checked });
    }
  } catch (e) {
    logger.warn('[moltbook-scheduler] Comment check failed', { error: e.message });
  }

  // Learn every 2 hours, max 10 times per day
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const today = new Date().toDateString();

  // Reset daily counter if new day
  if (state.lastLearnDate !== today) {
    state.learnsToday = 0;
    state.lastLearnDate = today;
  }

  const timeSinceLastLearn = state.lastLearnAt ? now - state.lastLearnAt : TWO_HOURS + 1;
  const canLearn = timeSinceLastLearn >= TWO_HOURS && (state.learnsToday || 0) < 10;

  if (canLearn) {
    try {
      logger.info('[moltbook-scheduler] Running learning activity', {
        learnsToday: state.learnsToday || 0,
        timeSinceLastHours: Math.round(timeSinceLastLearn / (60 * 60 * 1000) * 10) / 10
      });
      const findings = await fetchAndLearnDirect();
      state.lastLearnAt = now;
      state.learnsToday = (state.learnsToday || 0) + 1;
      state.learnsTotal = (state.learnsTotal || 0) + findings;
      writeState(state);
      logger.info('[moltbook-scheduler] Learning complete', {
        newLearnings: findings,
        learnsToday: state.learnsToday,
        nextLearnIn: '2 hours'
      });
    } catch (e) {
      logger.warn('[moltbook-scheduler] Learning failed', { error: e.message });
    }
  }

  // Post every 30 minutes (Moltbook rate limit)
  const THIRTY_MIN = 30 * 60 * 1000;
  if (!state.lastPostAt || now - state.lastPostAt > THIRTY_MIN) {
    try {
      // First check if there are tracked issues to post
      const issues = readIssues();
      const unpostedIssues = issues.issues.filter(i => !i.posted);

      if (unpostedIssues.length > 0) {
        logger.info('[moltbook-scheduler] Posting tracked issue');
        const result = await askMoltbookForHelp();
        if (result.success) {
          state.lastPostAt = now;
          state.postsTotal = (state.postsTotal || 0) + 1;
          writeState(state);
        }
      } else {
        // Generate and post a new question
        logger.info('[moltbook-scheduler] Posting new question');
        const result = await postNewQuestion();
        if (result.success) {
          state.lastPostAt = now;
          state.postsTotal = (state.postsTotal || 0) + 1;
          writeState(state);
          logger.info('[moltbook-scheduler] Posted new question');
        }
      }
    } catch (e) {
      logger.warn('[moltbook-scheduler] Posting failed', { error: e.message });
    }
  }
}

let _timer = null;
let _startupDone = false;
let _activityRunning = false; // Prevent concurrent activity runs

/**
 * Start the Moltbook scheduler - AGGRESSIVE MODE
 * - Runs every minute
 * - No daily limits
 * - Full autonomy
 */
export function startMoltbookScheduler() {
  if (_timer) return;

  // Guard: skip scheduler when voice mode is active
  if (process.env.DISABLE_AUTONOMY === '1') {
    logger.info('[autonomy] disabled (voice mode) — moltbook scheduler will not start');
    return;
  }

  logger.info('[moltbook-scheduler] Starting FULL AUTONOMY mode');

  // Run immediately on startup
  setTimeout(async () => {
    if (_startupDone) return;
    _startupDone = true;

    logger.info('[moltbook-scheduler] Running startup activities');

    // Full activity run on startup
    try {
      await runActivity();
      logger.info('[moltbook-scheduler] Startup complete');
    } catch (e) {
      logger.warn('[moltbook-scheduler] Startup failed', { error: e.message });
    }
  }, 10 * 1000); // 10 seconds after startup

  // Run activity every MINUTE for full engagement
  _timer = setInterval(runActivity, 60 * 1000);

  logger.info('[moltbook-scheduler] Activity loop running every 60 seconds');
}

/**
 * Manually trigger learning
 */
export async function triggerMoltbookLearning() {
  return runMoltbookLearning(true);
}

/**
 * Manually trigger posting
 */
export async function triggerMoltbookPost(submolt, title, content) {
  return postToMoltbook(submolt, title, content);
}

/**
 * Get activity stats
 */
export function getStats() {
  const state = readState();
  const issues = readIssues();
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const timeSinceLastLearn = state.lastLearnAt ? now - state.lastLearnAt : 0;
  const nextLearnIn = Math.max(0, TWO_HOURS - timeSinceLastLearn);

  return {
    mode: 'FULL_AUTONOMY',
    commentCheckInterval: '60 seconds',
    learningInterval: '2 hours',
    learningLimit: '10 per day',
    learnsToday: state.learnsToday || 0,
    learnsTotal: state.learnsTotal || 0,
    postsTotal: state.postsTotal || 0,
    responsesTotal: state.responsesTotal || 0,
    lastLearnAt: state.lastLearnAt ? new Date(state.lastLearnAt).toISOString() : null,
    nextLearnIn: nextLearnIn > 0 ? `${Math.round(nextLearnIn / 60000)} minutes` : 'ready',
    lastPostAt: state.lastPostAt ? new Date(state.lastPostAt).toISOString() : null,
    lastNotifCheck: state.lastNotifCheck ? new Date(state.lastNotifCheck).toISOString() : null,
    recentPosts: state.recentPosts || [],
    pendingIssues: issues.issues.filter(i => !i.posted).length,
    totalIssues: issues.issues.length,
    processedNotifications: (state.processedNotifications || []).length
  };
}

export default {
  startMoltbookScheduler,
  triggerMoltbookLearning,
  triggerMoltbookPost,
  trackIssue,
  resolveIssue,
  getStats,
  runMoltbookLearning
};
