// Tools Routes - Dynamic tool discovery endpoints
// Phase 3: All tool definitions come from Python worker
import express from 'express';
import logger from '../utils/logger.js';
import toolsService from '../services/tools.js';

const router = express.Router();

// List all available tools
router.get('/tools', async (_req, res) => {
  try {
    const tools = await toolsService.getAllTools();
    res.json({ ok: true, tools, count: tools.length });
  } catch (error) {
    logger.error('Tools list failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Force refresh tool cache (re-fetch from Python worker)
router.post('/tools/refresh', async (_req, res) => {
  try {
    const tools = await toolsService.invalidateCache();
    res.json({ ok: true, tools, count: tools.length, message: 'Cache refreshed from Python worker' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get tools formatted for LLM function calling
router.get('/tools/llm-format', async (_req, res) => {
  try {
    const tools = await toolsService.getToolsForLLM();
    res.json({ ok: true, tools, count: tools.length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get tools by risk level
router.get('/tools/risk/:level', async (req, res) => {
  try {
    const level = req.params.level;
    if (!['low', 'medium', 'high'].includes(level)) {
      return res.status(400).json({ ok: false, error: 'Invalid risk level. Use: low, medium, high' });
    }
    const tools = await toolsService.getToolsByRisk(level);
    res.json({ ok: true, tools, count: tools.length, riskLevel: level });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get tools that require confirmation
router.get('/tools/confirm-required', async (_req, res) => {
  try {
    const tools = await toolsService.getToolsRequiringConfirm();
    res.json({ ok: true, tools, count: tools.length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get specific tool by name
router.get('/tools/:name', async (req, res) => {
  try {
    const tool = await toolsService.getTool(req.params.name);
    if (!tool) return res.status(404).json({ ok: false, error: 'Tool not found' });
    res.json({ ok: true, tool });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Execute a tool
router.post('/tools/:name/execute', async (req, res) => {
  try {
    const { name } = req.params;
    const { args = {}, dry_run = false } = req.body;
    
    // Check if tool exists
    const tool = await toolsService.getTool(name);
    if (!tool) {
      return res.status(404).json({ ok: false, error: `Tool not found: ${name}` });
    }
    
    // Check if confirmation required but not provided
    if (tool.requires_confirm && !req.body.confirmed) {
      return res.status(403).json({ 
        ok: false, 
        error: 'Tool requires confirmation',
        requires_confirm: true,
        tool: name,
        risk_level: tool.risk_level,
        hint: 'Add "confirmed": true to request body to proceed'
      });
    }
    
    logger.info('Executing tool', { name, args, dry_run });
    const result = await toolsService.executeTool(name, args, dry_run);
    res.json(result);
  } catch (error) {
    logger.error('Tool execution failed', { name: req.params.name, error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
