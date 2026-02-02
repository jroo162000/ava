// Session logs API routes
import express from 'express';
import sessionLogger from '../services/sessionLogger.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Get current session summary
router.get('/session/current', (req, res) => {
  try {
    const summary = sessionLogger.getSessionSummary();
    res.json({
      ok: true,
      session: summary
    });
  } catch (error) {
    logger.error('Failed to get current session', { error: error.message });
    res.status(500).json({
      ok: false,
      error: 'Failed to get session data'
    });
  }
});

// Get recovery summary for quick context restoration
router.get('/session/recovery', (req, res) => {
  try {
    const recovery = sessionLogger.createRecoverySummary();
    res.json({
      ok: true,
      recovery
    });
  } catch (error) {
    logger.error('Failed to create recovery summary', { error: error.message });
    res.status(500).json({
      ok: false,
      error: 'Failed to create recovery summary'
    });
  }
});

// Get list of all sessions
router.get('/sessions', (req, res) => {
  try {
    const sessions = sessionLogger.getAllSessions();
    res.json({
      ok: true,
      sessions: sessions.slice(0, 50) // Limit to 50 most recent
    });
  } catch (error) {
    logger.error('Failed to list sessions', { error: error.message });
    res.status(500).json({
      ok: false,
      error: 'Failed to list sessions'
    });
  }
});

// Get specific session details
router.get('/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionLogger.loadSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found'
      });
    }

    res.json({
      ok: true,
      session
    });
  } catch (error) {
    logger.error('Failed to load session', { 
      sessionId: req.params.sessionId, 
      error: error.message 
    });
    res.status(500).json({
      ok: false,
      error: 'Failed to load session'
    });
  }
});

// Get session conversations only
router.get('/session/:sessionId/conversations', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionLogger.loadSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found'
      });
    }

    res.json({
      ok: true,
      conversations: session.conversations,
      total: session.conversations.length
    });
  } catch (error) {
    logger.error('Failed to load session conversations', { 
      sessionId: req.params.sessionId, 
      error: error.message 
    });
    res.status(500).json({
      ok: false,
      error: 'Failed to load conversations'
    });
  }
});

// Get session commands only
router.get('/session/:sessionId/commands', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionLogger.loadSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found'
      });
    }

    res.json({
      ok: true,
      commands: session.commands,
      total: session.commands.length,
      successful: session.commands.filter(c => c.success).length
    });
  } catch (error) {
    logger.error('Failed to load session commands', { 
      sessionId: req.params.sessionId, 
      error: error.message 
    });
    res.status(500).json({
      ok: false,
      error: 'Failed to load commands'
    });
  }
});

// Get session edits only
router.get('/session/:sessionId/edits', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionLogger.loadSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found'
      });
    }

    const filesModified = [...new Set(session.edits.map(e => e.filePath))];

    res.json({
      ok: true,
      edits: session.edits,
      total: session.edits.length,
      filesModified: filesModified.length,
      files: filesModified
    });
  } catch (error) {
    logger.error('Failed to load session edits', { 
      sessionId: req.params.sessionId, 
      error: error.message 
    });
    res.status(500).json({
      ok: false,
      error: 'Failed to load edits'
    });
  }
});

// Start a new session manually
router.post('/session/new', (req, res) => {
  try {
    const sessionId = sessionLogger.startNewSession();
    res.json({
      ok: true,
      sessionId,
      message: 'New session started'
    });
  } catch (error) {
    logger.error('Failed to start new session', { error: error.message });
    res.status(500).json({
      ok: false,
      error: 'Failed to start new session'
    });
  }
});

export default router;