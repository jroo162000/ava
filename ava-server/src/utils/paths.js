// paths — single source of truth for cross-cutting path resolution (Tier 1 #8).
// Read at CALL time so env overrides apply live.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function repoRoot() {
  return process.env.AVA_REPO_ROOT || path.resolve(__dirname, '..', '..', '..');
}

export function serverDir() {
  return process.env.AVA_SERVER_DIR || path.join(repoRoot(), 'ava-server');
}

export function dataDir() {
  if (process.env.AVA_DATA_DIR) return path.resolve(process.env.AVA_DATA_DIR);
  if (process.env.NODE_ENV === 'test') return path.join(os.tmpdir(), 'ava-server-tests', String(process.pid), 'data');
  return path.join(serverDir(), 'data');
}

export function logsDir() {
  if (process.env.AVA_LOGS_DIR) return path.resolve(process.env.AVA_LOGS_DIR);
  if (process.env.NODE_ENV === 'test') return path.join(os.tmpdir(), 'ava-server-tests', String(process.pid), 'logs');
  return path.join(serverDir(), 'logs');
}

// The ava-integration directory (identity, voice config, session helpers, training).
export function integrationDir() {
  if (process.env.AVA_INTEGRATION_DIR) return path.resolve(process.env.AVA_INTEGRATION_DIR);
  const local = path.join(repoRoot(), 'ava-integration');
  return fs.existsSync(local) ? local : path.join(os.homedir(), 'ava', 'ava-integration');
}

// The cmp-use Python tools directory (source of truth for the Python tool registry).
export function cmpuseToolsDir() {
  if (process.env.AVA_CMPUSE_TOOLS_DIR) return path.resolve(process.env.AVA_CMPUSE_TOOLS_DIR);
  const local = path.join(repoRoot(), 'cmp-use', 'cmpuse', 'tools');
  return fs.existsSync(local) ? local : path.join(os.homedir(), 'cmp-use', 'cmpuse', 'tools');
}

// The daily-JSONL conversation logs directory (the ONE conversation log).
export function conversationLogsDir() {
  const cands = [
    process.env.AVA_CONVERSATION_LOGS_DIR,
    path.join(logsDir(), 'conversations'),
    path.join(os.homedir(), 'ava', 'ava-server', 'logs', 'conversations'),
    path.join(os.homedir(), 'ava-server', 'logs', 'conversations'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}

export default { repoRoot, serverDir, dataDir, logsDir, integrationDir, cmpuseToolsDir, conversationLogsDir };
