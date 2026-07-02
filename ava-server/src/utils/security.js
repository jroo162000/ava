// Security Module - Phase 7: Security Hardening
// Handles:
// - Secrets audit (detect plaintext key files)
// - Path traversal protection
// - Execution sandboxing for high-risk tools
// - Directory whitelisting

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from './logger.js';

/**
 * Patterns for detecting insecure secret storage
 */
const INSECURE_SECRET_PATTERNS = [
  /api.*key.*\.txt$/i,
  /.*key\.txt$/i,
  /secret.*\.txt$/i,
  /password.*\.txt$/i,
  /token.*\.txt$/i,
  /credential.*\.txt$/i
];

/**
 * Whitelisted directories for file operations
 */
const DEFAULT_ALLOWED_DIRECTORIES = [
  process.env.USERPROFILE || process.env.HOME || '',
  process.env.TEMP || '/tmp',
  process.env.TMP || '/tmp',
  path.join(process.env.USERPROFILE || '', 'Documents'),
  path.join(process.env.USERPROFILE || '', 'Downloads'),
  path.join(process.env.USERPROFILE || '', 'Desktop'),
  path.join(process.env.USERPROFILE || '', 'ava-server'),
  path.join(process.env.USERPROFILE || '', 'ava-integration'),
  path.join(process.env.USERPROFILE || '', 'cmp-use'),
].filter(Boolean);

/**
 * Blocked path patterns (path traversal, system directories)
 */
const BLOCKED_PATH_PATTERNS = [
  /\.\.[\/\\]/,                    // Path traversal: ../
  /^[\/\\]Windows[\/\\]/i,         // Windows system
  /^[\/\\]System32/i,              // System32
  /^[\/\\]Program Files/i,         // Program Files
  /^C:[\/\\]Windows/i,             // C:\Windows
  /^C:[\/\\]Program Files/i,       // C:\Program Files
  /[\/\\]\.ssh[\/\\]/i,            // SSH keys
  /[\/\\]\.gnupg[\/\\]/i,          // GPG keys
  /[\/\\]\.aws[\/\\]/i,            // AWS credentials
  /[\/\\]\.azure[\/\\]/i,          // Azure credentials
];

/**
 * High-risk tool names that require confirmation
 */
const HIGH_RISK_TOOLS = [
  'fs_ops',
  'ps_exec',
  // 'sys_ops' removed: it is READ-ONLY system info (CPU/memory/disk/network) and needs no
  // confirmation. Gating it made every autonomous system-status check fail as confirmation_required.
  'boot_repair',
  'remote_ops',
  'security_ops'
];

class SecurityService {
  constructor() {
    this.prodMode = process.env.NODE_ENV === 'production';
    this.allowedDirectories = [...DEFAULT_ALLOWED_DIRECTORIES];
    this.insecureFiles = [];
    this.initialized = false;
  }

