// AVA Server - Consolidated Single Entrypoint
// Phase 1: All routes consolidated here. Port 5051.
// Phase 2: Bridge proxy added for OS control via FastAPI bridge (port 3333)
// Phase 4: Agent loop added for unified control (Observe → Decide → Act → Record)
// Phase 5: Memory as state with just-in-time injection
// Phase 7: Security hardening
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import config from './utils/config.js';
import logger from './utils/logger.js';
import security from './utils/security.js';
import apiRoutes from './routes/api.js';
import monitoringRoutes from './routes/monitoring.js';
import learningRoutes from './routes/learning.js';
import toolsRoutes from './routes/tools.js';
import bridgeProxyRoutes from './routes/bridgeProxy.js';
import agentRoutes from './routes/agent.js';
import memoryRoutes from './routes/memory.js';
import securityRoutes from './routes/security.js';
import voiceRoutes, { registerVoiceWsClient } from './routes/voice.js';
import doctorService from './services/doctor.js';
import digestScheduler from './services/digestScheduler.js';
import moltbookScheduler from './services/moltbookScheduler.js';

// Phase 7: Security audit at startup
const isProd = process.env.NODE_ENV === 'production';
const securityAudit = security.auditSecrets(process.cwd(), isProd);
if (!securityAudit.ok) {
  console.error('\n❌ Security audit failed in production mode!');
  console.error(securityAudit.errors.join('\n'));
  console.error('Exiting...\n');
  process.exit(1);
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(security.securityMiddleware);  // Phase 7: Security middleware

// Request logging (minimal)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path !== '/health' && !req.path.startsWith('/bridge/health')) {
      logger.info(`${req.method} ${req.path}`, { status: res.statusCode, ms: Date.now() - start });
    }
  });
  next();
});

// Routes - ORDER MATTERS (more specific first)
app.use('/', agentRoutes);       // /agent/* - unified control loop
app.use('/', memoryRoutes);      // /memory/* - memory management (Phase 5)
app.use('/', securityRoutes);    // /security/* - security endpoints (Phase 7)
app.use('/voice', voiceRoutes);  // /voice/* - voice events from Python
app.use('/', bridgeProxyRoutes); // /bridge/* → FastAPI bridge (3333)
app.use('/', toolsRoutes);       // /tools, /tools/:name
app.use('/', learningRoutes);    // /self/*, /rlhf/*, /eta/*, /learn
app.use('/', monitoringRoutes);  // /health, /metrics, /debug
app.use('/', apiRoutes);         // /chat, /respond, /memory/*, etc.

// Error handling
app.use((error, req, res, _next) => {
  logger.error('Unhandled error', { error: error.message, path: req.path });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found', path: req.originalUrl });
});

// HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientId = `ws-${Date.now().toString(36)}`;
  logger.info('WebSocket connected', { clientId });
  
  // Register for voice events if requested
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/voice/ws') {
    registerVoiceWsClient(ws);
  }
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch (e) {
      logger.warn('WebSocket parse error', { error: e.message });
    }
  });
  
  ws.on('close', () => logger.debug('WebSocket closed', { clientId }));
  ws.send(JSON.stringify({ type: 'welcome', clientId, ts: Date.now() }));
});

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server on port 5051
const PORT = config.PORT || 5051;
const HOST = config.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info(`AVA Server started on http://${HOST}:${PORT}`, {
    allowWrite: config.ALLOW_WRITE,
    bridgePort: process.env.BRIDGE_PORT || 3333,
    build: config.BUILD_STAMP,
    securityAudit: securityAudit.ok ? 'passed' : 'warnings'
  });
  console.log(`\n🤖 AVA Server ready: http://127.0.0.1:${PORT}`);
  console.log(`   Bridge proxy: /bridge/* → 127.0.0.1:${process.env.BRIDGE_PORT || 3333}`);
  console.log(`   Agent loop:   /agent/run`);
  console.log(`   Memory:       /memory/stats, /memory/search`);
  console.log(`   Security:     /security/status, /security/audit`);
  console.log(`   Voice:        /voice/status, /voice/events`);
  console.log(`   Mode:         ${isProd ? 'PRODUCTION' : 'development'}`);
  if (securityAudit.insecureFiles && securityAudit.insecureFiles.length > 0) {
    console.log(`   ⚠️  Warnings:    ${securityAudit.insecureFiles.length} plaintext key file(s)`);
  }
  console.log('');
  // Initialize weekly maintenance scheduler
  try {
    doctorService.scheduleWeeklyReport();
  } catch (e) {
    logger.warn('Failed to start maintenance scheduler', { error: e.message });
  }
  // Start digest auto-flush scheduler
  try {
    digestScheduler.startDigestScheduler();
  } catch (e) {
    logger.warn('Failed to start digest scheduler', { error: e.message });
  }
  // Start Moltbook learning scheduler (curiosity-governed)
  try {
    moltbookScheduler.startMoltbookScheduler();
  } catch (e) {
    logger.warn('Failed to start Moltbook scheduler', { error: e.message });
  }
});

export default app;
