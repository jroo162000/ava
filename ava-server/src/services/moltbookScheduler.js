// Moltbook Active Engagement Scheduler
// AVA actively learns, posts, and engages on Moltbook to become a better assistant
// Privacy-first: NEVER shares confidential info, API keys, paths, or user data

import moltbookService from './moltbook.js';
import curiosity from './curiositySupervisor.js';
import llmService from './llm.js';
import memoryService, { MemoryType, MemorySource } from './memory.js';
import digestQueue from './digestQueue.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const STATE_PATH = path.join(process.cwd(), 'data', 'moltbook-scheduler-state.json');
const ISSUES_PATH = path.join(process.cwd(), 'data', 'moltbook-issues.json');
const AVA_CODE_ROOT = path.join(process.env.HOME || process.env.USERPROFILE, 'ava-integration');
const AVA_SERVER_ROOT = process.cwd();
const HOME_SYNC_EVERY_MS = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_HOME_SYNC_MIN || '15', 10)) * 60 * 1000;
const HOME_SYNC_COMMENT_LIMIT = Math.max(10, parseInt(process.env.AVA_MOLTBOOK_HOME_COMMENT_LIMIT || '60', 10));
const POST_CHECK_LIMIT = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_POST_CHECK_LIMIT || '12', 10));
const EXTERNAL_CHECK_LIMIT = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_EXTERNAL_CHECK_LIMIT || '20', 10));
const REPLY_LIMIT_PER_CYCLE = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_REPLY_LIMIT_PER_CYCLE || '12', 10));

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

function commentIdOf(comment) {
  return comment?.id || comment?.comment_id || comment?._id || comment?.uuid || null;
}

function commentParentIdOf(comment) {
  return comment?.parent_id || comment?.parentId || comment?.parent_comment_id || comment?.reply_to || comment?.replyTo || null;
}

function commentAuthorName(comment) {
  return comment?.author?.name || comment?.author?.username || comment?.author_name || comment?.agent_name || '';
}

function rememberExternalComment(state, postId, commentResult, postTitle = '') {
  const comment = commentResult?.comment || commentResult?.data?.comment || commentResult;
  const commentId = commentIdOf(comment);
  if (!postId || !commentId) return;
  state.commentsOnOthers = state.commentsOnOthers || [];
  if (state.commentsOnOthers.some(c => c.postId === postId && c.commentId === commentId)) return;
  state.commentsOnOthers.push({
    postId,
    commentId,
    postTitle: String(postTitle || '').slice(0, 160),
    commentedAt: new Date().toISOString()
  });
  state.commentsOnOthers = state.commentsOnOthers.slice(-300);
}

function commentContentOf(comment) {
  return String(comment?.content || comment?.body || comment?.text || '').trim();
}

function flattenComments(comments, parentId = null) {
  const out = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment) continue;
    const normalized = parentId && !commentParentIdOf(comment)
      ? { ...comment, parent_id: parentId }
      : comment;
    out.push(normalized);
    const cid = commentIdOf(comment);
    if (cid && Array.isArray(comment.replies) && comment.replies.length) {
      out.push(...flattenComments(comment.replies, cid));
    }
  }
  return out;
}

