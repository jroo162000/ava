// Test App Factory - Creates Express app without starting server
// Used by tests to avoid port conflicts and WebSocket issues

import express from 'express';
import cors from 'cors';

// Import routes
import apiRoutes from '../src/routes/api.js';
import monitoringRoutes from '../src/routes/monitoring.js';
import learningRoutes from '../src/routes/learning.js';
import toolsRoutes from '../src/routes/tools.js';
import agentRoutes from '../src/routes/agent.js';
import memoryRoutes from '../src/routes/memory.js';
import securityRoutes from '../src/routes/security.js';

/**
 * Create a test app instance
 * @param {Object} options - Configuration options
 * @param {Object} options.mocks - Service mocks
 */
export function createTestApp(options = {}) {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use('/', agentRoutes);
  app.use('/', memoryRoutes);
  app.use('/', securityRoutes);
  app.use('/', toolsRoutes);
  app.use('/', monitoringRoutes);
  app.use('/', learningRoutes);
  app.use('/', apiRoutes);

  // Error handling
  app.use((error, req, res, _next) => {
    res.status(500).json({ ok: false, error: error.message || 'Internal server error' });
  });

  // 404 handler
  app.use('*', (req, res) => {
    res.status(404).json({ ok: false, error: 'Route not found', path: req.originalUrl });
  });

  return app;
}

export default createTestApp;
