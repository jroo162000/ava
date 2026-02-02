// Work Session Logger for Claude Code sessions
// This logs our development work, decisions, and progress
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WorkSessionLogger {
  constructor() {
    this.sessionsDir = __dirname;
    this.currentSession = null;
    this.sessionStartTime = null;
    this.taskCounter = 0;
    this.ensureDirectory();
    this.startNewSession();
  }

  ensureDirectory() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  startNewSession() {
    this.sessionStartTime = new Date();
    this.currentSession = `claude-session-${this.sessionStartTime.toISOString().split('T')[0]}-${Date.now()}`;
    this.taskCounter = 0;

    const sessionHeader = {
      sessionId: this.currentSession,
      startTime: this.sessionStartTime.toISOString(),
      type: 'session_start',
      metadata: {
        platform: process.platform,
        workingDirectory: process.cwd(),
        nodeVersion: process.version,
        sessionPurpose: 'AVa development and enhancement'
      }
    };

    this.writeLog(sessionHeader);
    console.log(`[WorkSessionLogger] Started session: ${this.currentSession}`);
    return this.currentSession;
  }

  // Log a task or action taken
  logTask(action, details = {}, status = 'completed') {
    this.taskCounter++;
    
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'task',
      taskNumber: this.taskCounter,
      action,
      status, // 'started', 'in_progress', 'completed', 'failed', 'skipped'
      details,
      duration: details.duration || null
    };

    this.writeLog(logEntry);
    return this.taskCounter;
  }

  // Log a decision made during development
  logDecision(decision, reasoning, alternatives = []) {
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'decision',
      decision,
      reasoning,
      alternatives,
      context: 'development'
    };

    this.writeLog(logEntry);
  }

  // Log code changes made
  logCodeChange(filePath, changeType, description, before = null, after = null) {
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'code_change',
      filePath,
      changeType, // 'create', 'edit', 'delete', 'rename', 'move'
      description,
      before,
      after,
      size: after ? after.length : null
    };

    this.writeLog(logEntry);
  }

  // Log system status or observations
  logStatus(system, status, details = {}) {
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'status',
      system, // 'ava-server', 'ava-client', 'database', 'api', etc.
      status, // 'running', 'stopped', 'error', 'healthy', etc.
      details
    };

    this.writeLog(logEntry);
  }

  // Log discoveries or insights
  logDiscovery(finding, impact, actionNeeded = null) {
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'discovery',
      finding,
      impact,
      actionNeeded,
      priority: actionNeeded ? 'medium' : 'low'
    };

    this.writeLog(logEntry);
  }

  // Log errors and issues
  logIssue(issue, severity, resolution = null, timeToResolve = null) {
    const logEntry = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'issue',
      issue,
      severity, // 'low', 'medium', 'high', 'critical'
      resolution,
      timeToResolve,
      resolved: !!resolution
    };

    this.writeLog(logEntry);
  }

  // Log session summary and wrap up
  endSession(summary = '', accomplishments = [], nextSteps = []) {
    const sessionEnd = {
      sessionId: this.currentSession,
      timestamp: new Date().toISOString(),
      type: 'session_end',
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime.getTime() : null,
      tasksCompleted: this.taskCounter,
      summary,
      accomplishments,
      nextSteps
    };

    this.writeLog(sessionEnd);
    console.log(`[WorkSessionLogger] Ended session: ${this.currentSession}`);
    console.log(`[WorkSessionLogger] Tasks completed: ${this.taskCounter}`);
    
    // Reset for next session
    this.currentSession = null;
    this.sessionStartTime = null;
    this.taskCounter = 0;
  }

  // Write log entry to file
  writeLog(entry) {
    try {
      const filename = this.getLogFilename();
      const logLine = JSON.stringify(entry, null, 2) + '\n---\n';
      fs.appendFileSync(filename, logLine, 'utf8');
    } catch (error) {
      console.error('Failed to write work session log:', error.message);
    }
  }

  // Get current log filename
  getLogFilename() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.sessionsDir, `work-session-${date}.md`);
  }

  // Get session summary
  getSessionSummary() {
    if (!this.currentSession) return null;

    return {
      sessionId: this.currentSession,
      startTime: this.sessionStartTime?.toISOString(),
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime.getTime() : null,
      tasksCompleted: this.taskCounter,
      logFile: this.getLogFilename()
    };
  }

  // Export session as readable markdown
  exportSessionMarkdown(sessionId = null) {
    try {
      const targetSession = sessionId || this.currentSession;
      if (!targetSession) return null;

      const filename = this.getLogFilename();
      if (!fs.existsSync(filename)) return null;

      const content = fs.readFileSync(filename, 'utf8');
      const entries = content.split('---\n').filter(section => section.trim());

      let markdown = `# Work Session: ${targetSession}\n\n`;
      
      entries.forEach(entryText => {
        try {
          const entry = JSON.parse(entryText.trim());
          
          if (entry.type === 'session_start') {
            markdown += `**Started:** ${entry.startTime}\n`;
            markdown += `**Purpose:** ${entry.metadata?.sessionPurpose || 'Development work'}\n\n`;
          } else if (entry.type === 'task') {
            markdown += `## Task ${entry.taskNumber}: ${entry.action}\n`;
            markdown += `**Status:** ${entry.status}\n`;
            markdown += `**Time:** ${entry.timestamp}\n`;
            if (entry.details && Object.keys(entry.details).length > 0) {
              markdown += `**Details:** ${JSON.stringify(entry.details, null, 2)}\n`;
            }
            markdown += '\n';
          } else if (entry.type === 'decision') {
            markdown += `## Decision: ${entry.decision}\n`;
            markdown += `**Reasoning:** ${entry.reasoning}\n`;
            if (entry.alternatives.length > 0) {
              markdown += `**Alternatives considered:** ${entry.alternatives.join(', ')}\n`;
            }
            markdown += '\n';
          } else if (entry.type === 'code_change') {
            markdown += `## Code Change: ${entry.changeType}\n`;
            markdown += `**File:** ${entry.filePath}\n`;
            markdown += `**Description:** ${entry.description}\n`;
            markdown += '\n';
          } else if (entry.type === 'discovery') {
            markdown += `## Discovery: ${entry.finding}\n`;
            markdown += `**Impact:** ${entry.impact}\n`;
            if (entry.actionNeeded) {
              markdown += `**Action Needed:** ${entry.actionNeeded}\n`;
            }
            markdown += '\n';
          } else if (entry.type === 'session_end') {
            markdown += `## Session Summary\n`;
            markdown += `**Ended:** ${entry.timestamp}\n`;
            markdown += `**Duration:** ${Math.round(entry.duration / 1000 / 60)} minutes\n`;
            markdown += `**Tasks Completed:** ${entry.tasksCompleted}\n`;
            if (entry.summary) {
              markdown += `**Summary:** ${entry.summary}\n`;
            }
            if (entry.accomplishments.length > 0) {
              markdown += `**Accomplishments:**\n${entry.accomplishments.map(a => `- ${a}`).join('\n')}\n`;
            }
            if (entry.nextSteps.length > 0) {
              markdown += `**Next Steps:**\n${entry.nextSteps.map(s => `- ${s}`).join('\n')}\n`;
            }
          }
        } catch (parseError) {
          // Skip invalid JSON entries
        }
      });

      return markdown;
    } catch (error) {
      console.error('Failed to export session markdown:', error.message);
      return null;
    }
  }
}

// Export singleton instance
const workSessionLogger = new WorkSessionLogger();

// Log the current session startup
workSessionLogger.logTask('Initialize work session logger', {
  purpose: 'Track Claude Code development sessions',
  features: ['task logging', 'decision tracking', 'code change tracking', 'session summaries']
});

export default workSessionLogger;