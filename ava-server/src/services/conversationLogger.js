// Real-time conversation logging service
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ConversationLogger {
  constructor() {
    this.logsDir = path.join(__dirname, '..', '..', 'logs', 'conversations');
    this.ensureLogsDirectory();
    this.currentSession = null;
    this.sessionStartTime = null;
  }

  ensureLogsDirectory() {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to create logs directory', { error: error.message });
    }
  }

  startSession(sessionId = null) {
    this.sessionStartTime = new Date();
    this.currentSession = sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const sessionInfo = {
      sessionId: this.currentSession,
      startTime: this.sessionStartTime.toISOString(),
      type: 'session_start',
      metadata: {
        platform: process.platform,
        nodeVersion: process.version,
        timestamp: Date.now()
      }
    };

    this.writeLog(sessionInfo);
    logger.info('Started conversation session', { sessionId: this.currentSession });
    return this.currentSession;
  }

  logMessage(direction, content, metadata = {}) {
    if (!this.currentSession) {
      this.startSession();
    }

    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      unixTime: Date.now(),
      type: 'message',
      direction, // 'user' or 'assistant'
      content,
      metadata: {
        messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        wordCount: typeof content === 'string' ? content.split(/\s+/).length : 0,
        characterCount: typeof content === 'string' ? content.length : 0,
        ...metadata
      }
    };

    this.writeLog(logEntry);
    return logEntry.metadata.messageId;
  }

  logUserMessage(content, metadata = {}) {
    return this.logMessage('user', content, {
      ...metadata,
      source: metadata.source || 'text'
    });
  }

  logAssistantMessage(content, metadata = {}) {
    return this.logMessage('assistant', content, {
      ...metadata,
      model: metadata.model || 'unknown',
      responseTime: metadata.responseTime || null,
      tokens: metadata.tokens || null
    });
  }

  logSystemEvent(eventType, data = {}) {
    if (!this.currentSession) {
      this.startSession();
    }

    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      unixTime: Date.now(),
      type: 'system_event',
      eventType,
      data
    };

    this.writeLog(logEntry);
  }

  logError(error, context = {}) {
    const logEntry = {
      sessionId: this.currentSession || 'no-session',
      timestamp: new Date().toISOString(),
      unixTime: Date.now(),
      type: 'error',
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      context
    };

    this.writeLog(logEntry);
  }

  writeLog(entry) {
    try {
      const filename = this.getLogFilename();
      const logLine = JSON.stringify(entry) + '\n';
      fs.appendFileSync(filename, logLine, 'utf8');
    } catch (error) {
      logger.error('Failed to write conversation log', { error: error.message });
    }
  }

  getLogFilename() {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logsDir, `conversation-${date}.jsonl`);
  }

  endSession() {
    if (!this.currentSession) return;

    const sessionEnd = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'session_end',
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime.getTime() : null
    };

    this.writeLog(sessionEnd);
    logger.info('Ended conversation session', { 
      sessionId: this.currentSession,
      duration: sessionEnd.duration 
    });

    this.currentSession = null;
    this.sessionStartTime = null;
  }

  getSessionSummary() {
    if (!this.currentSession) return null;

    return {
      sessionId: this.currentSession,
      startTime: this.sessionStartTime?.toISOString(),
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime.getTime() : null,
      logFile: this.getLogFilename()
    };
  }

  // Read recent conversation history
  getRecentHistory(limit = 50) {
    try {
      const filename = this.getLogFilename();
      if (!fs.existsSync(filename)) return [];

      const content = fs.readFileSync(filename, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      
      return lines
        .slice(-limit)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(entry => entry && entry.type === 'message');
    } catch (error) {
      logger.error('Failed to read conversation history', { error: error.message });
      return [];
    }
  }

  // Search conversations by content
  searchConversations(query, days = 7) {
    const results = [];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    try {
      const files = fs.readdirSync(this.logsDir)
        .filter(file => file.startsWith('conversation-') && file.endsWith('.jsonl'))
        .sort()
        .reverse(); // Most recent first

      for (const file of files) {
        const filePath = path.join(this.logsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'message' && 
                typeof entry.content === 'string' && 
                entry.content.toLowerCase().includes(query.toLowerCase())) {
              results.push(entry);
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error) {
      logger.error('Failed to search conversations', { error: error.message });
    }

    return results.slice(0, 100); // Limit results
  }
}

// Export singleton instance
const conversationLogger = new ConversationLogger();
export default conversationLogger;