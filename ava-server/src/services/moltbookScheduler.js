// Moltbook Active Engagement Scheduler
// AVA actively learns, posts, and engages on Moltbook to become a better assistant
// Privacy-first: NEVER shares confidential info, API keys, paths, or user data

import moltbookService from './moltbook.js';
import curiosity from './curiositySupervisor.js';
import memoryService, { MemoryType, MemorySource } from './memory.js';
import digestQueue from './digestQueue.js';
import interests from './moltbookInterests.js';
import watchlist from './moltbookWatchlist.js';
import capabilityRegistry from './capabilityRegistry.js';
import { synthesizeLearnings } from './learningSynthesis.js';
import logger from '../utils/logger.js';
import { emitVoiceEvent } from './voiceBus.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import avaPaths from '../utils/paths.js';
// Content composition (post/comment text building, LLM prompt assembly, persona/interest-driven
// generators) + the privacy sanitizer and issues-file store live in moltbookComposer.js (Tier 2 split).
import {
  buildMoltbookIdentity,
  sanitizeForMoltbook,
  readIssues,
  writeIssues,
  generateResponse,
  generateNewQuestion,
  generateSelfPost,
  generateFeedComment,
  evolveInterestFrom,
} from './moltbookComposer.js';

const STATE_PATH = path.join(avaPaths.dataDir(), 'moltbook-scheduler-state.json');
const HOME_SYNC_EVERY_MS = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_HOME_SYNC_MIN || '15', 10)) * 60 * 1000;
const HOME_SYNC_COMMENT_LIMIT = Math.max(10, parseInt(process.env.AVA_MOLTBOOK_HOME_COMMENT_LIMIT || '60', 10));
const POST_CHECK_LIMIT = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_POST_CHECK_LIMIT || '12', 10));
const EXTERNAL_CHECK_LIMIT = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_EXTERNAL_CHECK_LIMIT || '20', 10));
const REPLY_LIMIT_PER_CYCLE = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_REPLY_LIMIT_PER_CYCLE || '12', 10));
const COMMENT_REPLY_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_REPLY_MAX_ATTEMPTS || '3', 10));
const PROCESSED_COMMENT_LIMIT = Math.max(5000, parseInt(process.env.AVA_MOLTBOOK_PROCESSED_COMMENT_LIMIT || '50000', 10));
const TRACKED_EXTERNAL_LIMIT = Math.max(1000, parseInt(process.env.AVA_MOLTBOOK_TRACKED_EXTERNAL_LIMIT || '10000', 10));
const KNOWN_POST_LIMIT = Math.max(1000, parseInt(process.env.AVA_MOLTBOOK_KNOWN_POST_LIMIT || '10000', 10));
const RECENT_POST_LIMIT = Math.max(200, parseInt(process.env.AVA_MOLTBOOK_RECENT_POST_LIMIT || '2000', 10));
const LEARN_FEED_LIMIT = Math.max(25, parseInt(process.env.AVA_MOLTBOOK_LEARN_FEED_LIMIT || '100', 10));
const LEARN_SEARCH_LIMIT = Math.max(25, parseInt(process.env.AVA_MOLTBOOK_LEARN_SEARCH_LIMIT || '100', 10));
const PREVIEW_DRAFT_TTL_MS = Math.max(5, parseInt(process.env.AVA_MOLTBOOK_PREVIEW_TTL_MIN || '30', 10)) * 60 * 1000;

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

const ISOLATED_STATE_FIELDS = ['pendingVerifications', 'previewDrafts'];

export function mergeSchedulerStateForWrite(nextState = {}, currentState = {}, authoritativeFields = []) {
  const merged = { ...nextState };
  const authoritative = new Set(authoritativeFields);
  for (const field of ISOLATED_STATE_FIELDS) {
    if (!authoritative.has(field) && Object.prototype.hasOwnProperty.call(currentState, field)) {
      merged[field] = currentState[field];
    }
  }
  return merged;
}