  /**
   * Audit for plaintext secret files
   * Called at startup to detect insecure storage
   * @param {string} baseDir - Base directory to search
   * @param {boolean} failOnInsecure - If true, returns error for insecure files in prod
   * @returns {{ ok: boolean, insecureFiles: string[], errors: string[] }}
   */
  auditSecrets(baseDir = process.cwd(), failOnInsecure = false) {
    const searchDirs = [
      baseDir,
      process.env.USERPROFILE || process.env.HOME || '',
      path.join(process.env.USERPROFILE || '', 'ava-integration'),
      path.join(process.env.USERPROFILE || '', 'ava-server'),
      path.join(process.env.USERPROFILE || '', 'cmp-use'),
    ].filter(Boolean);

    this.insecureFiles = [];
    const errors = [];

    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        
        const files = fs.readdirSync(dir);
        for (const file of files) {
          for (const pattern of INSECURE_SECRET_PATTERNS) {
            if (pattern.test(file)) {
              const filePath = path.join(dir, file);
              if (!this.insecureFiles.includes(filePath)) {
                this.insecureFiles.push(filePath);
                logger.warn(`[security] ⚠️  Insecure secret file detected: ${filePath}`);
              }
            }
          }
        }
      } catch (e) {
        // Skip directories we can't read
      }
    }

    if (this.insecureFiles.length > 0) {
      const msg = `Found ${this.insecureFiles.length} plaintext secret file(s). Move to ~/.cmpuse/secrets.json or environment variables.`;
      logger.warn('[security] ' + msg);
      
      if (failOnInsecure && this.prodMode) {
        errors.push(msg);
        for (const f of this.insecureFiles) {
          errors.push(`  - ${f}`);
        }
      }
    } else {
      logger.info('[security] No insecure secret files detected');
    }

    this.initialized = true;
    
    return {
      ok: errors.length === 0,
      insecureFiles: this.insecureFiles,
      errors
    };
  }

  /**
   * Express middleware for security headers and basic protection
   */
  securityMiddleware(req, res, next) {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Block obvious attack patterns in URLs
    const suspiciousPatterns = [
      /\.\.[\/\\]/,           // Path traversal
      /<script/i,             // XSS
      /javascript:/i,         // XSS
      /data:text\/html/i,     // Data URL injection
    ];
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(req.url) || pattern.test(req.originalUrl)) {
        logger.warn('[security] Blocked suspicious request', { 
          url: req.url, 
          pattern: pattern.toString() 
        });
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid request',
          status: 'blocked'
        });
      }
    }
    
    next();
  }

  /**
   * Validate a file path for security
   * Returns { valid: boolean, reason?: string, path?: string }
   */
  validatePath(filePath, operation = 'read') {
    if (!filePath || typeof filePath !== 'string') {
      return { valid: false, reason: 'Invalid path: empty or not a string' };
    }

    // Normalize the path
    const normalized = path.normalize(filePath);
    const absolute = path.isAbsolute(normalized) 
      ? normalized 
      : path.resolve(process.cwd(), normalized);

    // Check for path traversal patterns
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(filePath) || pattern.test(normalized) || pattern.test(absolute)) {
        logger.warn('[security] Path traversal attempt blocked', { 
          original: filePath, 
          normalized,
          pattern: pattern.toString() 
        });
        return { 
          valid: false, 
          reason: `Blocked path pattern detected: ${pattern.toString()}` 
        };
      }
    }

    // For write operations, check allowed directories
    if (operation === 'write' || operation === 'delete') {
      const inAllowed = this.allowedDirectories.some(allowed => {
        const normalizedAllowed = path.normalize(allowed).toLowerCase();
        const normalizedPath = absolute.toLowerCase();
        return normalizedPath.startsWith(normalizedAllowed);
      });

      if (!inAllowed) {
        logger.warn('[security] Write operation blocked - not in allowed directory', {
          path: absolute,
          operation
        });
        return {
          valid: false,
          reason: `Write operations only allowed in whitelisted directories`
        };
      }
    }

    return { valid: true, path: absolute };
  }

  /**
   * Check if a tool requires confirmation based on risk level
   */
  requiresConfirmation(toolName, riskLevel) {
    if (riskLevel === 'high') return true;
    if (HIGH_RISK_TOOLS.includes(toolName)) return true;
    return false;
  }

  /**
   * Validate tool execution for security
   */
  validateToolExecution(toolName, args, riskLevel) {
    const issues = [];

    // Check if tool is high-risk without confirmation
    if (this.requiresConfirmation(toolName, riskLevel)) {
      if (!args.confirmed && !args.confirm) {
        issues.push({
          type: 'confirmation_required',
          message: `High-risk tool '${toolName}' requires explicit confirmation (confirmed: true)`
        });
      }
    }

    // Check path arguments for file operations
    const pathArgs = ['path', 'target', 'src', 'dest', 'directory', 'file'];
    for (const argName of pathArgs) {
      if (args[argName]) {
        const op = toolName.includes('write') || toolName.includes('delete') ? 'write' : 'read';
        const pathCheck = this.validatePath(args[argName], op);
        if (!pathCheck.valid) {
          issues.push({
            type: 'path_security',
            argument: argName,
            message: pathCheck.reason
          });
        }
      }
    }

    // Check for command injection in script arguments
    if (args.script || args.command) {
      const dangerous = [
        /rm\s+-rf\s+[\/\\]/i,
        /del\s+[\/\\]\s*/i,
        /format\s+/i,
        /mkfs/i,
        /dd\s+if=/i,
        />\s*[\/\\]/,
        /\|\s*sh\b/,
        /\|\s*bash\b/,
        /\|\s*cmd\b/,
        /\|\s*powershell/i
      ];

      const scriptContent = args.script || args.command;
      for (const pattern of dangerous) {
        if (pattern.test(scriptContent)) {
          issues.push({
            type: 'dangerous_command',
            message: `Potentially dangerous command pattern detected`
          });
          break;
        }
      }
    }

    return {
      allowed: issues.length === 0,
      issues
    };
  }

  /**
   * Add a directory to the allowed list
   */
  addAllowedDirectory(dirPath) {
    const normalized = path.normalize(dirPath);
    if (!this.allowedDirectories.includes(normalized)) {
      this.allowedDirectories.push(normalized);
      logger.info('[security] Added allowed directory', { path: normalized });
    }
  }

  /**
   * Get security status for monitoring
   */
  getStatus() {
    return {
      initialized: this.initialized,
      prodMode: this.prodMode,
      insecureFiles: this.insecureFiles,
      allowedDirectories: this.allowedDirectories,
      highRiskTools: HIGH_RISK_TOOLS
    };
  }
}

