// Python Worker Service - JSON-RPC communication with Python modules
// Extracted from legacy server.js for modular architecture

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import os from 'os';
import logger from '../utils/logger.js';

class PythonWorker {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.modules = {};
    this.toolsCache = null;
    this.toolsCacheTime = 0;
    this.TOOLS_CACHE_TTL = 60000; // 1 minute
  }

  spawn() {
    const home = os.homedir();
    const workerScript = path.join(home, 'ava-integration', 'ava_python_worker.py');

    if (!fs.existsSync(workerScript)) {
      logger.warn('[python-worker] Worker script not found', { path: workerScript });
      return false;
    }

    try {
      this.worker = spawn('python', [workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.join(home, 'ava-integration')
      });

      const rl = readline.createInterface({ input: this.worker.stdout });
      rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.status === 'ready') {
            this.ready = true;
            this.modules = response.modules || {};
            logger.info('[python-worker] Ready', { modules: Object.keys(this.modules) });
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
        if (!this.worker) this.spawn();
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
      const response = await this.sendCommand('list_tools', {}, 15000);
      if (response.ok && response.tools) {
        this.toolsCache = response.tools;
        this.toolsCacheTime = now;
        logger.info('[python-worker] Tools cache refreshed', { count: response.tools.length });
        return response.tools;
      }
      logger.warn('[python-worker] list_tools returned unexpected format', { response });
    } catch (e) {
      logger.warn('[python-worker] list_tools failed', { error: e.message });
    }
    return this.toolsCache || [];
  }

  // Execute a tool via Python
  async executeTool(name, args, dryRun = false) {
    return this.sendCommand('execute_tool', { name, args, dry_run: dryRun }, 30000);
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
pythonWorker.spawn();

export default pythonWorker;
