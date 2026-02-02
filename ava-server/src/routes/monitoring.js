// Monitoring and health check routes
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from '../services/memory.js';
import llmService from '../services/llm.js';
import toolsService from '../services/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const router = express.Router();

// Simple health: include tool readiness + version/build
router.get('/health', async (_req, res) => {
  try {
    let toolsReady = false;
    let toolsCount = 0;
    try {
      const tools = await toolsService.getAllTools();
      toolsCount = Array.isArray(tools) ? tools.length : 0;
      toolsReady = toolsCount > 0;
    } catch (e) {
      toolsReady = false;
    }
    return res.json({
      ok: true,
      tools: toolsReady ? 'ready' : 'empty',
      toolsCount,
      version: '0.1.0',
      build: config.BUILD_STAMP,
      allowWrite: config.ALLOW_WRITE === true
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Detailed health check
router.get('/health/detailed', async (req, res) => {
  const startTime = Date.now();
  const checks = {};
  
  try {
    // Check OpenAI API
    checks.openai = { status: 'checking' };
    if (config.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${config.OPENAI_API_KEY}` },
          signal: AbortSignal.timeout(5000)
        });
        checks.openai = {
          status: response.ok ? 'healthy' : 'degraded',
          responseTime: Date.now() - startTime,
          details: response.ok ? 'API accessible' : `HTTP ${response.status}`
        };
      } catch (error) {
        checks.openai = {
          status: 'unhealthy',
          error: error.message
        };
      }
    } else {
      checks.openai = {
        status: 'disabled',
        details: 'No API key configured'
      };
    }

    // Check memory service
    checks.memory = { status: 'checking' };
    try {
      const memoryStats = memoryService.getStats();
      checks.memory = {
        status: 'healthy',
        count: memoryStats.count,
        storage: memoryStats.storage,
        embeddingProvider: memoryStats.embeddingProvider
      };
    } catch (error) {
      checks.memory = {
        status: 'unhealthy',
        error: error.message
      };
    }

    // Check LLM service
    checks.llm = { status: 'checking' };
    try {
      const sessionStats = llmService.getSessionStats();
      checks.llm = {
        status: 'healthy',
        activeSessions: sessionStats.activeSessions,
        totalSessions: sessionStats.sessions.length
      };
    } catch (error) {
      checks.llm = {
        status: 'unhealthy',
        error: error.message
      };
    }

    // Check file system
    checks.filesystem = { status: 'checking' };
    try {
      const stats = fs.statSync(DATA_DIR);
      const diskUsage = await getDiskUsage(DATA_DIR);
      checks.filesystem = {
        status: 'healthy',
        dataDirectory: DATA_DIR,
        exists: stats.isDirectory(),
        diskUsage
      };
    } catch (error) {
      checks.filesystem = {
        status: 'unhealthy',
        error: error.message
      };
    }

    // Check external services
    checks.cmpuse = { status: 'checking' };
    try {
      const response = await fetch(`${config.CMPUSE_API_URL}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      checks.cmpuse = {
        status: response.ok ? 'healthy' : 'degraded',
        url: config.CMPUSE_API_URL,
        available: response.ok
      };
    } catch (error) {
      checks.cmpuse = {
        status: 'unavailable',
        url: config.CMPUSE_API_URL,
        error: error.message
      };
    }

    // Overall status
    const overallStatus = Object.values(checks).some(check => check.status === 'unhealthy') 
      ? 'unhealthy' 
      : Object.values(checks).some(check => check.status === 'degraded')
        ? 'degraded'
        : 'healthy';

    res.json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      build: config.BUILD_STAMP,
      version: '0.1.0',
      uptime: process.uptime(),
      checks
    });

  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// System metrics
router.get('/metrics', (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system
      },
      nodejs: {
        version: process.version,
        platform: process.platform,
        arch: process.arch
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        logLevel: config.LOG_LEVEL,
        allowWrite: config.ALLOW_WRITE
      }
    });
  } catch (error) {
    logger.error('Metrics collection failed', { error: error.message });
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Service statistics
router.get('/stats', async (req, res) => {
  try {
    const memoryStats = memoryService.getStats();
    const sessionStats = llmService.getSessionStats();
    
    // Count trace files
    let traceCount = 0;
    try {
      const tracesPath = path.join(DATA_DIR, 'traces.jsonl');
      if (fs.existsSync(tracesPath)) {
        const content = fs.readFileSync(tracesPath, 'utf8');
        traceCount = content.split('\n').filter(line => line.trim()).length;
      }
    } catch (error) {
      logger.warn('Failed to count traces', { error: error.message });
    }

    res.json({
      timestamp: new Date().toISOString(),
      memory: memoryStats,
      sessions: sessionStats,
      traces: {
        count: traceCount
      },
      build: config.BUILD_STAMP
    });
  } catch (error) {
    logger.error('Stats collection failed', { error: error.message });
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Readiness probe (for container orchestration)
router.get('/ready', async (req, res) => {
  try {
    // Check if essential services are ready
    const memoryReady = memoryService.getStats().count >= 0;
    const llmReady = llmService.getSessionStats().activeSessions >= 0;
    
    if (memoryReady && llmReady) {
      res.json({
        ready: true,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        ready: false,
        timestamp: new Date().toISOString(),
        reason: 'Services not ready'
      });
    }
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Liveness probe (for container orchestration)
router.get('/live', (req, res) => {
  res.json({
    alive: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Helper function to get disk usage
async function getDiskUsage(directory) {
  try {
    const stats = fs.statSync(directory);
    
    // Simple estimation - count files and total size
    const files = fs.readdirSync(directory);
    let totalSize = 0;
    
    for (const file of files) {
      const filePath = path.join(directory, file);
      try {
        const fileStat = fs.statSync(filePath);
        if (fileStat.isFile()) {
          totalSize += fileStat.size;
        }
      } catch (error) {
        // Ignore individual file errors
      }
    }
    
    return {
      files: files.length,
      totalSize,
      directory
    };
  } catch (error) {
    return {
      error: error.message
    };
  }
}

export default router;
