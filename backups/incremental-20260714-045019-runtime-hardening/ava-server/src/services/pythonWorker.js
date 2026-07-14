// Python Worker Service - JSON-RPC communication with Python modules
// Extracted from legacy server.js for modular architecture

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import os from 'os';
import logger from '../utils/logger.js';
import config from '../utils/config.js';
import avaPaths from '../utils/paths.js';

class PythonWorker {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.modules = {};
    this.toolsCache = null;
    this.toolsCacheTime = 0;
    this.TOOLS_CACHE_TTL = Math.max(5000, Number(process.env.AVA_TOOLS_CACHE_TTL_MS) || 60000);
  }

  spawn() {
    const integrationDir = config.AVA_INTEGRATION_DIR || avaPaths.integrationDir();
    const workerScript = path.join(integrationDir, 'ava_python_worker.py');

    if (!fs.existsSync(workerScript)) {
      logger.warn('[python-worker] Worker script not found', { path: workerScript });
      return false;
    }

    try {
      // Use the project venv python (has the tool deps) instead of bare 'python'
      // (which on a fresh Windows is the MS Store stub / base interpreter without deps).
      const venvPy = path.join(integrationDir, '.venv', 'Scripts', 'python.exe');
      const pythonExe = process.env.AVA_PYTHON || (fs.existsSync(venvPy) ? venvPy : 'python');
      const cmpUseDir = path.resolve(integrationDir, '..', 'cmp-use');
      const configuredToolPaths = String(process.env.AVA_TOOL_PATHS || '').split(path.delimiter).filter(Boolean);
      const discoveredToolPaths = [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Tesseract-OCR'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Nmap'),
      ].filter(candidate => candidate && fs.existsSync(candidate));
      const executablePath = [...new Set([process.env.PATH || '', ...configuredToolPaths, ...discoveredToolPaths])]
        .filter(Boolean).join(path.delimiter);
      this.worker = spawn(pythonExe, [workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: integrationDir,
        env: {
          ...process.env,
          PYTHONPATH: cmpUseDir + path.delimiter + (process.env.PYTHONPATH || ''),
          CMPUSE_DIR: process.env.CMPUSE_DIR || cmpUseDir,
          // Make tool binaries (Tesseract OCR, nmap) discoverable to the worker.
          PATH: executablePath,
          // Real execution: cmp-use defaults to dry-run + confirm. Without these
          // every action tool only returns a "dry-run" preview instead of acting.
          CMPUSE_DRY_RUN: process.env.CMPUSE_DRY_RUN || '0',
          CMPUSE_CONFIRM: process.env.CMPUSE_CONFIRM || '0',
          CMPUSE_FORCE: process.env.CMPUSE_FORCE || '1',
          CMPUSE_ALLOW_SHELL: process.env.CMPUSE_ALLOW_SHELL || '1',
          CMPUSE_ALLOW_NETWORK: process.env.CMPUSE_ALLOW_NETWORK || '1',
          // cmp-use Config.network_enabled reads CMPUSE_NETWORK (not *_ALLOW_NETWORK);
          // without this net_ops returns "network disabled by default".
          CMPUSE_NETWORK: process.env.CMPUSE_NETWORK || '1',
          CMPUSE_PATH_WHITELIST: process.env.CMPUSE_PATH_WHITELIST || os.homedir(),
        },
      });

      const rl = readline.createInterface({ input: this.worker.stdout });
      rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.status === 'ready') {
            this.ready = true;
            this.modules = response.modules || {};
            logger.info('[python-worker] Ready', { modules: Object.keys(this.modules) });
            // Pre-warm the tool registry so the slow cmp-use import (60-90s, pulls in
            // cv2/mediapipe/etc.) completes at startup and gets cached, instead of
            // timing out on the user's first request and falling back to built-ins only.
            setTimeout(() => {
              this.listTools(true)
                .then(t => logger.info('[python-worker] Pre-warmed tools', { count: (t || []).length }))
                .catch(e => logger.warn('[python-worker] Pre-warm failed', { error: e.message }));
            }, 100);
            return;
          }
          if (response._requestId !== undefined) {
            const pending = this.pendingRequests.get(response._requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingRequests.delete(response._requestId);
              delete response._requestId;
              pending.resolve(response);
            }
          }
        } catch (e) {
          logger.debug('[python-worker] Non-JSON output', { line: line.slice(0, 100) });
        }
      });

      this.worker.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('UserWarning')) {
          logger.warn('[python-worker] stderr', { message: msg.slice(0, 200) });
        }
      });

      this.worker.on('exit', (code, signal) => {
        logger.warn('[python-worker] Exited', { code, signal });
        this.ready = false;
        this.worker = null;
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Python worker exited'));
        }
        this.pendingRequests.clear();
        setTimeout(() => this.spawn(), 5000);
      });

      this.worker.on('error', (err) => {
        logger.error('[python-worker] Spawn error', { error: err.message });
        this.ready = false;
      });

      logger.info('[python-worker] Spawned', { pid: this.worker.pid });
      return true;
    } catch (e) {
      logger.error('[python-worker] Failed to spawn', { error: e.message });
      return false;
    }
  }

  async sendCommand(cmd, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.ready) {
        if (!this.worker && process.env.NODE_ENV !== 'test' && process.env.AVA_PYTHON_WORKER_OFF !== '1') this.spawn();
        if (!this.ready) {
          return reject(new Error('Python worker not ready'));
        }
      }

      const requestId = ++this.requestId;
      const request = { cmd, ...params, _requestId: requestId };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Python command timed out: ${cmd}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        this.worker.stdin.write(JSON.stringify(request) + '\n');
      } catch (e) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to send command: ${e.message}`));
      }
    });
  }

  async ping() { return this.sendCommand('ping', {}, 5000); }
  async introspect() { return this.sendCommand('introspect', {}, 10000); }
  async describe() { return this.sendCommand('describe', {}, 10000); }
  async diagnose() { return this.sendCommand('diagnose', {}, 10000); }
  
  async learnCorrection(userInput, wrong, correct, context) {
    return this.sendCommand('learn_correction', { user_input: userInput, wrong, correct, context }, 5000);
  }

  async selfMod(args) { return this.sendCommand('self_mod', { args }, 30000); }

  // Dynamic tool discovery with caching
  async listTools(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.toolsCache && (now - this.toolsCacheTime) < this.TOOLS_CACHE_TTL) {
      return this.toolsCache;
    }
    try {
      const response = await this.sendCommand('list_tools', {}, 120000);
      if (response.ok && response.tools) {
        this.toolsCache = response.tools;
        this.toolsCacheTime = now;
        logger.info('[python-worker] Tools cache refreshed', { count: response.tools.length });
        return response.tools;
      }
      logger.warn('[python-worker] list_tools returned unexpected format', { response });
    } catch (e) {
      if (String(e.message || '').includes('Python worker not ready')) {
        logger.info('[python-worker] list_tools deferred; worker not ready');
        return this.toolsCache || [];
      }
      logger.warn('[python-worker] list_tools failed', { error: e.message });
    }
    return this.toolsCache || [];
  }

  // Execute a tool via Python. Timeout is generous (90s): the FIRST call to a
  // Google-backed tool pays a one-time ~30s library import, and a too-short timeout
  // made Node think the call failed and retry — which, for sends, fired duplicate
  // emails. Better to wait once than to send twice.
  async executeTool(name, args, dryRun = false) {
    return this.sendCommand('execute_tool', { name, args, dry_run: dryRun }, 90000);
  }

  // Get a specific tool definition
  async getTool(name) {
    return this.sendCommand('get_tool', { name }, 5000);
  }

  isReady() { return this.ready; }
  getModules() { return this.modules; }
  getPid() { return this.worker?.pid || null; }
}

const pythonWorker = new PythonWorker();
if (process.env.NODE_ENV !== 'test' && process.env.AVA_PYTHON_WORKER_OFF !== '1') pythonWorker.spawn();

export default pythonWorker;
