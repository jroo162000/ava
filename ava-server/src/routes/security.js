// Security Routes - Phase 7: Security Hardening
// Endpoints for security status and management
import express from 'express';
import logger from '../utils/logger.js';
import securityService from '../utils/security.js';

const router = express.Router();

/**
 * Get security status
 * GET /security/status
 */
router.get('/security/status', (req, res) => {
  try {
    const status = securityService.getStatus();
    res.json({ ok: true, security: status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Validate a path for security
 * POST /security/validate-path
 * Body: { path, operation: 'read'|'write'|'delete' }
 */
router.post('/security/validate-path', (req, res) => {
  try {
    const { path, operation = 'read' } = req.body;
    
    if (!path) {
      return res.status(400).json({ ok: false, error: 'Path is required' });
    }

    const result = securityService.validatePath(path, operation);
    res.json({ ok: true, validation: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Add an allowed directory
 * POST /security/allowed-directories
 * Body: { path }
 */
router.post('/security/allowed-directories', (req, res) => {
  try {
    const { path } = req.body;
    
    if (!path) {
      return res.status(400).json({ ok: false, error: 'Path is required' });
    }

    securityService.addAllowedDirectory(path);
    res.json({ 
      ok: true, 
      message: `Added ${path} to allowed directories`,
      allowedDirectories: securityService.getStatus().allowedDirectories
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Re-run secrets audit
 * POST /security/audit-secrets
 */
router.post('/security/audit-secrets', (req, res) => {
  try {
    const insecureFiles = securityService.auditSecrets();
    res.json({ 
      ok: true, 
      insecureFiles,
      count: insecureFiles.length,
      recommendation: insecureFiles.length > 0 
        ? 'Move secrets to ~/.cmpuse/secrets.json or environment variables'
        : 'No insecure files detected'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