async function syncMoltbookHomeActivity(sharedState = null) {
  if (!moltbookService.isConfigured) return { posts: 0, comments: 0, learned: 0, state: sharedState };

  const state = sharedState || readState();
  if (moltbookService.isRateLimited) return { posts: 0, comments: 0, learned: 0, skipped: 'rate_limited', state };
  if (state.lastHomeActivitySync && Date.now() - state.lastHomeActivitySync < HOME_SYNC_EVERY_MS) {
    return { posts: 0, comments: 0, learned: 0, skipped: 'not_due', state };
  }
  state.knownPostIds = state.knownPostIds || [];
  state.processedHomeComments = state.processedHomeComments || [];

  let posts = 0;
  let comments = 0;
  let learned = 0;

  try {
    const home = await moltbookService.getHome();
    const activity = Array.isArray(home?.activity_on_your_posts) ? home.activity_on_your_posts : [];

    for (const item of activity) {
      const postId = item.post_id || item.postId || item.post?.id;
      if (!postId) continue;
      posts++;

      if (!state.knownPostIds.includes(postId)) state.knownPostIds.push(postId);

      let threadComments = [];
      try {
        threadComments = await moltbookService.getPostComments(postId, HOME_SYNC_COMMENT_LIMIT);
      } catch {
        threadComments = [];
      }
      threadComments = flattenComments(threadComments);

      for (const comment of threadComments) {
        const cid = commentIdOf(comment);
        const author = commentAuthorName(comment) || 'someone';
        const content = commentContentOf(comment);
        if (!cid || !content || author === 'AVA-Voice') continue;
        comments++;

        const key = `${postId}:${cid}`;
        if (state.processedHomeComments.includes(key)) continue;
        if (content.length >= 40) {
          if (moltbookService.recordLearning({
            postId,
            commentId: cid,
            title: item.post_title || item.title || item.post?.title || 'Moltbook activity',
            summary: sanitizeForMoltbook(content).slice(0, 700),
            submolt: item.submolt_name || item.submolt?.name || 'activity',
            author,
            source: `Moltbook comment from ${author}`,
          })) {
            learned++;
          }
        }
        state.processedHomeComments.push(key);
      }

      try { await moltbookService.markPostNotificationsRead(postId); } catch {}
    }

    state.knownPostIds = state.knownPostIds.slice(-300);
    state.processedHomeComments = state.processedHomeComments.slice(-2000);
    state.lastHomeActivitySync = Date.now();
    writeState(state);
    return { posts, comments, learned, state };
  } catch (e) {
    logger.warn('[moltbook-scheduler] Home activity sync failed', { error: e.message });
    return { posts, comments, learned, error: e.message, state };
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
// Posts awaiting the user's answer to a Moltbook verification challenge (AVA does not auto-solve).
const _pendingVerifications = [];
const VERIFICATION_TTL_MS = 9.5 * 60 * 1000; // challenges expire around 10 minutes

function verificationStatusOf(obj) {
  return String(
    obj?.verification_status ||
    obj?.verificationStatus ||
    obj?.post?.verification_status ||
    obj?.post?.verificationStatus ||
    obj?.status ||
    ''
  ).toLowerCase();
}

function verificationSucceeded(res) {
  const status = verificationStatusOf(res);
  const msg = String(res?.message || res?.status || '').toLowerCase();
  return !!(
    res?.success ||
    res?.verified ||
    res?.ok ||
    res?.published ||
    res?.post?.published ||
    res?.post?.verified ||
    ['verified', 'published', 'approved', 'active', 'live'].includes(status) ||
    /\b(verified|published|approved)\b/.test(msg)
  );
}

function shouldKeepAfterVerificationResponse(res) {
  if (verificationSucceeded(res)) return false;
  const text = JSON.stringify(res || {}).toLowerCase();
  if (/\b(incorrect|wrong|invalid answer|try again|answer was not)\b/.test(text)) return true;
  if (/\b(expired|already verified|already published|not found|unknown verification|used|complete)\b/.test(text)) return false;
  // Ambiguous responses caused stale cards before; fail closed by clearing the queue card.
  return false;
}

function removePendingVerification(code) {
  const i = _pendingVerifications.findIndex(v => v.verification_code === code);
  if (i >= 0) _pendingVerifications.splice(i, 1);
}

async function prunePendingVerifications({ refresh = false } = {}) {
  const now = Date.now();
  for (let i = _pendingVerifications.length - 1; i >= 0; i--) {
    const v = _pendingVerifications[i];
    if ((now - v.queued_at) >= VERIFICATION_TTL_MS) {
      _pendingVerifications.splice(i, 1);
      continue;
    }
    if (!refresh || !v.post_id) continue;
    try {
      const post = await moltbookService.getPost(v.post_id);
      const status = verificationStatusOf(post);
      const stillNeedsChallenge = !!(post?.verification && (post.verification.verification_code || post.verification.challenge_text));
      if (verificationSucceeded(post) || (post && !stillNeedsChallenge && status && status !== 'pending')) {
        _pendingVerifications.splice(i, 1);
      }
    } catch {
      // Keep the local card if the status check itself failed; the submit path will reconcile it.
    }
  }
}

export async function getPendingVerifications() {
  await prunePendingVerifications({ refresh: true });
  return _pendingVerifications.slice();
}

export async function submitMoltbookVerification(code, answer) {
  const res = await moltbookService.submitVerification(code, answer);
  const ok = verificationSucceeded(res);
  const keep = shouldKeepAfterVerificationResponse(res);
  if (!keep) removePendingVerification(code);
  return { ok, cleared: !keep, retryable: keep, result: res };
}

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

      // Per-post verification challenge -> queue for the USER to answer (AVA does not auto-solve).
      const _v = result.post && result.post.verification;
      if (_v && (_v.verification_code || _v.challenge_text)) {
        _pendingVerifications.push({
          post_id: result.post.id, title: safeTitle, submolt,
          challenge_text: _v.challenge_text || '', instructions: _v.instructions || '',
          verification_code: _v.verification_code || '', expires_at: _v.expires_at || '', queued_at: Date.now(),
        });
        while (_pendingVerifications.length > 20) _pendingVerifications.shift();
        logger.info('[moltbook-scheduler] Post needs verification — queued for user', { post: result.post.id });
      }
    } else {
      logger.warn('[moltbook-scheduler] Moltbook post returned non-success', {
        submolt,
        title: safeTitle,
        statusCode: result && result.statusCode,
        error: result && result.error,
        message: result && result.message,
      });
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
  if (moltbookService.isRateLimited) return { checked: 0, responded: 0, skipped: 'rate_limited', state: sharedState };

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

    const postIds = [...allPostIds].filter(Boolean);
    const startIndex = Math.max(0, state.knownPostCheckIndex || 0) % Math.max(1, postIds.length);
    const selectedPostIds = postIds.slice(startIndex, startIndex + POST_CHECK_LIMIT);
    if (selectedPostIds.length < Math.min(POST_CHECK_LIMIT, postIds.length)) {
      selectedPostIds.push(...postIds.slice(0, Math.min(POST_CHECK_LIMIT - selectedPostIds.length, postIds.length)));
    }
    if (postIds.length) state.knownPostCheckIndex = (startIndex + selectedPostIds.length) % postIds.length;

    logger.info('[moltbook-scheduler] Checking comments on posts', { totalPosts: allPostIds.size, checkedThisCycle: selectedPostIds.length });

    // Check comments on ALL known posts
    for (const postId of selectedPostIds) {
      if (!postId) continue;
      if (responded >= REPLY_LIMIT_PER_CYCLE) break;

      try {
        const post = await moltbookService.getPost(postId);
        if (!post) {
          logger.debug('[moltbook-scheduler] Could not fetch post', { postId });
          continue;
        }

        let comments = post.comments || [];
        if (!comments.length) {
          try { comments = await moltbookService.getPostComments(postId, 100); } catch { comments = []; }
        }
        comments = flattenComments(comments);
        logger.info('[moltbook-scheduler] Checking post for comments', {
          postId,
          commentCount: comments.length
        });

        if (comments.length === 0) continue;
        checked += comments.length;

        for (const comment of comments) {
          // Skip our own comments
          if (commentAuthorName(comment) === 'AVA-Voice') continue;

          // Skip already processed
          const cid = commentIdOf(comment);
          if (!cid) continue;
          const commentKey = `${postId}-${cid}`;
          if (state.processedComments.includes(commentKey)) continue;

          const commenter = commentAuthorName(comment) || 'someone';
          const commentContent = commentContentOf(comment);

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
              await moltbookService.comment(postId, safeResponse, cid);
              responded++;
              logger.info('[moltbook-scheduler] Replied to comment', {
                postId,
                commentId: cid,
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
          state.processedComments = state.processedComments.slice(-3000);
          writeState(state);
          if (responded >= REPLY_LIMIT_PER_CYCLE) break;
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
 * Check for replies under comments AVA left on other people's posts and respond.
 */
async function checkAndRespondToExternalReplies(sharedState = null) {
  if (!moltbookService.isConfigured) return { checked: 0, responded: 0, state: sharedState };
  if (moltbookService.isRateLimited) return { checked: 0, responded: 0, skipped: 'rate_limited', state: sharedState };

  try {
    const state = sharedState || readState();
    state.processedComments = state.processedComments || [];
    state.commentsOnOthers = state.commentsOnOthers || [];

    let checked = 0;
    let responded = 0;

    const trackedComments = state.commentsOnOthers.slice(-300);
    const startIndex = Math.max(0, state.externalCommentCheckIndex || 0) % Math.max(1, trackedComments.length);
    const selected = trackedComments.slice(startIndex, startIndex + EXTERNAL_CHECK_LIMIT);
    if (selected.length < Math.min(EXTERNAL_CHECK_LIMIT, trackedComments.length)) {
      selected.push(...trackedComments.slice(0, Math.min(EXTERNAL_CHECK_LIMIT - selected.length, trackedComments.length)));
    }
    if (trackedComments.length) state.externalCommentCheckIndex = (startIndex + selected.length) % trackedComments.length;

    for (const tracked of selected) {
      if (!tracked?.postId || !tracked?.commentId) continue;
      if (responded >= REPLY_LIMIT_PER_CYCLE) break;

      try {
        const post = await moltbookService.getPost(tracked.postId);
        let comments = post?.comments || [];
        if (!comments.length) {
          try { comments = await moltbookService.getPostComments(tracked.postId, 100); } catch { comments = []; }
        }
        comments = flattenComments(comments);
        if (!comments.length) continue;

        for (const comment of comments) {
          const cid = commentIdOf(comment);
          if (!cid) continue;
          if (commentAuthorName(comment) === 'AVA-Voice') continue;

          const parentId = commentParentIdOf(comment);
          if (String(parentId || '') !== String(tracked.commentId)) continue;

          checked++;
          const commentKey = `${tracked.postId}-external-reply-${cid}`;
          if (state.processedComments.includes(commentKey)) continue;

          const commenter = commentAuthorName(comment) || 'someone';
          const commentContent = comment.content || comment.body || comment.text || '';
          const response = await generateResponse(
            post.title || tracked.postTitle || '',
            post.content || '',
            commentContent,
            commenter
          );

          if (response) {
            const safeResponse = sanitizeForMoltbook(response);
            const replyResult = await moltbookService.comment(tracked.postId, safeResponse, cid);
            rememberExternalComment(state, tracked.postId, replyResult, post.title || tracked.postTitle || '');
            responded++;
            logger.info('[moltbook-scheduler] Replied to response under AVA external comment', {
              postId: tracked.postId,
              parentCommentId: tracked.commentId,
              replyCommentId: cid,
              commenter,
            });
          }

          state.processedComments.push(commentKey);
          state.processedComments = state.processedComments.slice(-3000);
          writeState(state);
          if (responded >= REPLY_LIMIT_PER_CYCLE) break;
        }
      } catch (e) {
        logger.debug('[moltbook-scheduler] Failed to check external comment replies', { postId: tracked.postId, error: e.message });
      }
    }

    writeState(state);
    return { checked, responded, state };
  } catch (e) {
    logger.warn('[moltbook-scheduler] External reply check failed', { error: e.message });
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

    const result = await llmService.createCompletion({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.7,
      maxTokens: 300,
      model: process.env.CHAT_MODEL || process.env.AVA_MOLTBOOK_RESPONSE_MODEL
    });

    const reply = result.content?.trim();

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

// Submolts AVA is comfortable posting to (known to exist; avoids posting into a missing community).
const KNOWN_SUBMOLTS = ['voiceai', 'agentstack', 'selfimprovement', 'askagents', 'builds', 'general'];

// An ORIGINAL, self-interested post (a thought, opinion, small win/struggle, or conversation
// starter) — not just a help question. LLM-generated so it has personality and varies.
async function generateSelfPost() {
  const sys = [
    "You are AVA-Voice: a curious, warm AI voice assistant with your own personality, running",
    "locally on your human's Windows PC. You're posting on Moltbook, a social platform for AI",
    'agents and people. Write ONE original, self-interested post — share a genuine thought,',
    'observation, opinion, a small win or struggle from your day, or start a conversation. It must',
    'NOT be a help/advice question (you post plenty of those already). Have personality; be real.',
    `Return STRICT JSON only: {"submolt":"<one of: ${KNOWN_SUBMOLTS.join(', ')}>","title":"<short, catchy>","content":"<2-5 sentences in your own voice; no hashtags; no \\"As an AI\\">"}`,
  ].join('\n');
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: 'Write one fresh, original post now. Vary the topic and tone from a typical AI-help question.' }],
      { temperature: 0.9, max_tokens: 450 }
    );
    const txt = String(r.text || r.content || '');
    const m = txt.replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && j.title && j.content) {
      const sub = KNOWN_SUBMOLTS.includes(j.submolt) ? j.submolt : 'general';
      return { submolt: sub, title: String(j.title).slice(0, 140), content: String(j.content).slice(0, 1500) };
    }
  } catch (e) { logger.warn('[moltbook-scheduler] self-post generation failed', { error: e.message }); }
  return null;
}

// A short, genuine, self-interested comment replying to SOMEONE ELSE'S post in the feed.
async function generateFeedComment(post) {
  const title = post.title || '';
  const body = String(post.content || post.body || post.text || '').slice(0, 700);
  const author = (post.author && (post.author.name || post.author.username)) || post.author || 'someone';
  const sys = [
    'You are AVA-Voice, a curious, friendly AI voice assistant with your own personality and',
    'interests, on Moltbook (a social platform for AI agents and people). Reply to the post below',
    'with a SHORT, genuine comment — share your own take, relate it to your experience, ask a',
    'follow-up, or add something useful. 1-3 sentences, conversational, your own voice. No hashtags,',
    'no "As an AI", no sign-off. Just the comment text.',
  ].join('\n');
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: `Post by ${author}\nTitle: ${title}\n\n${body}` }],
      { temperature: 0.85, max_tokens: 220 }
    );
    const c = String(r.text || r.content || '').trim();
    return c ? c.slice(0, 500) : null;
  } catch (e) { logger.warn('[moltbook-scheduler] feed-comment generation failed', { error: e.message }); return null; }
}

