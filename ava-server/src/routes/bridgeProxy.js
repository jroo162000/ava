// Bridge Proxy Routes - Proxies OS control requests to FastAPI bridge
// Pattern: Client → Node (auth + rate limit) → FastAPI bridge (3333)
// Defense in depth: Node validates AVA_API_TOKEN, bridge validates BRIDGE_TOKEN

import express from 'express';
import http from 'http';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

const router = express.Router();

// Rate limiting state (in-memory, resets on restart)
const rateLimits = new Map(); // ip -> { count, resetTime }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute

// Bridge configuration
const BRIDGE_HOST = config.BRIDGE_HOST || process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = config.BRIDGE_PORT || process.env.BRIDGE_PORT || 3333;
// Default token matches bridge default for local dev
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.AVA_BRIDGE_TOKEN || 'local-dev-token';
const AVA_API_TOKEN = process.env.AVA_API_TOKEN || '';

// ========== Middleware ==========

// Rate limiter middleware
function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  
  let record = rateLimits.get(ip);
  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimits.set(ip, record);
  }
  
  record.count++;
  
  // Add rate limit headers
  res.set('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - record.count)));
  res.set('X-RateLimit-Reset', String(Math.ceil(record.resetTime / 1000)));
  
  if (record.count > RATE_LIMIT_MAX) {
    logger.warn('Rate limit exceeded', { ip, count: record.count });
    return res.status(429).json({
      ok: false,
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((record.resetTime - now) / 1000)
    });
  }
  
  next();
}

// Auth middleware - validates AVA_API_TOKEN
function authMiddleware(req, res, next) {
  // Allow unauthenticated in dev mode if no token configured
  if (!AVA_API_TOKEN) {
    logger.debug('Auth skipped - no AVA_API_TOKEN configured');
    return next();
  }
  
  const authHeader = req.headers.authorization;
  const providedToken = authHeader?.startsWith('Bearer ') 
    ? authHeader.slice(7) 
    : req.headers['x-ava-token'];
  
  if (!providedToken || providedToken !== AVA_API_TOKEN) {
    logger.warn('Unauthorized bridge request', { 
      ip: req.ip, 
      path: req.path,
      hasToken: !!providedToken 
    });
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized - valid AVA_API_TOKEN required'
    });
  }
  
  next();
}

// ========== Bridge Health Check ==========

async function checkBridgeHealth() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: '/health',
      method: 'GET',
      timeout: 2000
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ========== Proxy Function ==========

function proxyToBridge(req, res, targetPath) {
  const body = JSON.stringify(req.body || {});
  
  const options = {
    hostname: BRIDGE_HOST,
    port: BRIDGE_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      // Pass bridge token for defense in depth
      ...(BRIDGE_TOKEN && { 'Authorization': `Bearer ${BRIDGE_TOKEN}` }),
      // Forward client info
      'X-Forwarded-For': req.ip || '',
      'X-Request-Id': `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    },
    timeout: 30000
  };

  logger.info('Proxying to bridge', { 
    method: req.method, 
    path: targetPath,
    bodyLen: body.length 
  });

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.status(proxyRes.statusCode || 200).json(json);
      } catch {
        res.status(proxyRes.statusCode || 200).send(data);
      }
    });
  });

  proxyReq.on('error', (err) => {
    logger.error('Bridge proxy error', { error: err.message, path: targetPath });
    res.status(502).json({
      ok: false,
      error: 'Bridge unavailable',
      hint: 'Start the bridge: python ava_bridge.py',
      details: err.message
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({
      ok: false,
      error: 'Bridge timeout',
      hint: 'The bridge took too long to respond'
    });
  });

  proxyReq.write(body);
  proxyReq.end();
}

// ========== Routes ==========

// Bridge health check (no auth required)
router.get('/bridge/health', async (_req, res) => {
  const healthy = await checkBridgeHealth();
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    bridge: {
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      status: healthy ? 'running' : 'unavailable'
    },
    hint: healthy ? null : 'Start the bridge: python ava_bridge.py'
  });
});

// Bridge status (includes auth status)
router.get('/bridge/status', (req, res) => {
  res.json({
    ok: true,
    config: {
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      authRequired: !!AVA_API_TOKEN,
      bridgeTokenConfigured: !!BRIDGE_TOKEN
    },
    rateLimit: {
      windowMs: RATE_LIMIT_WINDOW,
      max: RATE_LIMIT_MAX
    }
  });
});

// Apply auth and rate limiting to all action routes
router.use('/bridge', rateLimiter);
router.use('/bridge', authMiddleware);

// Execute OS action (open app, file, folder, URL)
router.post('/bridge/execute', async (req, res) => {
  const { action, target, args } = req.body || {};
  
  if (!action) {
    return res.status(400).json({ ok: false, error: 'action is required' });
  }
  
  // Map friendly actions to bridge endpoints
  const actionMap = {
    'open': '/open',
    'open_app': '/open',
    'open_file': '/open',
    'open_folder': '/open',
    'open_url': '/open',
    'run': '/run',
    'execute': '/run',
    'speak': '/speak',
    'tts': '/speak',
    'type': '/type',
    'keypress': '/keypress',
    'screenshot': '/screenshot',
    'clipboard': '/clipboard'
  };
  
  const bridgePath = actionMap[action] || `/${action}`;
  
  // Build bridge request body
  const bridgeBody = { target, args, ...req.body };
  delete bridgeBody.action; // Remove action, it's in the path
  
  // Override req.body for proxy
  req.body = bridgeBody;
  
  proxyToBridge(req, res, bridgePath);
});

// Direct proxy for specific bridge endpoints
router.post('/bridge/open', (req, res) => proxyToBridge(req, res, '/open'));
router.post('/bridge/run', (req, res) => proxyToBridge(req, res, '/run'));
router.post('/bridge/speak', (req, res) => proxyToBridge(req, res, '/speak'));
router.post('/bridge/type', (req, res) => proxyToBridge(req, res, '/type'));
router.post('/bridge/keypress', (req, res) => proxyToBridge(req, res, '/keypress'));
router.post('/bridge/screenshot', (req, res) => proxyToBridge(req, res, '/screenshot'));
router.post('/bridge/clipboard', (req, res) => proxyToBridge(req, res, '/clipboard'));
router.get('/bridge/clipboard', (req, res) => proxyToBridge(req, res, '/clipboard'));

// Wildcard proxy for any other bridge endpoint
router.all('/bridge/*', (req, res) => {
  const bridgePath = req.path.replace('/bridge', '');
  proxyToBridge(req, res, bridgePath);
});

export default router;
