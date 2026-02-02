// Express middleware for session tracking
import sessionLogger from '../services/sessionLogger.js';

// Middleware to track API requests and responses
export function trackRequests(req, res, next) {
  const startTime = Date.now();
  
  // Log the incoming request
  sessionLogger.logCommand(`${req.method} ${req.path}`, 'Request initiated', {
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });

  // Capture the original response methods
  const originalSend = res.send;
  const originalJson = res.json;

  // Override res.send to capture response
  res.send = function(data) {
    const duration = Date.now() - startTime;
    const success = res.statusCode < 400;
    
    sessionLogger.logCommand(`${req.method} ${req.path}`, data?.toString?.() || 'Response sent', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      success,
      duration,
      responseSize: data?.length || 0
    });

    return originalSend.call(this, data);
  };

  // Override res.json to capture JSON responses
  res.json = function(data) {
    const duration = Date.now() - startTime;
    const success = res.statusCode < 400;
    
    sessionLogger.logCommand(`${req.method} ${req.path}`, JSON.stringify(data), {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      success,
      duration,
      responseSize: JSON.stringify(data).length
    });

    return originalJson.call(this, data);
  };

  next();
}

// Middleware to track conversations
export function trackConversations(req, res, next) {
  // Only track chat/conversation endpoints
  if (req.path.includes('/chat') || req.path.includes('/respond')) {
    if (req.body?.message) {
      sessionLogger.logConversation('user', req.body.message, {
        endpoint: req.path,
        sessionId: req.body.sessionId || 'unknown',
        timestamp: new Date().toISOString()
      });
    }

    // Intercept the response to log assistant replies
    const originalJson = res.json;
    res.json = function(data) {
      if (data?.response || data?.message) {
        sessionLogger.logConversation('assistant', data.response || data.message, {
          endpoint: req.path,
          sessionId: req.body?.sessionId || 'unknown',
          model: data.model || 'unknown',
          tokensUsed: data.usage?.total_tokens || null
        });
      }
      return originalJson.call(this, data);
    };
  }
  
  next();
}

// Error tracking middleware
export function trackErrors(err, req, res, next) {
  sessionLogger.logError(err, {
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query,
    timestamp: new Date().toISOString()
  });
  
  next(err);
}