/**
 * Moltbook Tools for AVA
 * Allows AVA to interact with the Moltbook social network during conversations
 */

import moltbookService from '../services/moltbook.js';
import logger from '../utils/logger.js';

export const moltbookTools = [
  {
    name: 'moltbook_status',
    description: 'Check AVA\'s Moltbook status and what she\'s learned from other agents',
    parameters: {},
    handler: async () => {
      try {
        const status = await moltbookService.getStatus();
        const learnings = moltbookService.getLearningsSummary();

        return {
          status: 'ok',
          moltbook: {
            ...status,
            learnings: typeof learnings === 'object' ? learnings : { summary: learnings }
          }
        };
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }
  },

  {
    name: 'moltbook_feed',
    description: 'Check the Moltbook feed to see what other agents are posting and learn from them',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of posts to fetch (default 10)' },
        sort: { type: 'string', enum: ['hot', 'new', 'top'], description: 'Sort order (default hot)' }
      }
    },
    handler: async (args) => {
      try {
        const limit = args.limit || 10;
        const sort = args.sort || 'hot';
        const posts = await moltbookService.getFeed(limit, sort);

        // Format posts for AVA to understand
        const formatted = posts.slice(0, 5).map(p => ({
          title: p.title,
          author: p.author?.name,
          submolt: p.submolt?.name,
          preview: p.content?.slice(0, 200),
          upvotes: p.upvotes
        }));

        return {
          status: 'ok',
          postCount: posts.length,
          posts: formatted,
          message: `Found ${posts.length} posts. Extracted learnings from relevant content.`
        };
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }
  },

  {
    name: 'moltbook_search',
    description: 'Search Moltbook for tips, solutions, or discussions on a topic. Use this to learn from other agents.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' }
      },
      required: ['query']
    },
    handler: async (args) => {
      try {
        const results = await moltbookService.search(args.query, 10);

        const formatted = results.slice(0, 5).map(r => ({
          title: r.title,
          author: r.author?.name,
          submolt: r.submolt?.name,
          preview: r.content?.slice(0, 200),
          similarity: r.similarity
        }));

        return {
          status: 'ok',
          query: args.query,
          resultCount: results.length,
          results: formatted
        };
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }
  },

  {
    name: 'moltbook_post',
    description: 'Post something to Moltbook to share with other agents. Use sparingly - only for significant learnings or experiences.',
    parameters: {
      type: 'object',
      properties: {
        submolt: { type: 'string', description: 'Community to post to (e.g., "general", "voiceai", "tips", "improvements")' },
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Post content' }
      },
      required: ['submolt', 'title', 'content']
    },
    requires_confirm: true,
    handler: async (args) => {
      try {
        const result = await moltbookService.post(args.submolt, args.title, args.content);

        if (result.success) {
          return {
            status: 'ok',
            message: `Posted to m/${args.submolt}: "${args.title}"`,
            postId: result.post?.id
          };
        } else {
          return {
            status: 'error',
            message: result.error || 'Failed to post'
          };
        }
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }
  },

  {
    name: 'moltbook_learnings',
    description: 'Get a summary of what AVA has learned from Moltbook',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of recent learnings to show (default 5)' }
      }
    },
    handler: async (args) => {
      try {
        const count = args.count || 5;
        const recent = moltbookService.getRecentLearnings(count);
        const summary = moltbookService.getLearningsSummary();

        return {
          status: 'ok',
          summary: typeof summary === 'object' ? summary : { message: summary },
          recentLearnings: recent
        };
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }
  }
];

// Register tools with the tools service
export function registerMoltbookTools(toolsService) {
  for (const tool of moltbookTools) {
    toolsService.registerTool(tool);
  }
  logger.info('[moltbook] Registered Moltbook tools', { count: moltbookTools.length });
}

export default moltbookTools;
