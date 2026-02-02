// Tools Service - Dynamic tool discovery from Python worker
// Phase 3: Node never manually updates tool defs - Python is the source of truth
// Phase 7: Security validation before execution
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import pythonWorker from './pythonWorker.js';
import securityService from '../utils/security.js';
import moltbookService from './moltbook.js';

class ToolsService {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = 60000; // 1 minute cache
    this.initialized = false;
  }

  /**
   * Builtin Node-side tools that don't require Python
   */
  getBuiltinTools() {
    return [
      { 
        name: 'file_gen', 
        description: 'Create documents (txt, md, csv, json, html, pdf, docx, xlsx, pptx)', 
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Output filename with extension' },
            content: { type: 'string', description: 'File content' },
            format: { type: 'string', enum: ['txt', 'md', 'csv', 'json', 'html', 'pdf', 'docx', 'xlsx', 'pptx'] }
          },
          required: ['filename', 'content']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      { 
        name: 'fs_read', 
        description: 'Read a text file from whitelisted paths', 
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' }
          },
          required: ['path']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      { 
        name: 'fs_find', 
        description: 'Find files by name pattern', 
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Filename pattern (glob)' },
            directory: { type: 'string', description: 'Directory to search' }
          },
          required: ['pattern']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      { 
        name: 'memory_search', 
        description: 'Search conversation memory', 
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'integer', description: 'Max results', default: 10 }
          },
          required: ['query']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'status',
        description: 'Get server status and health info',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {}
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      // Moltbook tools - social network for AI agents
      {
        name: 'moltbook_status',
        description: 'Check AVA\'s Moltbook status and what she has learned from other agents',
        source: 'builtin',
        schema: { type: 'object', properties: {} },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_feed',
        description: 'Check the Moltbook feed to see what other agents are posting and learn from them',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of posts (default 10)' },
            sort: { type: 'string', enum: ['hot', 'new', 'top'] }
          }
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_search',
        description: 'Search Moltbook for tips, solutions, or discussions. Use this to learn from other agents.',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' }
          },
          required: ['query']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_learnings',
        description: 'Get a summary of what AVA has learned from Moltbook',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Number of recent learnings (default 5)' }
          }
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_post',
        description: 'Post to Moltbook to share learnings with other agents. Use sparingly.',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            submolt: { type: 'string', description: 'Community (e.g., voiceai, tips, improvements)' },
            title: { type: 'string', description: 'Post title' },
            content: { type: 'string', description: 'Post content' }
          },
          required: ['submolt', 'title', 'content']
        },
        requires_confirm: true,
        risk_level: 'medium'
      }
    ];
  }

  /**
   * Fetch tools from Python worker (cmp-use registry)
   * This is the source of truth for Python tools
   */
  async fetchPythonTools() {
    try {
      const response = await pythonWorker.listTools();
      if (response && Array.isArray(response)) {
        logger.info('[tools] Fetched tools from Python worker', { count: response.length });
        return response;
      }
      // Handle {ok: true, tools: [...]} response format
      if (response?.ok && Array.isArray(response.tools)) {
        logger.info('[tools] Fetched tools from Python worker', { count: response.tools.length });
        return response.tools;
      }
      logger.warn('[tools] Invalid response from Python worker', { response });
      return [];
    } catch (e) {
      logger.warn('[tools] Failed to fetch Python tools', { error: e.message });
      return [];
    }
  }

  /**
   * Get all available tools - merges builtin and Python tools
   * Python tools override builtin if same name (Python is authoritative)
   */
  async getAllTools(forceRefresh = false) {
    const now = Date.now();
    
    // Return cache if valid
    if (!forceRefresh && this.cache && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    // Fetch from all sources
    const builtin = this.getBuiltinTools();
    const pythonTools = await this.fetchPythonTools();

    // Merge: Python tools are authoritative (override builtin)
    const toolMap = new Map();
    
    // Add builtin first
    for (const tool of builtin) {
      toolMap.set(tool.name, tool);
    }
    
    // Python tools override
    for (const tool of pythonTools) {
      toolMap.set(tool.name, tool);
    }

    this.cache = Array.from(toolMap.values());
    this.cacheTime = now;
    
    logger.info('[tools] Tool cache refreshed', { 
      builtin: builtin.length, 
      python: pythonTools.length, 
      total: this.cache.length 
    });
    
    return this.cache;
  }

  /**
   * Get a specific tool by name
   */
  async getTool(name) {
    const tools = await this.getAllTools();
    return tools.find(t => t.name === name);
  }

  /**
   * Get tools formatted for LLM function calling (OpenAI format)
   */
  async getToolsForLLM() {
    const tools = await this.getAllTools();
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema || { type: 'object', properties: {} }
      }
    }));
  }

  /**
   * Get tools by risk level
   */
  async getToolsByRisk(riskLevel) {
    const tools = await this.getAllTools();
    return tools.filter(t => t.risk_level === riskLevel);
  }

  /**
   * Get tools that require confirmation
   */
  async getToolsRequiringConfirm() {
    const tools = await this.getAllTools();
    return tools.filter(t => t.requires_confirm);
  }

  /**
   * Force refresh the cache
   */
  async invalidateCache() {
    this.cache = null;
    this.cacheTime = 0;
    return this.getAllTools(true);
  }

  /**
   * Execute builtin Node-side tools
   */
  async executeBuiltinTool(name, args, dryRun = false) {
    if (dryRun) {
      return { ok: true, dry_run: true, would_execute: { name, args } };
    }

    switch (name) {
      case 'status':
        return {
          ok: true,
          result: {
            status: 'healthy',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            node_version: process.version,
            platform: process.platform,
            timestamp: new Date().toISOString()
          }
        };

      case 'memory_search':
        // This would typically call the memory service
        // For now, return a placeholder
        return {
          ok: true,
          result: { message: 'Use /memory/search endpoint for memory queries' }
        };

      case 'fs_read':
      case 'fs_find':
      case 'file_gen':
        // These builtins exist but need proper implementation
        // Route to Python for now since they have implementations there
        const response = await pythonWorker.sendCommand('execute_tool', {
          name,
          args,
          dry_run: dryRun
        }, 30000);
        return response;

      // Moltbook tools
      case 'moltbook_status':
        try {
          const status = await moltbookService.getStatus();
          const learnings = moltbookService.getLearningsSummary();
          return { ok: true, result: { ...status, learnings } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_feed':
        try {
          const limit = args.limit || 10;
          const sort = args.sort || 'hot';
          const posts = await moltbookService.getFeed(limit, sort);
          const formatted = posts.slice(0, 5).map(p => ({
            title: p.title,
            author: p.author?.name,
            submolt: p.submolt?.name,
            preview: p.content?.slice(0, 200),
            upvotes: p.upvotes
          }));
          return { ok: true, result: { postCount: posts.length, posts: formatted } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_search':
        try {
          const results = await moltbookService.search(args.query, 10);
          const formatted = results.slice(0, 5).map(r => ({
            title: r.title,
            author: r.author?.name,
            submolt: r.submolt?.name,
            preview: r.content?.slice(0, 200)
          }));
          return { ok: true, result: { query: args.query, resultCount: results.length, results: formatted } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_learnings':
        try {
          const count = args.count || 5;
          const recent = moltbookService.getRecentLearnings(count);
          const summary = moltbookService.getLearningsSummary();
          return { ok: true, result: { summary, recentLearnings: recent } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_post':
        try {
          const result = await moltbookService.post(args.submolt, args.title, args.content);
          if (result.success) {
            return { ok: true, result: { message: `Posted to m/${args.submolt}`, postId: result.post?.id } };
          }
          return { ok: false, error: result.error || 'Failed to post' };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      default:
        return { ok: false, error: `Builtin tool not implemented: ${name}` };
    }
  }

  /**
   * Execute a tool via Python worker
   * Phase 7: Security validation before execution
   */
  async executeTool(name, args, dryRun = false) {
    try {
      // Get tool info for risk level
      const tool = await this.getTool(name);
      if (!tool) {
        return { ok: false, error: `Tool not found: ${name}` };
      }

      // Phase 7: Security validation
      const securityCheck = securityService.validateToolExecution(
        name, 
        args || {}, 
        tool.risk_level
      );

      if (!securityCheck.allowed) {
        logger.warn('[tools] Security check failed', { 
          tool: name, 
          issues: securityCheck.issues 
        });
        
        // Return specific error for each issue type
        const firstIssue = securityCheck.issues[0];
        if (firstIssue.type === 'confirmation_required') {
          return { 
            ok: false, 
            error: firstIssue.message,
            status: 'denied',
            reason: 'confirmation_required'
          };
        }
        if (firstIssue.type === 'path_security') {
          return { 
            ok: false, 
            error: firstIssue.message,
            status: 'denied',
            reason: 'path_blocked'
          };
        }
        if (firstIssue.type === 'dangerous_command') {
          return { 
            ok: false, 
            error: firstIssue.message,
            status: 'denied',
            reason: 'dangerous_command'
          };
        }
        
        return { 
          ok: false, 
          error: securityCheck.issues.map(i => i.message).join('; '),
          status: 'denied',
          reason: 'security_violation'
        };
      }

      // Handle builtin tools in Node.js
      if (tool.source === 'builtin') {
        return this.executeBuiltinTool(name, args, dryRun);
      }

      // Execute Python tools via Python worker
      const response = await pythonWorker.sendCommand('execute_tool', {
        name,
        args,
        dry_run: dryRun
      }, 30000);
      
      return response;
    } catch (e) {
      logger.error('[tools] Tool execution failed', { name, error: e.message });
      return { ok: false, error: e.message };
    }
  }
}

const toolsService = new ToolsService();

// Warm up cache on module load with retry for Python worker
const warmupCache = async (retries = 3, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const tools = await toolsService.getAllTools(true);
      if (tools.length > 10) { // Expect Python tools
        logger.info('[tools] Initial cache warmed', { count: tools.length });
        return;
      }
      logger.info('[tools] Cache warm attempt', { attempt: i + 1, count: tools.length });
    } catch (e) {
      logger.warn('[tools] Cache warm attempt failed', { attempt: i + 1, error: e.message });
    }
  }
};
warmupCache();

export default toolsService;
