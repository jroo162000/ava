// Voice Events Routes
// Receives events from Python voice module and broadcasts to clients
import { Router } from 'express';
import logger from '../utils/logger.js';

const router = Router();

// Store recent events for debugging (circular buffer)
const recentEvents = [];
const MAX_EVENTS = 100;

// WebSocket clients for real-time broadcasting
const wsClients = new Set();

/**
 * Register WebSocket client for voice events
 */
export function registerVoiceWsClient(ws) {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  logger.info('[voice] WebSocket client connected', { clients: wsClients.size });
}

/**
 * Broadcast event to all WebSocket clients
 */
function broadcastEvent(event) {
  const message = JSON.stringify(event);
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(message);
      }
    } catch (e) {
      // Client disconnected
      wsClients.delete(ws);
    }
  }
}

/**
 * Store event in circular buffer
 */
function storeEvent(event) {
  recentEvents.push({
    ...event,
    received_at: Date.now()
  });
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.shift();
  }
}

// ============================================
// Voice Event Endpoints
// ============================================

/**
 * POST /voice/event
 * Receive single voice event from Python module
 */
router.post('/event', (req, res) => {
  try {
    const event = req.body;
    
    if (!event || !event.type) {
      return res.status(400).json({ ok: false, error: 'Invalid event: missing type' });
    }

    // Log important events
    const eventType = event.type;
    if (eventType.includes('final') || eventType.includes('error') || eventType.includes('started') || eventType.includes('stopped')) {
      logger.info(`[voice] ${eventType}`, event.data || {});
    } else if (logger.level === 'debug') {
      logger.debug(`[voice] ${eventType}`, event.data || {});
    }

    // Store and broadcast
    storeEvent(event);
    broadcastEvent(event);

    // Handle specific event types
    handleEvent(event);

    res.json({ ok: true, received: eventType });
  } catch (e) {
    logger.error('[voice] Event processing error', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /voice/event/batch
 * Receive batch of voice events
 */
router.post('/event/batch', (req, res) => {
  try {
    const events = req.body;
    
    if (!Array.isArray(events)) {
      return res.status(400).json({ ok: false, error: 'Expected array of events' });
    }

    for (const event of events) {
      if (event && event.type) {
        storeEvent(event);
        broadcastEvent(event);
        handleEvent(event);
      }
    }

    logger.debug('[voice] Batch received', { count: events.length });
    res.json({ ok: true, received: events.length });
  } catch (e) {
    logger.error('[voice] Batch processing error', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /voice/events
 * Get recent voice events (for debugging)
 */
router.get('/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_EVENTS);
  const type = req.query.type;
  
  let events = recentEvents.slice(-limit);
  
  if (type) {
    events = events.filter(e => e.type && e.type.includes(type));
  }
  
  res.json({
    ok: true,
    count: events.length,
    events: events.reverse() // Most recent first
  });
});

/**
 * GET /voice/status
 * Get voice system status
 */
router.get('/status', (req, res) => {
  // Find most recent status events
  const startedEvent = [...recentEvents].reverse().find(e => e.type === 'voice.started');
  const stoppedEvent = [...recentEvents].reverse().find(e => e.type === 'voice.stopped');
  
  const isRunning = startedEvent && (!stoppedEvent || startedEvent.timestamp > stoppedEvent.timestamp);
  
  // Get recent transcript
  const lastTranscript = [...recentEvents].reverse().find(e => e.type === 'transcript.final');
  
  // Get connected agent
  const agentEvent = [...recentEvents].reverse().find(e => e.type === 'agent.connected');
  
  res.json({
    ok: true,
    status: {
      running: isRunning,
      mode: startedEvent?.data?.mode || 'unknown',
      wsClients: wsClients.size,
      recentEventsCount: recentEvents.length,
      lastTranscript: lastTranscript?.data?.text || null,
      agent: agentEvent?.data || null,
      uptime: isRunning && startedEvent ? Date.now() - (startedEvent.timestamp * 1000) : 0
    }
  });
});

/**
 * POST /voice/toggle
 * Toggle voice on/off (sends command to Python module)
 */
router.post('/toggle', async (req, res) => {
  const { action } = req.body; // 'start' or 'stop'
  
  // This would typically communicate with the Python voice module
  // For now, just acknowledge the request
  logger.info('[voice] Toggle requested', { action });
  
  res.json({
    ok: true,
    action,
    message: `Voice ${action} requested`
  });
});

/**
 * POST /voice/speak
 * Request TTS synthesis (for manual text-to-speech)
 */
router.post('/speak', async (req, res) => {
  const { text } = req.body;
  
  if (!text) {
    return res.status(400).json({ ok: false, error: 'Missing text' });
  }
  
  // Broadcast speak request event
  const event = {
    type: 'tts.request',
    timestamp: Date.now() / 1000,
    data: { text },
    source: 'server'
  };
  
  storeEvent(event);
  broadcastEvent(event);
  
  logger.info('[voice] Speak requested', { text: text.substring(0, 50) });
  
  res.json({ ok: true, queued: true });
});

/**
 * GET /voice/providers
 * Get available voice providers
 */
router.get('/providers', (req, res) => {
  // Get provider info from recent events
  const providerEvents = recentEvents.filter(e => 
    e.type === 'agent.connected' || e.type === 'provider.switched'
  );
  
  res.json({
    ok: true,
    providers: {
      available: ['deepgram_agent', 'vosk', 'whisper', 'edge_tts'],
      current: providerEvents.length > 0 ? providerEvents[providerEvents.length - 1].data : null
    }
  });
});

// ============================================
// Event Handlers
// ============================================

/**
 * Handle specific event types with side effects
 */
function handleEvent(event) {
  switch (event.type) {
    case 'transcript.final':
      // Could trigger agent processing here
      break;
      
    case 'voice.error':
      logger.warn('[voice] Error event', event.data);
      break;
      
    case 'function.call':
      // Could route to tool execution
      logger.info('[voice] Function call', event.data);
      break;
      
    case 'barge.in':
      logger.debug('[voice] Barge-in detected', event.data);
      break;
      
    case 'health.status':
      // Could update health monitoring
      break;
  }
}

export default router;
