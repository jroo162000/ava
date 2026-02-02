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
        learnings: this.learnings.slice(-100), // Keep last 100 learnings
        lastFeedCheck: this.lastFeedCheck,
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

  async apiRequest(endpoint, method = 'GET', data = null) {
    if (!this.apiKey) {
      return { success: false, error: 'Moltbook not configured - no API key' };
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
      const result = await response.json();
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
    const result = await this.apiRequest('posts', 'POST', { submolt, title, content });
    if (result.success) {
      logger.info('[moltbook] Posted successfully', { submolt, title });
    }
    return result;
  }

  async comment(postId, content, parentCommentId = null) {
    const payload = { content };
    if (parentCommentId) {
      payload.parent_id = parentCommentId;
    }
    const result = await this.apiRequest(`posts/${postId}/comments`, 'POST', payload);
    return result;
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

    for (const post of posts) {
      if (!post || !post.title) continue;

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
