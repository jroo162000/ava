// Memory Routes - Phase 5: Memory as State
// Endpoints for memory management, learning, and retrieval
import express from 'express';
import logger from '../utils/logger.js';
import memoryService, { MemoryType, MemorySource } from '../services/memory.js';

const router = express.Router();

/**
 * Get memory statistics
 * GET /memory/stats
 */
router.get('/memory/stats', (req, res) => {
  try {
    const stats = memoryService.getStats();
    res.json({ ok: true, stats });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Search memories
 * POST /memory/search
 * Body: { query: string, k?: number, filters?: object }
 */
router.post('/memory/search', async (req, res) => {
  try {
    const { query, k = 5, filters = {} } = req.body;
    
    if (!query) {
      return res.status(400).json({ ok: false, error: 'Query is required' });
    }

    const results = await memoryService.retrieveRelevant(query, k, filters);
    
    res.json({ 
      ok: true, 
      results,
      count: results.length,
      query: query.slice(0, 50)
    });
  } catch (error) {
    logger.error('[memory] Search failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Store a new memory
 * POST /memory/store
 * Body: { text, type?, priority?, source?, tags? }
 */
router.post('/memory/store', async (req, res) => {
  try {
    const { text, type, priority, source, tags } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const record = await memoryService.store({
      text,
      type: type || MemoryType.CONVERSATION,
      priority: priority || 3,
      source: source || MemorySource.USER,
      tags: tags || []
    });

    logger.info('[memory] Stored', { id: record.id, type: record.type });
    
    res.json({ ok: true, memory: record });
  } catch (error) {
    logger.error('[memory] Store failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Learn a user preference
 * POST /memory/learn/preference
 * Body: { text }
 */
router.post('/memory/learn/preference', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const record = await memoryService.learnPreference(text, MemorySource.USER);
    
    logger.info('[memory] Learned preference', { id: record.id, text: text.slice(0, 50) });
    
    res.json({ ok: true, memory: record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Learn a workflow
 * POST /memory/learn/workflow
 * Body: { text, tags? }
 */
router.post('/memory/learn/workflow', async (req, res) => {
  try {
    const { text, tags = [] } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const record = await memoryService.learnWorkflow(text, tags);
    
    logger.info('[memory] Learned workflow', { id: record.id, text: text.slice(0, 50) });
    
    res.json({ ok: true, memory: record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Learn a constraint/warning
 * POST /memory/learn/constraint
 * Body: { text }
 */
router.post('/memory/learn/constraint', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const record = await memoryService.learnConstraint(text);
    
    logger.info('[memory] Learned constraint', { id: record.id, text: text.slice(0, 50) });
    
    res.json({ ok: true, memory: record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Learn a fact about the user
 * POST /memory/learn/fact
 * Body: { text }
 */
router.post('/memory/learn/fact', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const record = await memoryService.learnFact(text);
    
    logger.info('[memory] Learned fact', { id: record.id, text: text.slice(0, 50) });
    
    res.json({ ok: true, memory: record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Get memory types enum
 * GET /memory/types
 */
router.get('/memory/types', (req, res) => {
  res.json({ 
    ok: true, 
    types: MemoryType,
    sources: MemorySource
  });
});

export default router;
