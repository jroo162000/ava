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
import { ensureApiToken, requireAuth, presentedToken, timingSafeEqualStr } from './utils/security.js';
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
import selfImprove from './services/selfImprove.js';
import workflowEngine from './services/workflowEngine.js';
import proactiveAutonomy from './services/proactiveAutonomy.js';
import autoEval from './services/autoEval.js';
import windowJanitor from './services/windowJanitor.js';
import selfReflection from './services/selfReflection.js';
import environmentContext from './services/environmentContext.js';   // Tier 3 #18: vitals source
import { emitVoiceEvent } from './services/voiceBus.js';             // Tier 3 #18: sys.stats broadcast

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

// Tier 0 security: every route (except /health) requires AVA_API_TOKEN.
// Generated + persisted to ava-integration/.env automatically if absent.
const API_TOKEN = ensureApiToken();

// Tier 0 security: CORS locked to local origins only (UI dev server, Electron).
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const corsOptions = {
  origin(origin, cb) {
    // No Origin header = same-origin/non-browser client (voice runner, curl) — allow.
    if (!origin || LOCAL_ORIGIN.test(origin)) return cb(null, true);
    logger.warn('[security] Blocked cross-origin request', { origin });
    return cb(null, false);
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'X-AVA-Token']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requireAuth(API_TOKEN));       // Tier 0: token auth on everything but /health
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
  // Tier 0 security: WebSocket clients must present the API token too
  // (Authorization header, X-AVA-Token, or ?token= query param).
  const wsToken = presentedToken(req);
  if (!wsToken || !timingSafeEqualStr(wsToken, API_TOKEN)) {
    logger.warn('[security] Rejected unauthenticated WebSocket', { url: req.url });
    try { ws.close(4401, 'Unauthorized'); } catch { /* ignore */ }
    return;
  }

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
  // Guard: skip all schedulers when voice mode is active
  if (process.env.DISABLE_AUTONOMY === '1') {
    logger.info('[autonomy] disabled (voice mode) — all schedulers skipped (doctor, digest, moltbook)');
  } else {
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
  }

  // Self-improvement loop: queues proposed code changes for the user's approval (UI/voice).
  // Runs even in voice mode (lightweight, infrequent) — gated by its own AVA_SELF_IMPROVE_OFF.
  try {
    selfImprove.start();
  } catch (e) {
    logger.warn('Failed to start self-improvement loop', { error: e.message });
  }

  // Tier 3 #22: proactive multi-day autonomy — she autonomously investigates high-value
  // openings READ-ONLY over time and files approval-gated recommendations. AVA_PROACTIVE_AUTONOMY=0 off.
  try {
    proactiveAutonomy.start();
  } catch (e) {
    logger.warn('Failed to start proactive autonomy', { error: e.message });
  }

  // Tier 3 #21 auto A/B: after a restart that loaded an applied routing change, re-measure her
  // routing accuracy and keep-or-revert vs the pre-apply baseline. AVA_AUTO_EVAL=0 off.
  try {
    autoEval.startup();
  } catch (e) {
    logger.warn('Failed to arm auto-eval', { error: e.message });
  }

  // Proactive housekeeping: close leftover, unused Command Prompt and File Explorer windows around
  // the clock (skips the focused window + freshly-opened consoles). Scoped to just those two.
  try {
    windowJanitor.start();
  } catch (e) {
    logger.warn('Failed to start window janitor', { error: e.message });
  }

  // Metacognitive loop: listen to assistant turns on the voice bus, distill self-reflective
  // sentences, and log them to logs/selfReflections.jsonl (autonomous, read-only, best-effort).
  try {
    selfReflection.start();
  } catch (e) {
    logger.warn('Failed to start self-reflection', { error: e.message });
  }

  // Long-horizon workflows: resume any multi-stage workflow that was mid-run when we last stopped,
  // picking up from its last checkpoint. This is what makes long workflows survive restarts.
  try {
    workflowEngine.resumeIncomplete();
  } catch (e) {
    logger.warn('Failed to resume incomplete workflows', { error: e.message });
  }

  // Moltbook learning/posting loop — user wants it running even in voice mode. Idempotent
  // (no-ops if already started above). When DISABLE_AUTONOMY=1 it needs AVA_MOLTBOOK_FORCE=1,
  // and a Moltbook API key at ~/.config/moltbook/credentials.json to actually post/respond/fetch.
  try {
    moltbookScheduler.startMoltbookScheduler();
  } catch (e) {
    logger.warn('Failed to force-start Moltbook scheduler', { error: e.message });
  }

  // Tier 3 #18: broadcast live machine vitals (cpu/ram/foreground/disk/uptime) to the Stage's
  // vitals strip every 5s. Broadcast-only transient (voiceBus marks sys.stats non-storable), so
  // it never fills the debug buffer or gets replayed on reconnect. Disable with AVA_SYS_STATS_OFF=1.
  if (process.env.AVA_SYS_STATS_OFF !== '1') {
    const emitStats = () => {
      try { emitVoiceEvent('sys.stats', environmentContext.getVitals(), 'server'); } catch { /* best effort */ }
    };
    const statsTimer = setInterval(emitStats, parseInt(process.env.AVA_SYS_STATS_MS || '5000', 10) || 5000);
    if (statsTimer.unref) statsTimer.unref();
    setTimeout(emitStats, 1500);
  }
});

export default app;
