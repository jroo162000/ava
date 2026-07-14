import { jest } from '@jest/globals';
import { drainAnnouncements, pushAnnouncement } from '../src/services/announceQueue.js';
import conversationLogger from '../src/services/conversationLogger.js';

describe('background announcement delivery', () => {
  beforeEach(() => drainAnnouncements());

  afterEach(() => {
    jest.restoreAllMocks();
    drainAnnouncements();
  });

  test('queues speech and publishes the same words to chat and conversation logs', () => {
    const log = jest.spyOn(conversationLogger, 'logAssistantMessage').mockReturnValue('msg-test');

    pushAnnouncement('The workflow failed safely.', {
      sessionId: 'session-origin',
      responseType: 'workflow-status',
      source: 'workflow',
    });

    expect(drainAnnouncements()).toEqual(['The workflow failed safely.']);
    expect(log).toHaveBeenCalledWith('The workflow failed safely.', expect.objectContaining({
      sessionId: 'session-origin',
      responseType: 'workflow-status',
      source: 'workflow',
    }));
  });

  test('an async result keeps the session that started it', () => {
    const previous = conversationLogger.currentSession;
    conversationLogger.currentSession = 'session-now';
    const write = jest.spyOn(conversationLogger, 'writeLog').mockImplementation(() => {});

    try {
      conversationLogger.logAssistantMessage('Sandbox result', { sessionId: 'session-origin' });
      expect(write).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-origin',
        direction: 'assistant',
        content: 'Sandbox result',
      }));
    } finally {
      conversationLogger.currentSession = previous;
    }
  });
});
