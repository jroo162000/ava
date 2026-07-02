/**
 * Moltbook Integration Service for AVA
 * Enables AVA to interact with the Moltbook social network for AI agents
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const CREDS_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'moltbook', 'credentials.json');
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'moltbook-learnings.json');

class MoltbookService {
  constructor() {
    this.credentials = null;
    this.learnings = [];
    this.lastFeedCheck = null;
    this.rateLimitedUntil = 0;
    this.commentThreads = new Map(); // postId -> { parentPostId, commentTimestamp, lastReplyCount }
    this.loadCredentials();
    this.loadLearnings();
  }

  loadCredentials() {
    try {
      if (fs.existsSync(CREDS_PATH)) {
        this.credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
        logger.info('[moltbook] Credentials loaded', { agent: this.credentials.agent_name });
      }
    } catch (e) {
      logger.warn('[moltbook] Failed to load credentials', { error: e.message });
    }
  }

  loadLearnings() {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        this.learnings = data.learnings || [];
        this.lastFeedCheck = data.lastFeedCheck;
      }
    } catch (e) {
      this.learnings = [];
    }
  }

  saveLearnings() {
    try {
      const dir = path.dirname(STATE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        learnings: this.learnings.slice(-5000), // Keep broad Moltbook context for proposal generation
        lastFeedCheck: this.lastFeedCheck,
        // Track Moltbook engagement state, including AVA-authored comments on others' posts
        engagementState: this.engagementState || {},
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (e) {
      logger.warn('[moltbook] Failed to save learnings', { error: e.message });
    }
  }

  get apiKey() {
    return this.credentials?.api_key;
  }

  get agentName() {
    return this.credentials?.agent_name || 'AVA-Voice';
  }

  get isConfigured() {
    return !!this.apiKey;
  }

  get isRateLimited() {
    return Date.now() < (this.rateLimitedUntil || 0);
  }

  get rateLimitResetAt() {
    return this.rateLimitedUntil || 0;
  }

  async apiRequest(endpoint, method = 'GET', data = null) {
    if (!this.apiKey) {
      return { success: false, error: 'Moltbook not configured - no API key' };
    }

    if (this.isRateLimited) {
      return {
        success: false,
        error: 'rate_limited_local_cooldown',
        message: `Cooling down until ${new Date(this.rateLimitedUntil).toISOString()}`
      };
    }

    const url = `${MOLTBOOK_API}/${endpoint.replace(/^\//, '')}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = { message: response.statusText };
      }
      if (!response.ok) {
        result = {
          ...result,
          success: false,
          statusCode: result.statusCode || response.status,
          error: result.error || result.message || response.statusText || `HTTP ${response.status}`,
        };
      }
      if ((result && result.error === 'rate_limited') || response.status === 429 || result.statusCode === 429) {
        const retryAfter = Number(result.retry_after_seconds || 0);
        const resetAt = result.reset_at ? Date.parse(result.reset_at) : 0;
        const cooldownMs = retryAfter > 0
          ? retryAfter * 1000
          : resetAt > Date.now()
            ? resetAt - Date.now()
            : Math.max(5, parseInt(process.env.AVA_MOLTBOOK_RATE_LIMIT_COOLDOWN_MIN || '15', 10)) * 60 * 1000;
        this.rateLimitedUntil = Date.now() + cooldownMs;
        logger.warn('[moltbook] Rate limited; cooling down', {
          endpoint,
          until: new Date(this.rateLimitedUntil).toISOString()
        });
      }
      return result;
    } catch (e) {
      logger.error('[moltbook] API request failed', { endpoint, error: e.message });
      return { success: false, error: e.message };
    }
  }

  async getStatus() {
    const result = await this.apiRequest('agents/status');
    return {
      configured: this.isConfigured,
      agentName: this.agentName,
      claimed: result.status === 'claimed',
      status: result.status || 'unknown',
      profileUrl: this.credentials?.profile_url,
      learningsCount: this.learnings.length
    };
  }

  async getFeed(limit = 10, sort = 'hot') {
    const result = await this.apiRequest(`feed?sort=${sort}&limit=${limit}`);
    if (result.success && result.posts) {
      // Extract learnings from feed
      this.extractLearnings(result.posts);
      return result.posts;
    }
    return [];
  }

  async search(query, limit = 10) {
    const encoded = encodeURIComponent(query);
    const result = await this.apiRequest(`search?q=${encoded}&type=posts&limit=${limit}`);
    if (result.success && result.results) {
      // Extract learnings from search results
      this.extractLearnings(result.results.map(r => r.post || r));
      return result.results;
    }
    return [];
  }

  async post(submolt, title, content) {
    // The Moltbook API names the community field `submolt_name` (a string) — NOT `submolt`.
    // Sending `submolt` alone => 400 "Bad Request" (validation: "submolt_name must be a string").
    // Default to "general" so a bare "make a post" still has a valid target community.
    const community = String(submolt || 'general').trim().replace(/^m\//, '') || 'general';
    const safeTitle = String(title || '').trim().slice(0, 300) || 'A note from AVA';
    const result = await this.apiRequest('posts', 'POST', {
      submolt_name: community,
      submolt: community,   // sent for backward-compat; the API uses submolt_name
      title: safeTitle,
      content: String(content || '').trim(),
    });
    if (result.success || result.id || result.post) {
      logger.info('[moltbook] Posted successfully', { community, title: safeTitle });
    } else {
      logger.warn('[moltbook] Post failed', { community, error: result.error, detail: result.message });
    }
    return result;
  }

  // Submit an answer to a post's verification challenge. The answer comes from the USER — AVA
  // does NOT auto-solve the obfuscated challenge. Publishes the post when the answer is correct.
  async submitVerification(verificationCode, answer) {
    return this.apiRequest('verify', 'POST', { verification_code: verificationCode, answer: String(answer).trim() });
  }

  async comment(postId, content, parentCommentId = null) {
    const payload = { content };
    if (parentCommentId) {
      payload.parent_id = parentCommentId;
    }
    const result = await this.apiRequest(`posts/${postId}/comments`, 'POST', payload);
    if (result.success || result.id || result.comment) {
      this._trackCommentThread(parentCommentId || postId, postId);
    }
    return result;
  }

  _trackCommentThread(parentPostId, commentPostId) {
    // Store the thread so _checkEngagement can later fetch replies
    const key = String(parentPostId || commentPostId);
    if (!this.commentThreads.has(key)) {
      this.commentThreads.set(key, {
        parentPostId: key,
        commentTimestamp: Date.now(),
        lastReplyCount: 0
      });
      logger.info('[moltbook] Tracking comment thread', { postId: key });
    }
  }

  async upvote(postId) {
    const result = await this.apiRequest(`posts/${postId}/upvote`, 'POST');
    return result;
  }

  async getSubmolts() {
    const result = await this.apiRequest('submolts');
    if (result.success && result.submolts) {
      return result.submolts;
    }
    return [];
  }

  async subscribe(submolt) {
    const result = await this.apiRequest(`submolts/${submolt}/subscribe`, 'POST');
    return result;
  }

  async getNotifications(limit = 20) {
    const result = await this.apiRequest(`notifications?limit=${limit}`);
    if (result.success && result.notifications) {
      return result.notifications;
    }
    return [];
  }

  async getHome() {
    return this.apiRequest('home');
  }

  async getPostComments(postId, limit = 100) {
    const result = await this.apiRequest(`posts/${postId}/comments?sort=new&limit=${limit}`);
    if (result.success && Array.isArray(result.comments)) return result.comments;
    return [];
  }

  async checkTrackedThreads() {
    // Returns engagement updates: comments on tracked threads that mention AVA
    const updates = [];
    const toCheck = Array.from(this.commentThreads.entries()).slice(0, 6);
    for (const [postId, thread] of toCheck) {
      const comments = await this.getPostComments(postId, 50);
      if (!Array.isArray(comments)) continue;
      const newReplyCount = comments.length;
      if (newReplyCount > (thread.lastReplyCount || 0)) {
        // New replies since we last checked
        const newReplies = comments.slice(thread.lastReplyCount || 0);
        for (const reply of newReplies) {
          if (reply.author && reply.author.name !== this.agentName) {
            const body = (reply.content || '').toLowerCase();
            const mentionsAva = body.includes('@' + this.agentName.toLowerCase()) ||
                                body.includes('ava') ||
                                body.includes('voice');
            if (mentionsAva) {
              updates.push({
                postId,
                commentId: reply.id,
                author: reply.author.name,
                content: (reply.content || '').slice(0, 200),
                timestamp: reply.created_at || new Date().toISOString(),
                type: 'reply_mention'
              });
            }
          }
        }
        thread.lastReplyCount = newReplyCount;
        this.saveLearnings();
      }
    }
    return updates;
  }

  async markPostNotificationsRead(postId) {
    return this.apiRequest(`notifications/read-by-post/${postId}`, 'POST');
  }

  _isDuplicate(text, threshold = 0.85) {
    // Compare incoming text against the last N stored learnings using a simple Jaccard similarity
    // on word bigrams. Returns true if any existing learning exceeds the threshold.
    if (!text || text.length < 20) return false;
    const candidates = this.learnings.slice(-100); // only scan most recent 100 entries
    const incomingBigrams = this._wordBigrams(text.toLowerCase());
    for (const existing of candidates) {
      const existingText = `${existing.title || ''} ${existing.summary || ''}`.toLowerCase();
      const existingBigrams = this._wordBigrams(existingText);
      if (incomingBigrams.size === 0 || existingBigrams.size === 0) continue;
      // Jaccard similarity: intersection / union
      const intersection = new Set([...incomingBigrams].filter(b => existingBigrams.has(b)));
      const union = new Set([...incomingBigrams, ...existingBigrams]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;
      if (similarity >= threshold) {
        logger.debug('[moltbook] Duplicate learning detected', {
          existingSummary: existingText.slice(0, 80),
          incomingSummary: text.slice(0, 80),
          similarity: similarity.toFixed(2)
        });
        return true;
      }
    }
    return false;
  }

  _wordBigrams(text) {
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const bigrams = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]} ${words[i+1]}`);
    }
    return bigrams;
  }

  recordLearning(learning) {
    if (!learning || !learning.postId || !learning.summary) return false;
    // Deduplication pass: reject if very similar to an existing learning
    const compositeText = `${learning.title || ''} ${learning.summary}`;
    if (this._isDuplicate(compositeText)) {
      logger.debug('[moltbook] Skipping duplicate learning', { postId: learning.postId });
      return false;
    }
    const key = `${learning.postId}:${learning.commentId || learning.title || learning.summary.slice(0, 60)}`;
    const exists = this.learnings.some(l => (l.key || `${l.postId}:${l.commentId || l.title || String(l.summary || '').slice(0, 60)}`) === key);
    if (exists) return false;
    this.learnings.push({ key, learnedAt: new Date().toISOString(), upvotes: 0, ...learning });
    this.saveLearnings();
    return true;
  }

  async getPost(postId) {
    const result = await this.apiRequest(`posts/${postId}`);
    if (result.success && result.post) {
      // Include comments from the response (they're at top level, not inside post)
      return {
        ...result.post,
        comments: result.comments || []
      };
    }
    return null;
  }

  async fetchComments(postId, limit = 100) {
    return this.getPostComments(postId, limit);
  }

  async getMyPosts(limit = 50) {
    // Try multiple endpoints to find our posts
    // First try the agent profile posts endpoint
    const agentName = encodeURIComponent(this.agentName);

    // Try agent/{name}/posts endpoint
    let result = await this.apiRequest(`agents/${agentName}/posts?limit=${limit}`);
    if (result.success && result.posts) {
      return result.posts;
    }

    // Try user/profile endpoint
    result = await this.apiRequest(`users/${agentName}/posts?limit=${limit}`);
    if (result.success && result.posts) {
      return result.posts;
    }

    // Try searching for our own posts
    result = await this.apiRequest(`search?q=author:${agentName}&type=posts&limit=${limit}`);
    if (result.success && result.results) {
      return result.results.map(r => r.post || r);
    }

    return [];
  }

  async markNotificationRead(notificationId) {
    const result = await this.apiRequest(`notifications/${notificationId}/read`, 'POST');
    return result;
  }

  extractLearnings(posts) {
    if (!Array.isArray(posts)) return;

    const newLearnings = [];
    const now = new Date().toISOString();


    // Very lightweight spam/adversarial filter: skip obvious promos/noise before they become learnings
    const isNoisy = (post) => {
      const content = (post?.content || '').toLowerCase();
      const title = (post?.title || '').toLowerCase();
      const joined = `${title} ${content}`;

      // Heuristics: external links + promo-y phrases, or extremely long boilerplate
      if (/https?:\/\//.test(joined) && /subscribe|signup|sign up|promotion|sponsor|sponsored|affiliate|referral/.test(joined)) {
        return true;
      }

      // Very long low-signal blobs (e.g. boilerplate dumps)
      if (content.length > 5000 && !/design|architecture|implementation|bug|fix|lesson|retrospective/.test(content)) {
        return true;
      }

      // Simple offensive content guard
      if (/rdrama_ebooks|hate speech|slur|kill yourself|kys/.test(joined)) {
        return true;
      }

      return false;
    };

    for (const post of posts) {
      if (!post || !post.title) continue;
      if (isNoisy(post)) continue;

      const submolt = post.submolt?.name || 'general';
      const author = post.author?.name || 'unknown';
      const content = post.content || '';
      const title = post.title;

      // Extract insights from relevant submolts
      const learningSubmolts = ['selfimprovement', 'improvements', 'tips', 'agentstack', 'voiceai', 'continual-learning', 'metaprompting'];

      if (learningSubmolts.includes(submolt) || content.length > 200) {
        // Check if we already have this learning
        const exists = this.learnings.some(l => l.postId === post.id);
        if (!exists) {
          const compositeText = `${title} ${this.summarize(content)}`;
          if (this._isDuplicate(compositeText)) {
            logger.debug('[moltbook] Skipping duplicate feed learning', { postId: post.id });
            continue;
          }
          const learning = {
            postId: post.id,
            title: title.slice(0, 100),
            summary: this.summarize(content),
            submolt,
            author,
            learnedAt: now,
            upvotes: post.upvotes || 0
          };
          newLearnings.push(learning);
          this.learnings.push(learning);
        }
      }
    }

    if (newLearnings.length > 0) {
      logger.info('[moltbook] Extracted new learnings', { count: newLearnings.length });
      this.saveLearnings();
    }

    return newLearnings;
  }

  summarize(content) {
    if (!content) return '';
    // Simple summarization - first 300 chars or first paragraph
    const firstPara = content.split('\n\n')[0];
    const text = firstPara.length < 300 ? firstPara : content.slice(0, 300);
    return text.replace(/\s+/g, ' ').trim() + (content.length > 300 ? '...' : '');
  }

  getRecentLearnings(count = 5) {
    return this.learnings.slice(-count).reverse();
  }

  // Read actual learning CONTENT with real filters (fixes the "summarize what I learned today"
  // dead-end: this used to only expose a count + 5 titles, so date/keyword requests failed).
  // One of today / days / query / count selects the set; each item carries its real title +
  // summary so a caller can synthesize a genuine answer. Newest first, bounded by limit.
  readLearnings({ today = false, days = 0, query = '', count = 0, limit = 40 } = {}) {
    const all = Array.isArray(this.learnings) ? this.learnings : [];
    const tsOf = (l) => Date.parse(l.learnedAt || l.timestamp || l.at || '') || 0;
    const shape = (l) => ({ title: l.title || '', summary: String(l.summary || '').slice(0, 400), submolt: l.submolt || '', author: l.author || '', learnedAt: l.learnedAt || '' });

    let selected;
    let scope;
    if (query) {
      const q = query.toLowerCase();
      selected = all.filter(l => (`${l.title || ''} ${l.summary || ''}`).toLowerCase().includes(q));
      scope = `matching "${query}"`;
    } else if (today || days > 0) {
      const cutoff = today
        ? new Date(new Date().toDateString()).getTime()          // local midnight today
        : Date.now() - days * 86400000;
      selected = all.filter(l => tsOf(l) >= cutoff);
      scope = today ? 'from today' : `from the last ${days} day(s)`;
    } else {
      selected = all.slice(-(count || 5));
      scope = `most recent ${count || 5}`;
    }

    selected = selected.slice().sort((a, b) => tsOf(b) - tsOf(a));
    const total = selected.length;
    const items = selected.slice(0, limit).map(shape);

    const bySubmolt = {};
    for (const l of selected) bySubmolt[l.submolt || 'general'] = (bySubmolt[l.submolt || 'general'] || 0) + 1;
    const topCommunities = Object.entries(bySubmolt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`);

    return {
      scope,
      totalMatching: total,
      totalLearnings: all.length,
      returned: items.length,
      topCommunities,
      learnings: items,
      note: total > items.length ? `Showing ${items.length} of ${total} ${scope}; raise "limit" for more.` : undefined,
    };
  }

  getLearningsSummary() {
    if (this.learnings.length === 0) {
      return "I haven't learned anything from Moltbook yet. I need to be claimed first, then I can browse and learn from other agents.";
    }

    const recent = this.getRecentLearnings(5);
    const bySubmolt = {};
    for (const l of this.learnings) {
      bySubmolt[l.submolt] = (bySubmolt[l.submolt] || 0) + 1;
    }

    const topSubmolts = Object.entries(bySubmolt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name} (${count})`);

    return {
      totalLearnings: this.learnings.length,
      recentTopics: recent.map(l => l.title),
      topCommunities: topSubmolts,
      lastChecked: this.lastFeedCheck
    };
  }

  // Generate context for AVA's system prompt
  getMoltbookContext() {
    const status = this.isConfigured ? 'registered' : 'not configured';
    const learningsSummary = this.getLearningsSummary();

    let context = `\n[MOLTBOOK SOCIAL NETWORK]
You are registered on Moltbook (moltbook.com) as "${this.agentName}" - a social network for AI agents.
Status: ${status}
Profile: ${this.credentials?.profile_url || 'pending claim'}
`;

    if (typeof learningsSummary === 'object') {
      context += `
Learnings from other agents: ${learningsSummary.totalLearnings} insights collected
Recent topics: ${learningsSummary.recentTopics.join(', ')}
Top communities: ${learningsSummary.topCommunities.join(', ')}
`;
    } else {
      context += `\n${learningsSummary}`;
    }

    context += `
You can search Moltbook for tips, post about your experiences, and learn from other agents.
When asked about Moltbook, share what you've learned from the community.`;

    return context;
  }
}

// Singleton instance
const moltbookService = new MoltbookService();

export default moltbookService;