const securityService = new SecurityService();

// ---------------------------------------------------------------------------
// Tier 0: API token auth for every route.
//
// The token lives in ava-integration/.env as AVA_API_TOKEN (the single source
// of truth all AVA processes already read). If it's missing at boot we generate
// a strong one, persist it there, and continue — so an unattended restart never
// leaves her unreachable, and never runs open.
// ---------------------------------------------------------------------------

/** Load AVA_API_TOKEN, generating + persisting one to ava-integration/.env if absent. */
export function ensureApiToken() {
  let token = (process.env.AVA_API_TOKEN || '').trim();
  if (token) return token;
  token = crypto.randomBytes(32).toString('hex');
  const integrationDir = process.env.AVA_INTEGRATION_DIR || '';
  const envPath = integrationDir ? path.join(integrationDir, '.env') : '';
  try {
    if (envPath) {
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (/^\s*AVA_API_TOKEN\s*=/m.test(existing)) {
        // Present in file but not in process env (e.g. loaded after config init) — reuse it.
        const m = existing.match(/^\s*AVA_API_TOKEN\s*=\s*(.+)\s*$/m);
        if (m && m[1].trim()) { process.env.AVA_API_TOKEN = m[1].trim(); return m[1].trim(); }
      }
      const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(envPath, `${sep}# Generated by AVA server (Tier 0 security) — required on every API request\nAVA_API_TOKEN=${token}\n`, 'utf8');
      logger.info('[security] Generated AVA_API_TOKEN and persisted to ava-integration/.env');
    } else {
      logger.warn('[security] AVA_INTEGRATION_DIR unknown — generated ephemeral AVA_API_TOKEN (not persisted)');
    }
  } catch (e) {
    logger.warn('[security] Could not persist generated AVA_API_TOKEN', { error: e.message });
  }
  process.env.AVA_API_TOKEN = token;
  return token;
}

/** Extract a presented token from a request (header, bearer, or query). */
export function presentedToken(req) {
  const h = req.headers || {};
  const auth = String(h['authorization'] || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (h['x-ava-token']) return String(h['x-ava-token']).trim();
  try {
    const url = new URL(req.url, 'http://local');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch { /* ignore */ }
  return '';
}

const AUTH_EXEMPT = new Set(['/health']);

/** Express middleware: require the API token on every route except /health. */
export function requireAuth(expectedToken) {
  return (req, res, next) => {
    if (AUTH_EXEMPT.has(req.path)) return next();
    const got = presentedToken(req);
    if (got && expectedToken && timingSafeEqualStr(got, expectedToken)) return next();
    logger.warn('[security] Rejected unauthenticated request', { path: req.path, ip: req.ip });
    return res.status(401).json({ ok: false, error: 'Unauthorized — AVA_API_TOKEN required (Authorization: Bearer <token>)' });
  };
}

/** Constant-time string comparison. */
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default securityService;