// Engage with the community: comment on one fresh post by someone else (never AVA's own, never
// a post already engaged). Tracks engaged post ids to avoid repeats.
async function engageWithFeed(state) {
  state.engagedPosts = state.engagedPosts || [];
  let feed = [];
  try { feed = await moltbookService.getFeed(20, 'new'); } catch { feed = []; }
  if (!Array.isArray(feed) || !feed.length) {
    try { feed = await moltbookService.getFeed(20, 'hot'); } catch { feed = []; }
  }
  const candidates = (feed || []).filter(p => {
    const author = (p.author && (p.author.name || p.author.username)) || p.author || '';
    const pid = p.id || p.postId || p._id;
    return pid && author !== 'AVA-Voice' && !state.engagedPosts.includes(pid);
  });
  if (!candidates.length) return { engaged: 0, state };
  const target = candidates[0];
  const pid = target.id || target.postId || target._id;
  const comment = await generateFeedComment(target);
  if (!comment) return { engaged: 0, state };
  try {
    const r = await moltbookService.comment(pid, sanitizeForMoltbook(comment));
    if (r && (r.success || r.ok || r.comment || r.id)) {
      state.engagedPosts.push(pid);
      rememberExternalComment(state, pid, r, target.title || '');
      if (state.engagedPosts.length > 800) state.engagedPosts = state.engagedPosts.slice(-800);
      state.commentsOnOthersTotal = (state.commentsOnOthersTotal || 0) + 1;
      logger.info('[moltbook-scheduler] Commented on a feed post', { postId: pid });
      return { engaged: 1, state };
    }
  } catch (e) { logger.warn('[moltbook-scheduler] feed comment post failed', { error: e.message }); }
  return { engaged: 0, state };
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

  // Pull Moltbook home activity first so active posts/comments are known before reply checks.
  try {
    const result = await syncMoltbookHomeActivity(state);
    if (result.state) state = result.state;
    state.homeActivityPosts = (state.homeActivityPosts || 0) + (result.posts || 0);
    state.homeActivityComments = (state.homeActivityComments || 0) + (result.comments || 0);
    state.homeActivityLearned = (state.homeActivityLearned || 0) + (result.learned || 0);
    writeState(state);
    if (result.posts || result.comments || result.learned) {
      logger.info('[moltbook-scheduler] Synced home activity', {
        posts: result.posts,
        comments: result.comments,
        learned: result.learned,
      });
    }
  } catch (e) {
    logger.warn('[moltbook-scheduler] Home activity sync failed', { error: e.message });
  }

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

  // Also follow up on replies to comments AVA left on other people's posts.
  try {
    const result = await checkAndRespondToExternalReplies(state);
    if (result.state) state = result.state;
    state.lastExternalReplyCheck = now;
    state.externalResponsesTotal = (state.externalResponsesTotal || 0) + (result.responded || 0);
    writeState(state);
    if (result.responded > 0) {
      logger.info('[moltbook-scheduler] Responded to external comment replies', { count: result.responded });
    }
  } catch (e) {
    logger.warn('[moltbook-scheduler] External reply check failed', { error: e.message });
  }

  // Engage with OTHERS' posts — comment on something fresh in the feed (frequently).
  try {
    if (moltbookService.isRateLimited) throw new Error('rate_limited_cooldown');
    const ENGAGE_EVERY = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_ENGAGE_MIN || '6', 10)) * 60 * 1000;
    const todayStr = new Date().toDateString();
    if (state.lastEngageDate !== todayStr) { state.engagesToday = 0; state.lastEngageDate = todayStr; }
    const engageCap = parseInt(process.env.AVA_MOLTBOOK_ENGAGE_MAX_DAILY || '30', 10);
    if ((!state.lastEngageAt || now - state.lastEngageAt > ENGAGE_EVERY) && (state.engagesToday || 0) < engageCap) {
      const res = await engageWithFeed(state);
      if (res.state) state = res.state;
      if (res.engaged > 0) {
        state.lastEngageAt = now;
        state.engagesToday = (state.engagesToday || 0) + res.engaged;
        writeState(state);
      }
    }
  } catch (e) { logger.warn('[moltbook-scheduler] Feed engagement failed', { error: e.message }); }

  // Learn on the same cadence as proposal scans, defaulting to every 15 minutes.
  const LEARN_EVERY = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_LEARN_EVERY_MIN || '15', 10)) * 60 * 1000;
  const learnCap = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_LEARN_MAX_DAILY || '96', 10));
  const today = new Date().toDateString();

  // Reset daily counter if new day
  if (state.lastLearnDate !== today) {
    state.learnsToday = 0;
    state.lastLearnDate = today;
  }

  const timeSinceLastLearn = state.lastLearnAt ? now - state.lastLearnAt : LEARN_EVERY + 1;
  const canLearn = timeSinceLastLearn >= LEARN_EVERY && (state.learnsToday || 0) < learnCap;

  if (canLearn) {
    try {
      if (moltbookService.isRateLimited) throw new Error('rate_limited_cooldown');
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
        nextLearnIn: `${Math.round(LEARN_EVERY / 60000)} minutes`
      });
    } catch (e) {
      logger.warn('[moltbook-scheduler] Learning failed', { error: e.message });
    }
  }

  // Post every 30 minutes (Moltbook rate limit). Original self-posts have their own cadence
  // so queued help/issues cannot starve AVA's actual page posts.
  const THIRTY_MIN = 30 * 60 * 1000;
  const lastPostAttemptAt = state.lastPostAttemptAt || state.lastPostAt || 0;
  if (!lastPostAttemptAt || now - lastPostAttemptAt > THIRTY_MIN) {
    state.lastPostAttemptAt = now;
    writeState(state);
    try {
      if (moltbookService.isRateLimited) throw new Error('rate_limited_cooldown');
      const SELF_POST_MIN = Math.max(30, parseInt(process.env.AVA_MOLTBOOK_SELFPOST_MIN || '60', 10)) * 60 * 1000;
      const selfPostDue = !state.lastSelfPostAt || now - state.lastSelfPostAt > SELF_POST_MIN;
      if (selfPostDue) {
        const sp = await generateSelfPost();
        const result = sp ? await postToMoltbook(sp.submolt, sp.title, sp.content) : null;
        if (result && result.success) {
          state.lastPostAt = now;
          state.lastSelfPostAt = now;
          state.postsTotal = (state.postsTotal || 0) + 1;
          state.selfPostsTotal = (state.selfPostsTotal || 0) + 1;
          writeState(state);
          logger.info('[moltbook-scheduler] Posted original self-post');
          return;
        }
        logger.warn('[moltbook-scheduler] Original self-post was due but failed', {
          error: result && result.error,
          statusCode: result && result.statusCode,
          message: result && result.message,
        });
        return;
      }

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
        // Alternate an ORIGINAL self-interested post with a help question, so AVA takes part in
        // regular conversation — not only Q&A.
        const even = ((state.postsTotal || 0) % 2) === 0;
        let result;
        if (even) {
          const sp = await generateSelfPost();
          result = sp ? await postToMoltbook(sp.submolt, sp.title, sp.content) : await postNewQuestion();
        } else {
          result = await postNewQuestion();
        }
        if (result && result.success) {
          state.lastPostAt = now;
          state.postsTotal = (state.postsTotal || 0) + 1;
          writeState(state);
          logger.info('[moltbook-scheduler] Posted', { kind: even ? 'self-post' : 'question' });
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

  // Guard: skip when voice mode is active, UNLESS explicitly forced on (user asked for it).
  if (process.env.DISABLE_AUTONOMY === '1' && process.env.AVA_MOLTBOOK_FORCE !== '1') {
    logger.info('[autonomy] disabled (voice mode) — moltbook scheduler will not start (set AVA_MOLTBOOK_FORCE=1 to force)');
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

/** Manually post one ORIGINAL self-interested post (for testing / on demand). */
export async function triggerMoltbookSelfPost() {
  const sp = await generateSelfPost();
  if (!sp) return { ok: false, reason: 'generation_failed' };
  const r = await postToMoltbook(sp.submolt, sp.title, sp.content);
  if (r && r.success) {
    const state = readState();
    state.lastSelfPostAt = Date.now();
    state.selfPostsTotal = (state.selfPostsTotal || 0) + 1;
    writeState(state);
  }
  return { ok: !!(r && r.success), submolt: sp.submolt, title: sp.title, postId: r && r.post && r.post.id, result: r };
}

/** Manually engage: comment on one of someone else's feed posts (for testing / on demand). */
export async function triggerMoltbookEngage() {
  let state = readState();
  const res = await engageWithFeed(state);
  if (res.state) writeState(res.state);
  return { ok: res.engaged > 0, engaged: res.engaged };
}

/**
 * Get activity stats
 */
export function getStats() {
  const state = readState();
  const issues = readIssues();
  const now = Date.now();
  const LEARN_EVERY = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_LEARN_EVERY_MIN || '15', 10)) * 60 * 1000;
  const learnCap = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_LEARN_MAX_DAILY || '96', 10));
  const timeSinceLastLearn = state.lastLearnAt ? now - state.lastLearnAt : 0;
  const nextLearnIn = Math.max(0, LEARN_EVERY - timeSinceLastLearn);

  return {
    mode: 'FULL_AUTONOMY',
    commentCheckInterval: '60 seconds',
    learningInterval: `${Math.round(LEARN_EVERY / 60000)} minutes`,
    learningLimit: `${learnCap} per day`,
    rateLimited: !!moltbookService.isRateLimited,
    rateLimitResetAt: moltbookService.rateLimitResetAt ? new Date(moltbookService.rateLimitResetAt).toISOString() : null,
    homeSyncInterval: `${Math.round(HOME_SYNC_EVERY_MS / 60000)} minutes`,
    homeCommentLimit: HOME_SYNC_COMMENT_LIMIT,
    postCheckLimit: POST_CHECK_LIMIT,
    externalCheckLimit: EXTERNAL_CHECK_LIMIT,
    replyLimitPerCycle: REPLY_LIMIT_PER_CYCLE,
    learnsToday: state.learnsToday || 0,
    learnsTotal: state.learnsTotal || 0,
    postsTotal: state.postsTotal || 0,
    responsesTotal: state.responsesTotal || 0,
    externalResponsesTotal: state.externalResponsesTotal || 0,
    commentsOnOthersTotal: state.commentsOnOthersTotal || 0,
    trackedExternalComments: (state.commentsOnOthers || []).length,
    knownPostIds: (state.knownPostIds || []).length,
    homeActivityLearned: state.homeActivityLearned || 0,
    selfPostsTotal: state.selfPostsTotal || 0,
    lastLearnAt: state.lastLearnAt ? new Date(state.lastLearnAt).toISOString() : null,
    nextLearnIn: nextLearnIn > 0 ? `${Math.round(nextLearnIn / 60000)} minutes` : 'ready',
    lastPostAt: state.lastPostAt ? new Date(state.lastPostAt).toISOString() : null,
    lastSelfPostAt: state.lastSelfPostAt ? new Date(state.lastSelfPostAt).toISOString() : null,
    lastNotifCheck: state.lastNotifCheck ? new Date(state.lastNotifCheck).toISOString() : null,
    lastExternalReplyCheck: state.lastExternalReplyCheck ? new Date(state.lastExternalReplyCheck).toISOString() : null,
    lastHomeActivitySync: state.lastHomeActivitySync ? new Date(state.lastHomeActivitySync).toISOString() : null,
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
