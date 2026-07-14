// Real-time conversation logging service
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';
import { emitVoiceEvent } from './voiceBus.js';
import avatarBody from './avatarBody.js';

class ConversationLogger {
  constructor() {
    this.logsDir = avaPaths.conversationLogsDir();
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
      this.startSession(metadata.sessionId || null);
    }

    // An asynchronous workflow can finish after another turn has become current.
    // Preserve the initiating session when the caller supplies it.
    const sessionId = metadata.sessionId || this.currentSession;

    const logEntry = {
      sessionId,
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

    // Mirror every turn to the live UI (voice + web chat). The UI dedupes its own
    // locally-shown web-chat turns by content, so voice turns are what surface there.
    try {
      emitVoiceEvent(
        direction === 'assistant' ? 'assistant.final' : 'transcript.final',
        {
          text: content,
          endpoint: logEntry.metadata.endpoint || '',
          responseType: logEntry.metadata.responseType || '',
          source: logEntry.metadata.source || '',
          messageId: logEntry.metadata.messageId,
        },
        'conversation'
      );
    } catch { /* never break logging on telemetry */ }

    return logEntry.metadata.messageId;
  }

  logUserMessage(content, metadata = {}) {
    return this.logMessage('user', content, {
      ...metadata,
      source: metadata.source || 'text'
    });
  }

  logAssistantMessage(content, metadata = {}) {
    // Native embodiment: execute her inline <move>{...}</move> body directives
    // and strip them from the text. This is the ONE place they execute (every
    // reply path logs through here exactly once); the stream route strips
    // without executing so nothing double-fires and no tag is ever spoken.
    let clean = content;
    try { clean = avatarBody.extractAndApply(content); } catch { /* keep original */ }
    return this.logMessage('assistant', clean, {
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

  // Read recent conversation history from the daily JSONL file
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

  // Read the last n conversation turns (user/assistant messages) from the daily JSONL file.
  // Each turn is returned as { timestamp, role, text } where role is 'user' or 'assistant'.
  getConversationTurns(n = 10) {
    try {
      const messages = this.getRecentHistory(n);
      const turns = [];
      for (const entry of messages) {
        if (entry.type === 'message' && entry.direction && entry.content) {
          turns.push({
            timestamp: entry.timestamp || entry.unixTime || null,
            role: entry.direction === 'user' ? 'user' : 'assistant',
            text: String(entry.content)
          });
        }
      }
      return turns.slice(-n);
    } catch (error) {
      logger.error('Failed to get conversation turns', { error: error.message });
      return [];
    }
  }

  // Recent message history spanning MULTIPLE day-files (newest backward), so she can
  // "pick up where we left off" across sessions, not just within today.
  getRecentHistoryAcrossDays(limit = 12) {
    try {
      if (!fs.existsSync(this.logsDir)) return [];
      const files = fs.readdirSync(this.logsDir)
        .filter(f => f.startsWith('conversation-') && f.endsWith('.jsonl'))
        .sort(); // ascending by YYYY-MM-DD
      let collected = [];
      for (let i = files.length - 1; i >= 0; i--) {
        const content = fs.readFileSync(path.join(this.logsDir, files[i]), 'utf8');
        const msgs = content.trim().split('\n').filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(e => e && e.type === 'message');
        collected = msgs.concat(collected); // older file's messages go before newer
        if (collected.length >= limit) break;
      }
      return collected.slice(-limit);
    } catch (error) {
      logger.error('Failed to read cross-day history', { error: error.message });
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
export const getConversationTurns = (n = 10) => conversationLogger.getConversationTurns(n);