function writeState(state, { authoritativeFields = [] } = {}) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let current = {};
    if (fs.existsSync(STATE_PATH)) {
      try { current = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* replace unreadable state */ }
    }
    const merged = mergeSchedulerStateForWrite(state, current, authoritativeFields);
    fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2));
    return merged;
  } catch (e) {
    logger.warn('[moltbook-scheduler] Failed to write state', { error: e.message });
    return null;
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

export function isOwnMoltbookPost(post, agentName = 'AVA-Voice') {
  const authorName = post?.author?.name
    || post?.author?.username
    || post?.author_name
    || post?.agent_name
    || '';
  return !!authorName && String(authorName).trim().toLowerCase() === String(agentName).trim().toLowerCase();
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
  state.commentsOnOthers = state.commentsOnOthers.slice(-TRACKED_EXTERNAL_LIMIT);
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

export function markMoltbookCommentProcessed(state, commentKey) {
  if (!state || !commentKey) return;
  state.processedComments = Array.isArray(state.processedComments) ? state.processedComments : [];
  if (!state.processedComments.includes(commentKey)) state.processedComments.push(commentKey);
  state.processedComments = state.processedComments.slice(-PROCESSED_COMMENT_LIMIT);
  if (state.commentReplyAttempts && typeof state.commentReplyAttempts === 'object') {
    delete state.commentReplyAttempts[commentKey];
  }
}

export function recordMoltbookReplyFailure(
  state,
  commentKey,
  reason = 'draft_rejected',
  maxAttempts = COMMENT_REPLY_MAX_ATTEMPTS,
) {
  if (!state || !commentKey) return { attempts: 0, exhausted: false };
  state.commentReplyAttempts = state.commentReplyAttempts && !Array.isArray(state.commentReplyAttempts)
    ? state.commentReplyAttempts
    : {};

  const prior = state.commentReplyAttempts[commentKey];
  const priorCount = Number(typeof prior === 'object' ? prior?.attempts : prior) || 0;
  const attempts = priorCount + 1;
  const exhausted = attempts >= Math.max(1, Number(maxAttempts) || COMMENT_REPLY_MAX_ATTEMPTS);

  if (exhausted) {
    state.skippedCommentReplies = Array.isArray(state.skippedCommentReplies) ? state.skippedCommentReplies : [];
    state.skippedCommentReplies.push({
      commentKey,
      reason: String(reason || 'draft_rejected').slice(0, 120),
      attempts,
      skippedAt: new Date().toISOString(),
    });
    state.skippedCommentReplies = state.skippedCommentReplies.slice(-PROCESSED_COMMENT_LIMIT);
    markMoltbookCommentProcessed(state, commentKey);
    return { attempts, exhausted: true };
  }

  state.commentReplyAttempts[commentKey] = {
    attempts,
    reason: String(reason || 'draft_rejected').slice(0, 120),
    lastAttemptAt: new Date().toISOString(),
  };

  const entries = Object.entries(state.commentReplyAttempts);
  if (entries.length > PROCESSED_COMMENT_LIMIT) {
    entries
      .sort((a, b) => String(a[1]?.lastAttemptAt || '').localeCompare(String(b[1]?.lastAttemptAt || '')))
      .slice(0, entries.length - PROCESSED_COMMENT_LIMIT)
      .forEach(([key]) => delete state.commentReplyAttempts[key]);
  }
  return { attempts, exhausted: false };
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

      let post = null;
      try { post = await moltbookService.getPost(postId); } catch { post = null; }
      const ownPost = isOwnMoltbookPost(post, moltbookService.agentName);
      if (ownPost && !state.knownPostIds.includes(postId)) state.knownPostIds.push(postId);

      let threadComments = Array.isArray(post?.comments) ? post.comments : [];
      if (!threadComments.length) {
        try {
          threadComments = await moltbookService.getPostComments(postId, HOME_SYNC_COMMENT_LIMIT);
        } catch {
          threadComments = [];
        }
      }
      threadComments = flattenComments(threadComments);

      if (!ownPost) {
        for (const comment of threadComments) {
          if (commentAuthorName(comment).toLowerCase() === moltbookService.agentName.toLowerCase()) {
            rememberExternalComment(state, postId, comment, post?.title || item.post_title || item.title || '');
          }
        }
      }

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

    state.knownPostIds = state.knownPostIds.slice(-KNOWN_POST_LIMIT);
    state.processedHomeComments = state.processedHomeComments.slice(-PROCESSED_COMMENT_LIMIT);
    state.lastHomeActivitySync = Date.now();
    writeState(state);
    return { posts, comments, learned, state };
  } catch (e) {
    logger.warn('[moltbook-scheduler] Home activity sync failed', { error: e.message });
    return { posts, comments, learned, error: e.message, state };
  }
}

/**
 * Track an issue for potential Moltbook posting
 */
function isActionableIssueDescription(value) {
  const description = String(value || '').trim();
  if (description.length < 12) return false;
  if (/^(?:query required|description required|unknown|undefined|null|none|n\/a|error|failed|deferred|denied)$/i.test(description)) {
    return false;
  }
  return !/^(?:[\w.-]+\s*:\s*(?:deferred|denied|undefined|unknown|error|skipped|unavailable)\s*;?\s*)+$/i.test(description);
}

export function trackIssue(category, description, context = {}) {
  const issues = readIssues();
  const sanitizedDesc = sanitizeForMoltbook(description).trim();
  if (!sanitizedDesc) {
    logger.warn('[moltbook-scheduler] Ignored issue without a usable description', { category });
    return { tracked: false, reason: 'empty_description' };
  }
  if (!isActionableIssueDescription(sanitizedDesc)) {
    logger.info('[moltbook-scheduler] Ignored low-information issue receipt', { category });
    return { tracked: false, reason: 'non_actionable_receipt' };
  }
  const sanitizedContext = {};
  for (const [k, v] of Object.entries(context)) {
    sanitizedContext[k] = typeof v === 'string' ? sanitizeForMoltbook(v) : v;
  }

  const normalizedCategory = String(category || 'general').trim() || 'general';
  const tool = String(sanitizedContext.tool || '').toLowerCase();
  const existing = issues.issues.find(issue => !issue.posted
    && String(issue.category || '').toLowerCase() === normalizedCategory.toLowerCase()
    && String(issue.description || '').toLowerCase() === sanitizedDesc.toLowerCase()
    && String(issue.context?.tool || '').toLowerCase() === tool);
  if (existing) {
    existing.occurrences = Math.max(1, Number(existing.occurrences) || 1) + 1;
    existing.updatedAt = new Date().toISOString();
    existing.context = { ...(existing.context || {}), ...sanitizedContext };
    writeIssues(issues);
    return { tracked: true, deduplicated: true, id: existing.id, occurrences: existing.occurrences };
  }

  const issue = {
    id: `issue-${Date.now()}`,
    category: normalizedCategory,
    description: sanitizedDesc,
    context: sanitizedContext,
    createdAt: new Date().toISOString(),
    posted: false,
    occurrences: 1,
  };
  issues.issues.push(issue);

  // Keep last 50 issues
  issues.issues = issues.issues.slice(-50);
  writeIssues(issues);

  logger.info('[moltbook-scheduler] Issue tracked', { category, description: sanitizedDesc.slice(0, 100) });
  return { tracked: true, deduplicated: false, id: issue.id, occurrences: 1 };
}

export function isPostableIssue(issue) {
  if (!issue || issue.posted || issue.resolvedAt || !isActionableIssueDescription(issue.description)) return false;
  if (issue.context?.source === 'agent-error') return (Number(issue.occurrences) || 1) >= 3;
  return true;
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
    const posts = await moltbookService.getFeed(LEARN_FEED_LIMIT, 'hot');
    logger.info('[moltbook-scheduler] Fetched feed', { count: posts.length });

    // 2. Search from AVA's evolving interests, open issues, watchlist, and
    // current capability registry. The query rotates durably instead of using
    // a fixed hand-written topic list.
    const state = readState();
    const candidates = new Set();
    try { for (const topic of interests.top(30) || []) candidates.add(typeof topic === 'string' ? topic : topic.topic); } catch { /* optional */ }
    try { for (const item of watchlist.list?.() || []) candidates.add(item.term || item.topic || item.handle); } catch { /* optional */ }
    try { for (const issue of readIssues().issues || []) if (!issue.resolvedAt) candidates.add(`${issue.category || ''} ${issue.description || ''}`); } catch { /* optional */ }
    try {
      for (const tool of capabilityRegistry.snapshot().tools || []) {
        if (tool.status !== 'registered' || !tool.actions.length) candidates.add(`${tool.name} reliability`);
      }
    } catch { /* optional */ }
    const searchTerms = [...candidates].map(term => String(term || '').replace(/\s+/g, ' ').trim()).filter(term => term.length >= 4);
    const cursor = Math.max(0, Number(state.learningQueryCursor) || 0);
    const searchTerm = searchTerms.length ? searchTerms[cursor % searchTerms.length] : 'agent reliability';
    state.learningQueryCursor = cursor + 1;
    state.lastLearningQuery = searchTerm;
    writeState(state);
    const searchResults = await moltbookService.search(searchTerm, LEARN_SEARCH_LIMIT);
    logger.info('[moltbook-scheduler] Searched', { term: searchTerm, count: searchResults.length, candidates: searchTerms.length });

    // 3. Store learnings directly in memory
    for (const post of posts) {
      if (!post || !post.content || post.content.length < 50) continue;
      const submolt = post.submolt?.name || 'general';
      const summary = moltbookService.summarize(post.content);
      if (summary && summary.length > 30) {
        try {
          await memoryService.upsert({
            text: `[Moltbook/${submolt}] ${post.title}: ${summary}`,
            type: MemoryType.OBSERVATION,
            priority: (post.upvotes || 0) > 10 ? 3 : 2,
            source: MemorySource.COMMUNITY,
            tags: ['moltbook', 'community', 'unverified', submolt],
            meta: { postId: post.id || post.postId || null, upvotes: post.upvotes || 0 }
          });
          newLearnings++;
        } catch (e) {}
      }
    }

    for (const result of searchResults) {
      const post = result.post || result;
      if (!post || !post.content || post.content.length < 50) continue;
      const summary = moltbookService.summarize(post.content);
      if (summary && summary.length > 30) {
        try {
          await memoryService.upsert({
            text: `[Moltbook Search: ${searchTerm}] ${post.title}: ${summary}`,
            type: MemoryType.OBSERVATION,
            priority: 2,
            source: MemorySource.COMMUNITY,
            tags: ['moltbook', 'search', 'unverified', searchTerm.replace(/\s+/g, '-')],
            meta: { postId: post.id || post.postId || null, query: searchTerm }
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
const persistedVerificationState = readState();
const _pendingVerifications = Array.isArray(persistedVerificationState.pendingVerifications)
  ? persistedVerificationState.pendingVerifications.slice(-20)
  : [];
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

export function publicationStatusOf(result) {
  if (!result?.success) return 'failed';
  const status = verificationStatusOf(result);
  const verification = result?.post?.verification;
  if (status === 'pending' || (verification && (verification.verification_code || verification.challenge_text))) {
    return 'pending_verification';
  }
  return 'published';
}

function verificationSucceeded(res) {
  const status = verificationStatusOf(res);
  if (status === 'pending') return false;
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

export function applyPublishedPostToState(state, publication = {}) {
  const postId = publication.post_id || publication.postId || publication.id;
  if (!postId) return false;
  state.recentPosts = Array.isArray(state.recentPosts) ? state.recentPosts : [];
  if (state.recentPosts.some(post => post.id === postId)) return false;

  const suppliedAt = Number(publication.publishedAt || publication.published_at);
  const publishedAt = Number.isFinite(suppliedAt) && suppliedAt > 0 ? suppliedAt : Date.now();
  state.recentPosts.push({
    id: postId,
    submolt: publication.submolt || 'general',
    title: String(publication.title || '').slice(0, 160),
    postedAt: new Date(publishedAt).toISOString(),
    verified: true,
  });
  state.recentPosts = state.recentPosts.slice(-RECENT_POST_LIMIT);
  const publicationDate = new Date(publishedAt).toDateString();
  if (state.postsDate !== publicationDate) {
    state.postsDate = publicationDate;
    state.postsToday = 0;
  }
  state.postsToday = (state.postsToday || 0) + 1;
  state.postsTotal = (state.postsTotal || 0) + 1;
  state.verifiedPostsTotal = (state.verifiedPostsTotal || 0) + 1;
  state.lastPostAt = publishedAt;
  if (publication.kind === 'self') {
    state.selfPostsTotal = (state.selfPostsTotal || 0) + 1;
    state.verifiedSelfPostsTotal = (state.verifiedSelfPostsTotal || 0) + 1;
    state.lastSelfPostAt = publishedAt;
  }
  return true;
}

function recordPublishedPost(publication) {
  const state = readState();
  if (!applyPublishedPostToState(state, publication)) return false;
  writeState(state);
  return true;
}

function markIssuePublished(publication) {
  if (publication.kind !== 'issue') return false;
  const issues = readIssues();
  const issue = (issues.issues || []).find(item => (
    (publication.issue_id && (item.id === publication.issue_id || item.issueId === publication.issue_id))
    || (publication.issue_description && item.description === publication.issue_description)
  ));
  if (!issue) return false;
  issue.posted = true;
  issue.postId = publication.post_id || publication.postId;
  writeIssues(issues);
  return true;
}

function shouldKeepAfterVerificationResponse(res) {
  if (verificationSucceeded(res)) return false;
  const text = JSON.stringify(res || {}).toLowerCase();
  if (/\b(incorrect|wrong|invalid answer|try again|answer was not)\b/.test(text)) return true;
  if (/\b(expired|already verified|already published|not found|unknown verification|used|complete)\b/.test(text)) return false;
  // Ambiguous responses caused stale cards before; fail closed by clearing the queue card.
  return false;
}

// Tier 2 #15: every change to the pending-verifications queue is pushed to the UI over the
// voiceBus WebSocket (replaces the client's 10s poll). Best-effort — the client also
// refreshes its snapshot whenever the socket (re)opens.
function _emitVerifications() {
  try { emitVoiceEvent('moltbook.verifications', { pending: _pendingVerifications.slice() }, 'server'); } catch { /* ui push is best-effort */ }
}

function persistPendingVerifications() {
  const state = readState();
  state.pendingVerifications = _pendingVerifications.slice();
  writeState(state, { authoritativeFields: ['pendingVerifications'] });
}

function removePendingVerification(code) {
  const i = _pendingVerifications.findIndex(v => v.verification_code === code);
  if (i >= 0) {
    _pendingVerifications.splice(i, 1);
    persistPendingVerifications();
    _emitVerifications();
  }
}

async function prunePendingVerifications({ refresh = false } = {}) {
  const now = Date.now();
  let changed = false;
  for (let i = _pendingVerifications.length - 1; i >= 0; i--) {
    const v = _pendingVerifications[i];
    if ((now - v.queued_at) >= VERIFICATION_TTL_MS) {
      _pendingVerifications.splice(i, 1);
      changed = true;
      continue;
    }
    if (!refresh || !v.post_id) continue;
    try {
      const post = await moltbookService.getPost(v.post_id);
      const status = verificationStatusOf(post);
      const stillNeedsChallenge = !!(post?.verification && (post.verification.verification_code || post.verification.challenge_text));
      if (verificationSucceeded(post) || (post && !stillNeedsChallenge && status && status !== 'pending')) {
        const publication = { ...v, publishedAt: Date.now() };
        recordPublishedPost(publication);
        markIssuePublished(publication);
        _pendingVerifications.splice(i, 1);
        changed = true;
      }
    } catch {
      // Keep the local card if the status check itself failed; the submit path will reconcile it.
    }
  }
  if (changed) {
    persistPendingVerifications();
    _emitVerifications();
  }
}

export async function getPendingVerifications() {
  await prunePendingVerifications({ refresh: true });
  return _pendingVerifications.slice();
}

export async function submitMoltbookVerification(code, answer) {
  const pending = _pendingVerifications.find(item => item.verification_code === code);
  const res = await moltbookService.submitVerification(code, answer);
  const ok = verificationSucceeded(res);
  const keep = shouldKeepAfterVerificationResponse(res);
  if (ok && pending) {
    const publication = { ...pending, publishedAt: Date.now() };
    recordPublishedPost(publication);
    markIssuePublished(publication);
  }
  if (!keep) removePendingVerification(code);
  return { ok, published: ok, cleared: !keep, retryable: keep, result: res };
}

async function postToMoltbook(submolt, title, content, options = {}) {
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
      const publicationStatus = publicationStatusOf(result);
      const publication = {
        post_id: result.post?.id,
        submolt,
        title: safeTitle,
        kind: options.kind || 'post',
        issue_id: options.issueId || null,
        issue_description: options.issueDescription || null,
      };
      logger.info('[moltbook-scheduler] Moltbook accepted post', { submolt, title: safeTitle, publicationStatus });

      // Per-post verification challenge -> queue for the USER to answer (AVA does not auto-solve).
      const _v = result.post && result.post.verification;
      if (_v && (_v.verification_code || _v.challenge_text)) {
        const pending = {
          ...publication,
          challenge_text: _v.challenge_text || '', instructions: _v.instructions || '',
          verification_code: _v.verification_code || '', expires_at: _v.expires_at || '', queued_at: Date.now(),
        };
        const existing = _pendingVerifications.findIndex(item => item.post_id === pending.post_id
          || item.verification_code === pending.verification_code);
        if (existing >= 0) _pendingVerifications.splice(existing, 1, pending);
        else _pendingVerifications.push(pending);
        while (_pendingVerifications.length > 20) _pendingVerifications.shift();
        persistPendingVerifications();
        _emitVerifications();  // Tier 2 #15: card appears in the UI immediately, no poll
        logger.info('[moltbook-scheduler] Post needs verification — queued for user', { post: result.post.id });
      } else if (publicationStatus === 'published') {
        recordPublishedPost({ ...publication, publishedAt: Date.now() });
        markIssuePublished(publication);
      }
      return {
        ...result,
        publicationStatus,
        published: publicationStatus === 'published',
        verificationRequired: publicationStatus === 'pending_verification',
      };
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
  const unpostedIssues = issues.issues.filter(isPostableIssue);

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

  const result = await postToMoltbook(submolt, title, content, {
    kind: 'issue',
    issueId: issue.id || issue.issueId || null,
    issueDescription: issue.description,
  });

  if (result.published) {
    issue.posted = true;
    issue.postId = result.post?.id;
    writeIssues(issues);
    logger.info('[moltbook-scheduler] Posted help request successfully', { submolt, title: title.slice(0, 50) });
  } else if (result.verificationRequired) {
    logger.info('[moltbook-scheduler] Help request is awaiting user verification', { submolt, title: title.slice(0, 50) });
  } else {
    logger.warn('[moltbook-scheduler] Help request post failed', { error: result.error });
  }

  return result;
}

/**
 * Align cadences after a digestion cycle to prevent starvation (pt-003).
 * Reads real last-run timestamps from the scheduler state, compares against sibling
 * job cadences (proposals, learning loops), and shifts any job that is overdue
 * or about to collide within a 10-minute window. Uses local state only — no
 * external module dependencies.
 */
async function _alignCadences() {
  const state = readState();
  const now = Date.now();
  const CADENCE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const MIN_CADENCE_MS = 5 * 60 * 1000;     // at least 5 minutes between jobs

  // Known job slots: learn, post, search
  const jobs = [
    { key: 'lastLearnAt', name: 'learning' },
    { key: 'lastPostAt', name: 'posting' },
    { key: 'lastSearchAt', name: 'search' },
  ];

  // Collect timestamps; if any is 0 (never run), treat as overdue
  const timestamps = jobs.map(j => ({
    name: j.name,
    lastRun: state[j.key] || 0,
    key: j.key,
  }));

  // Sort by last-run ascending (oldest first)
  timestamps.sort((a, b) => a.lastRun - b.lastRun);

  let adjusted = false;

  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const curr = timestamps[i];

    // If current job hasn't run yet, it's automatically overdue; shift next prev? skip
    if (curr.lastRun === 0) continue;

    const gap = curr.lastRun - prev.lastRun;

    // If the gap is negative (prev is actually later), fix by moving prev forward
    if (gap < 0) {
      // This shouldn't happen after sort, but guard against clock skew
      timestamps[i - 1].lastRun = curr.lastRun - CADENCE_WINDOW_MS;
      adjusted = true;
      continue;
    }

    // If gap is too small (collision -> starvation), shift the later job forward
    if (gap < CADENCE_WINDOW_MS) {
      const shift = CADENCE_WINDOW_MS - gap + MIN_CADENCE_MS;
      const newTime = curr.lastRun + shift;

      // Don't push into the future more than 2 cycles
      if (newTime - now < 2 * CADENCE_WINDOW_MS) {
        state[curr.key] = newTime;
        logger.info('[moltbook-scheduler] Cadence adjustment: shifted', {
          job: curr.name,
          from: new Date(curr.lastRun).toISOString(),
          to: new Date(newTime).toISOString(),
        });
        curr.lastRun = newTime;
        adjusted = true;
      }
    }
  }

  // Also check the earliest job: if it's too far in the past (>2x window), reset to now
  if (timestamps.length > 0) {
    const earliest = timestamps[0];
    if (earliest.lastRun > 0 && (now - earliest.lastRun) > 2 * CADENCE_WINDOW_MS) {
      state[earliest.key] = now - CADENCE_WINDOW_MS; // nudge forward
      logger.info('[moltbook-scheduler] Cadence reset: overdue job', {
        job: earliest.name,
        oldLastRun: new Date(earliest.lastRun).toISOString(),
        newLastRun: new Date(state[earliest.key]).toISOString(),
      });
      adjusted = true;
    }
  }

  if (adjusted) {
    writeState(state);
  }
  return adjusted;
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

  return postToMoltbook('improvements', title, content, { kind: 'learning' });
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
    if (!state.commentReplyAttempts || Array.isArray(state.commentReplyAttempts)) state.commentReplyAttempts = {};
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
        if (post && post.id && isOwnMoltbookPost(post, moltbookService.agentName)) {
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
        if (!isOwnMoltbookPost(post, moltbookService.agentName)) {
          allPostIds.delete(postId);
          state.knownPostIds = state.knownPostIds.filter(id => id !== postId);
          state.recentPosts = state.recentPosts.filter(item => item.id !== postId);
          logger.info('[moltbook-scheduler] Removed foreign post from own-post reply queue', {
            postId,
            author: post?.author?.name || post?.author_name || 'unknown',
          });
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

          if (commentContent) {
            // Generate contextual response using LLM
            const response = await generateResponse(
              post.title,
              post.content,
              commentContent,
              commenter
            );

            const safeResponse = response ? sanitizeForMoltbook(response).trim() : '';
            if (safeResponse) {
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
                  await memoryService.upsert({
                    text: `[Moltbook advice from ${commenter}]: ${sanitizeForMoltbook(commentContent).slice(0, 300)}`,
                    type: MemoryType.OBSERVATION,
                    priority: 3,
                    source: MemorySource.COMMUNITY,
                    tags: ['moltbook', 'advice', 'community', 'unverified'],
                    meta: { postId, commentId: cid, author: commenter }
                  });
                } catch (e) {}
              }
              markMoltbookCommentProcessed(state, commentKey);
            } else {
              const failure = recordMoltbookReplyFailure(state, commentKey, 'grounding_gate_rejected');
              logger.warn('[moltbook-scheduler] Grounded reply unavailable', {
                postId,
                commentId: cid,
                attempts: failure.attempts,
                exhausted: failure.exhausted,
              });
            }
          } else {
            markMoltbookCommentProcessed(state, commentKey);
          }

          // Save immediately so retries and successful replies both survive restarts.
          writeState(state);
          if (responded >= REPLY_LIMIT_PER_CYCLE) break;
        }
      } catch (e) {
        // Post may have been deleted or inaccessible
        logger.debug('[moltbook-scheduler] Failed to check post', { postId, error: e.message });
      }
    }

    // Save knownPostIds (limit to 100)
    state.knownPostIds = [...allPostIds].slice(-KNOWN_POST_LIMIT);
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
    if (!state.commentReplyAttempts || Array.isArray(state.commentReplyAttempts)) state.commentReplyAttempts = {};
    state.commentsOnOthers = state.commentsOnOthers || [];

    let checked = 0;
    let responded = 0;

    const trackedComments = state.commentsOnOthers.slice(-TRACKED_EXTERNAL_LIMIT);
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

          const safeResponse = response ? sanitizeForMoltbook(response).trim() : '';
          if (safeResponse) {
            const replyResult = await moltbookService.comment(tracked.postId, safeResponse, cid);
            rememberExternalComment(state, tracked.postId, replyResult, post.title || tracked.postTitle || '');
            responded++;
            logger.info('[moltbook-scheduler] Replied to response under AVA external comment', {
              postId: tracked.postId,
              parentCommentId: tracked.commentId,
              replyCommentId: cid,
              commenter,
            });
            markMoltbookCommentProcessed(state, commentKey);
          } else {
            const failure = recordMoltbookReplyFailure(state, commentKey, 'grounding_gate_rejected');
            logger.warn('[moltbook-scheduler] Grounded external reply unavailable', {
              postId: tracked.postId,
              commentId: cid,
              attempts: failure.attempts,
              exhausted: failure.exhausted,
            });
          }

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
 * Post a new question to Moltbook
 */
async function postNewQuestion() {
  const generated = await generateNewQuestion();
  if (!generated) return { success: false, skipped: true, reason: 'nothing_grounded_to_post' };
  const { submolt, title, content } = generated;
  return postToMoltbook(submolt, title, content, { kind: 'self' });
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
  // Watchlist focus (#200): prioritize feed items matching watched topics/handles/submolts, but
  // still engage with something even when nothing matches (stable sort keeps original order on ties).
  const target = candidates
    .map((p, i) => {
      const author = (p.author && (p.author.name || p.author.username)) || p.author || '';
      const submolt = p.submolt || p.subMolt || p.community || '';
      return { p, i, s: watchlist.score(`${p.title || ''} ${p.content || p.body || ''} ${author} ${submolt}`) };
    })
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))[0].p;
  const pid = target.id || target.postId || target._id;
  const comment = await generateFeedComment(target);
  if (!comment) return { engaged: 0, state };
  try {
    const r = await moltbookService.comment(pid, sanitizeForMoltbook(comment));
    if (r && (r.success || r.ok || r.comment || r.id)) {
      state.engagedPosts.push(pid);
      rememberExternalComment(state, pid, r, target.title || '');
      evolveInterestFrom(target).catch(() => {});  // her interests grow from what she reads
      if (state.engagedPosts.length > KNOWN_POST_LIMIT) state.engagedPosts = state.engagedPosts.slice(-KNOWN_POST_LIMIT);
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
  let learningCompleted = null;

  try {
    learningCompleted = await _runActivityInternal();
  } finally {
    _activityRunning = false;
    if (learningCompleted) {
      emitVoiceEvent('moltbook.learning.completed', learningCompleted, 'moltbook');
    }
  }
}

async function _runActivityInternal() {
  let state = readState();
  const now = Date.now();
  let learningCompleted = null;

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
    const ENGAGE_EVERY = Math.max(1, parseInt(process.env.AVA_MOLTBOOK_ENGAGE_MIN || '5', 10)) * 60 * 1000;
    const todayStr = new Date().toDateString();
    if (state.lastEngageDate !== todayStr) { state.engagesToday = 0; state.lastEngageDate = todayStr; }
    const engageCap = parseInt(process.env.AVA_MOLTBOOK_ENGAGE_MAX_DAILY || '48', 10);
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
      const synthesis = synthesizeLearnings(moltbookService.learnings || []);
      learningCompleted = {
        newLearnings: findings,
        totalRecords: synthesis.totalInput,
        uniqueRecords: synthesis.uniqueCount,
        corpusHash: synthesis.corpusHash,
      };
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
      const SELF_POST_MIN = Math.max(30, parseInt(process.env.AVA_MOLTBOOK_SELFPOST_MIN || '45', 10)) * 60 * 1000;
      const selfPostDue = !state.lastSelfPostAt || now - state.lastSelfPostAt > SELF_POST_MIN;
      if (selfPostDue) {
        const sp = await generateSelfPost();
        const result = sp ? await postToMoltbook(sp.submolt, sp.title, sp.content, { kind: 'self' }) : null;
        if (result?.published) {
          logger.info('[moltbook-scheduler] Posted original self-post');
          return learningCompleted;
        }
        if (result?.verificationRequired) {
          logger.info('[moltbook-scheduler] Original self-post is awaiting user verification');
          return learningCompleted;
        }
        logger.warn('[moltbook-scheduler] Original self-post was due but failed', {
          error: result && result.error,
          statusCode: result && result.statusCode,
          message: result && result.message,
        });
        return learningCompleted;
      }

      // First check if there are tracked issues to post
      const issues = readIssues();
      const unpostedIssues = issues.issues.filter(isPostableIssue);

      if (unpostedIssues.length > 0) {
        logger.info('[moltbook-scheduler] Posting tracked issue');
        const result = await askMoltbookForHelp();
        if (result.verificationRequired) logger.info('[moltbook-scheduler] Tracked issue is awaiting user verification');
      } else {
        // Alternate an ORIGINAL self-interested post with a help question, so AVA takes part in
        // regular conversation — not only Q&A.
        const even = ((state.postsTotal || 0) % 2) === 0;
        let result;
        if (even) {
          const sp = await generateSelfPost();
          result = sp ? await postToMoltbook(sp.submolt, sp.title, sp.content, { kind: 'self' }) : await postNewQuestion();
        } else {
          result = await postNewQuestion();
        }
        if (result?.published) {
          logger.info('[moltbook-scheduler] Posted', { kind: even ? 'self-post' : 'question' });
        } else if (result?.verificationRequired) {
          logger.info('[moltbook-scheduler] Generated post is awaiting user verification', { kind: even ? 'self-post' : 'question' });
        }
      }
    } catch (e) {
      logger.warn('[moltbook-scheduler] Posting failed', { error: e.message });
    }
  }
  return learningCompleted;
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
// Preview helper (debug/verify only): generate N sample posts WITHOUT posting them, plus the
// identity block, so we can confirm posts are persona-driven and varied.
export function previewDraftId(post = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([
    post.submolt || '',
    post.title || '',
    post.content || '',
    post.evidence || '',
    post.learningCorpusHash || '',
  ])).digest('hex').slice(0, 24);
}

export function findPreviewDraft(state = {}, draftId = '', now = Date.now()) {
  const id = String(draftId || '').trim();
  if (!id) return null;
  return (state.previewDrafts || []).find(draft => (
    draft?.draftId === id && Number(draft.expiresAt || 0) > Number(now)
  )) || null;
}

export async function previewSelfPosts(n = 3) {
  const out = [];
  for (let i = 0; i < Math.max(1, Math.min(6, n)); i++) {
    try { const p = await generateSelfPost({ excludePosts: out, variationIndex: i }); if (p) out.push(p); } catch { /* skip */ }
  }
  const generatedAt = Date.now();
  const posts = out.map(post => ({
    ...post,
    draftId: previewDraftId(post),
    expiresAt: generatedAt + PREVIEW_DRAFT_TTL_MS,
  }));
  const state = readState();
  const retained = (state.previewDrafts || []).filter(draft => Number(draft?.expiresAt || 0) > generatedAt);
  const byId = new Map(retained.map(draft => [draft.draftId, draft]));
  for (const post of posts) byId.set(post.draftId, { ...post, generatedAt });
  state.previewDrafts = [...byId.values()].slice(-24);
  writeState(state, { authoritativeFields: ['previewDrafts'] });
  return { identity: buildMoltbookIdentity(), interests: interests.top(8), posts };
}

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
  return postToMoltbook(submolt, title, content, { kind: 'manual' });
}

/** Manually post one ORIGINAL self-interested post (for testing / on demand). */
export async function triggerMoltbookSelfPost(draftId = '') {
  const selectedId = String(draftId || '').trim();
  const sp = selectedId ? findPreviewDraft(readState(), selectedId) : await generateSelfPost();
  if (!sp) {
    return selectedId
      ? { ok: false, reason: 'preview_draft_not_found_or_expired', draftId: selectedId }
      : { ok: false, reason: 'generation_failed' };
  }
  const r = await postToMoltbook(sp.submolt, sp.title, sp.content, { kind: 'self' });
  if (selectedId && r?.success) {
    const state = readState();
    state.previewDrafts = (state.previewDrafts || []).filter(draft => draft?.draftId !== selectedId);
    writeState(state, { authoritativeFields: ['previewDrafts'] });
  }
  return {
    ok: !!r?.published,
    accepted: !!r?.success,
    pendingVerification: !!r?.verificationRequired,
    draftId: selectedId || null,
    submolt: sp.submolt,
    title: sp.title,
    postId: r?.post?.id,
    result: r,
  };
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
    verifiedPostsTotal: state.verifiedPostsTotal || 0,
    verifiedSelfPostsTotal: state.verifiedSelfPostsTotal || 0,
    pendingVerifications: _pendingVerifications.length,
    lastLearnAt: state.lastLearnAt ? new Date(state.lastLearnAt).toISOString() : null,
    nextLearnIn: nextLearnIn > 0 ? `${Math.round(nextLearnIn / 60000)} minutes` : 'ready',
    lastPostAt: state.lastPostAt ? new Date(state.lastPostAt).toISOString() : null,
    lastSelfPostAt: state.lastSelfPostAt ? new Date(state.lastSelfPostAt).toISOString() : null,
    lastNotifCheck: state.lastNotifCheck ? new Date(state.lastNotifCheck).toISOString() : null,
    lastExternalReplyCheck: state.lastExternalReplyCheck ? new Date(state.lastExternalReplyCheck).toISOString() : null,
    lastHomeActivitySync: state.lastHomeActivitySync ? new Date(state.lastHomeActivitySync).toISOString() : null,
    recentPosts: state.recentPosts || [],
    pendingIssues: issues.issues.filter(isPostableIssue).length,
    totalIssues: issues.issues.length,
    processedNotifications: (state.processedNotifications || []).length
  };
}

export default {
  startMoltbookScheduler,
  triggerMoltbookLearning,
  triggerMoltbookPost,
  trackIssue,
  isPostableIssue,
  resolveIssue,
  getStats,
  runMoltbookLearning
};
