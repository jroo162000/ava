// Centralized configuration management with secure key loading
// Supports multiple sources:
// 1. Environment variables (most secure)
// 2. ~/.cmpuse/secrets.json
// 3. .env files
// 4. Plain text key files (deprecated, with warning)

import fs from 'fs'
import path from 'path'
import logger from './logger.js'

// Key file mappings for fallback loading (DEPRECATED)
const KEY_FILE_MAP = {
  'OPENAI_API_KEY': ['openai api key.txt'],
  'GOOGLE_API_KEY': ['gemini api key.txt'],
  'GEMINI_API_KEY': ['gemini api key.txt'],
  'ANTHROPIC_API_KEY': ['claude api key.txt'],
  'CLAUDE_API_KEY': ['claude api key.txt'],
  'DEEPGRAM_API_KEY': ['deepgram key.txt'],
  'GROQ_API_KEY': ['groq api key.txt', 'grok api.txt'],
  'DEEPSEEK_API_KEY': ['deepseek api key.txt']
};

class Config {
  constructor() {
    this.warnedFiles = new Set();
    this.loadSecrets();
    this.loadEnvFile();
    this.loadKeyFiles();
    this.validate();
  }

  loadSecrets() {
    try {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const secretsPath = home ? path.join(home, '.cmpuse', 'secrets.json') : '';
      
      if (secretsPath && fs.existsSync(secretsPath)) {
        const txt = fs.readFileSync(secretsPath, 'utf8');
        const obj = JSON.parse(txt);
        
        for (const [k, v] of Object.entries(obj || {})) {
          if (typeof v === 'string' && !process.env[k]) {
            process.env[k] = v;
          }
        }
        logger.info('Loaded secrets from ~/.cmpuse/secrets.json');
      }
    } catch (error) {
      logger.warn('Failed to load secrets', { error: error.message });
    }
  }

  loadEnvFile() {
    // Try to load .env from ava-integration directory
    const integrationPaths = [
      path.join(process.env.USERPROFILE || process.env.HOME || '', 'ava-integration', '.env'),
      path.join(process.cwd(), '..', 'ava-integration', '.env'),
      path.join(process.cwd(), '.env')
    ];

    for (const envPath of integrationPaths) {
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf8');
          const lines = content.split('\n');
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex > 0) {
              const key = trimmed.substring(0, eqIndex).trim();
              let value = trimmed.substring(eqIndex + 1).trim();
              
              // Remove quotes if present
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
              }
              
              // Don't override existing env vars
              if (!process.env[key] && value && !value.includes('your_') && !value.includes('_here')) {
                process.env[key] = value;
              }
            }
          }
          logger.info('Loaded environment from .env file', { path: envPath });
          break;
        }
      } catch (error) {
        // Silently continue to next path
      }
    }
  }

  loadKeyFiles() {
    // DEPRECATED: Load from plain text key files as last resort
    // Disabled in production or when DISABLE_PLAINTEXT_KEYS=1
    if (process.env.NODE_ENV === 'production' || process.env.DISABLE_PLAINTEXT_KEYS === '1') {
      logger.warn('Plaintext key file loading disabled (production or DISABLE_PLAINTEXT_KEYS=1)');
      return;
    }
    const integrationDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'ava-integration');
    
    for (const [envKey, filenames] of Object.entries(KEY_FILE_MAP)) {
      // Skip if already set
      if (process.env[envKey]) continue;
      
      for (const filename of filenames) {
        const filePath = path.join(integrationDir, filename);
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content && content.length > 10) {
              process.env[envKey] = content;
              
              // Warn about insecure storage (once per file)
              if (!this.warnedFiles.has(filename)) {
                this.warnedFiles.add(filename);
                logger.warn(`⚠️  ${envKey} loaded from plain text file '${filename}'. Consider using environment variables or .env file.`);
              }
              break;
            }
          }
        } catch (error) {
          // Silently continue
        }
      }
    }
  }

  validate() {
    // OpenAI is optional now - we have multiple LLM providers
    const available = [];
    const missing = [];
    
    const providers = {
      'OPENAI_API_KEY': 'OpenAI',
      'GOOGLE_API_KEY': 'Google/Gemini',
      'ANTHROPIC_API_KEY': 'Anthropic/Claude',
      'GROQ_API_KEY': 'Groq'
    };
    
    for (const [key, name] of Object.entries(providers)) {
      if (process.env[key]) {
        available.push(name);
      } else {
        missing.push(key);
      }
    }
    
    if (available.length > 0) {
      logger.info('Available LLM providers', { providers: available });
    } else {
      logger.warn('No LLM API keys configured', { missing });
    }
  }

  get(key, defaultValue = undefined) {
    return process.env[key] || defaultValue;
  }

  getNumber(key, defaultValue = 0) {
    const value = this.get(key);
    return value ? parseInt(value, 10) : defaultValue;
  }

  getBoolean(key, defaultValue = false) {
    const value = this.get(key);
    if (value === undefined) return defaultValue;
    return value === '1' || value === 'true' || value === 'yes';
  }
}

const config = new Config();

export default {
  // Server
  PORT: config.getNumber('PORT', 5051),
  HOST: config.get('HOST', '0.0.0.0'),
  
  // OpenAI
  OPENAI_API_KEY: config.get('OPENAI_API_KEY', ''),
  REALTIME_MODEL: config.get('REALTIME_MODEL', 'gpt-4o-realtime-preview'),
  
  // Additional LLM Providers
  GOOGLE_API_KEY: config.get('GOOGLE_API_KEY', ''),
  ANTHROPIC_API_KEY: config.get('ANTHROPIC_API_KEY', ''),
  GROQ_API_KEY: config.get('GROQ_API_KEY', ''),
  
  // Embeddings
  EMBED_PROVIDER: config.get('EMBED_PROVIDER', 'local'),
  EMBED_MODEL: config.get('EMBED_MODEL', 'text-embedding-3-small'),
  
  // Security
  ALLOW_WRITE: config.getBoolean('ALLOW_WRITE', false),
  
  // External Services
  CMPUSE_API_URL: config.get('CMPUSE_API_URL', 'http://127.0.0.1:8000'),
  
  // Bridge (OS control)
  BRIDGE_HOST: config.get('BRIDGE_HOST', '127.0.0.1'),
  BRIDGE_PORT: config.getNumber('BRIDGE_PORT', 3333),
  BRIDGE_TOKEN: config.get('BRIDGE_TOKEN', config.get('AVA_BRIDGE_TOKEN', '')),
  AVA_API_TOKEN: config.get('AVA_API_TOKEN', ''),
  
  // Features
  RESPOND_LOCAL_FILEGEN_FALLBACK: config.getBoolean('RESPOND_LOCAL_FILEGEN_FALLBACK', false),
  
  // Logging
  LOG_LEVEL: config.get('LOG_LEVEL', 'info'),
  
  // Build info
  BUILD_STAMP: new Date().toISOString() + '-' + Math.random().toString(36).slice(2, 8)
};
