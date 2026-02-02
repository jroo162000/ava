// Real-time session and conversation logger
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

class SessionLogger {
  constructor() {
    this.currentSession = null;
    this.ensureLogsDirectory();
    this.startNewSession();
  }

  ensureLogsDirectory() {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
  }

  startNewSession() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionId = `session_${timestamp}`;
    
    this.currentSession = {
      id: sessionId,
      startTime: new Date().toISOString(),
      logFile: path.join(LOGS_DIR, `${sessionId}.json`),
      conversations: [],
      commands: [],
      edits: [],
      errors: [],
      metadata: {
        version: '1.0.0',
        platform: process.platform,
        nodeVersion: process.version
      }
    };

    this.saveSession();
    logger.info('New session started', { sessionId });
    return sessionId;
  }

  logConversation(type, content, metadata = {}) {
    if (!this.currentSession) this.startNewSession();

    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      type, // 'user', 'assistant', 'system'
      content,
      metadata: {
        ...metadata,
        length: content?.length || 0
      }
    };

    this.currentSession.conversations.push(entry);
    this.saveSession();
    
    // Also log to console for immediate visibility
    logger.info('Conversation logged', { type, contentPreview: content?.substring(0, 100) });
  }

  logCommand(command, result, metadata = {}) {
    if (!this.currentSession) this.startNewSession();

    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      command,
      result: result?.substring?.(0, 1000) || result, // Truncate large outputs
      success: !metadata.error,
      metadata: {
        ...metadata,
        duration: metadata.duration || null,
        exitCode: metadata.exitCode || null
      }
    };

    this.currentSession.commands.push(entry);
    this.saveSession();
    
    logger.info('Command logged', { command: command.substring(0, 50) });
  }

  logEdit(filePath, operation, oldContent, newContent, metadata = {}) {
    if (!this.currentSession) this.startNewSession();

    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      filePath,
      operation, // 'create', 'update', 'delete'
      changes: {
        before: oldContent?.substring?.(0, 500) || null,
        after: newContent?.substring?.(0, 500) || null,
        bytesChanged: (newContent?.length || 0) - (oldContent?.length || 0)
      },
      metadata: {
        ...metadata,
        fileExists: fs.existsSync(filePath),
        fileSize: this.getFileSize(filePath)
      }
    };

    this.currentSession.edits.push(entry);
    this.saveSession();
    
    logger.info('Edit logged', { filePath, operation });
  }

  logError(error, context = {}) {
    if (!this.currentSession) this.startNewSession();

    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      name: error.name,
      context
    };

    this.currentSession.errors.push(entry);
    this.saveSession();
    
    logger.error('Error logged', { error: error.message });
  }

  getSessionSummary() {
    if (!this.currentSession) return null;

    const now = new Date();
    const startTime = new Date(this.currentSession.startTime);
    const duration = now - startTime;

    return {
      sessionId: this.currentSession.id,
      startTime: this.currentSession.startTime,
      duration: duration,
      stats: {
        conversations: this.currentSession.conversations.length,
        commands: this.currentSession.commands.length,
        edits: this.currentSession.edits.length,
        errors: this.currentSession.errors.length,
        successfulCommands: this.currentSession.commands.filter(c => c.success).length,
        filesModified: new Set(this.currentSession.edits.map(e => e.filePath)).size
      },
      recentActivity: {
        lastConversation: this.currentSession.conversations.slice(-1)[0],
        lastCommand: this.currentSession.commands.slice(-1)[0],
        lastEdit: this.currentSession.edits.slice(-1)[0]
      }
    };
  }

  getFileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return null;
    }
  }

  saveSession() {
    if (!this.currentSession) return;

    try {
      const sessionData = {
        ...this.currentSession,
        lastUpdated: new Date().toISOString(),
        summary: this.getSessionSummary()
      };

      fs.writeFileSync(this.currentSession.logFile, JSON.stringify(sessionData, null, 2));
      
      // Also maintain a "latest session" symlink/copy for quick access
      const latestPath = path.join(LOGS_DIR, 'latest_session.json');
      fs.writeFileSync(latestPath, JSON.stringify(sessionData, null, 2));
      
    } catch (error) {
      logger.error('Failed to save session', { error: error.message });
    }
  }

  // Load a specific session by ID
  loadSession(sessionId) {
    const logFile = path.join(LOGS_DIR, `${sessionId}.json`);
    try {
      const data = fs.readFileSync(logFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to load session', { sessionId, error: error.message });
      return null;
    }
  }

  // Get all available session IDs
  getAllSessions() {
    try {
      const files = fs.readdirSync(LOGS_DIR);
      return files
        .filter(f => f.startsWith('session_') && f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort()
        .reverse(); // Most recent first
    } catch (error) {
      logger.error('Failed to list sessions', { error: error.message });
      return [];
    }
  }

  // Create a recovery summary from the current session
  createRecoverySummary() {
    if (!this.currentSession) return null;

    const summary = this.getSessionSummary();
    const recentConversations = this.currentSession.conversations.slice(-10);
    const recentCommands = this.currentSession.commands.slice(-10);
    const recentEdits = this.currentSession.edits.slice(-5);

    return {
      sessionInfo: summary,
      contextForRecovery: {
        lastUserMessage: recentConversations.filter(c => c.type === 'user').slice(-1)[0]?.content,
        lastAssistantMessage: recentConversations.filter(c => c.type === 'assistant').slice(-1)[0]?.content,
        recentCommands: recentCommands.map(c => ({
          command: c.command,
          success: c.success,
          timestamp: c.timestamp
        })),
        recentEdits: recentEdits.map(e => ({
          file: e.filePath,
          operation: e.operation,
          timestamp: e.timestamp
        })),
        currentWorkingState: {
          activeFiles: [...new Set(recentEdits.map(e => e.filePath))],
          lastError: this.currentSession.errors.slice(-1)[0],
          projectState: 'AVA assistant improvement project'
        }
      }
    };
  }
}

// Create singleton instance
const sessionLogger = new SessionLogger();
export default sessionLogger;