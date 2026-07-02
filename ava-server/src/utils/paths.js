// paths — single source of truth for cross-cutting path resolution (Tier 1 #8).
// Read at CALL time so env overrides apply live.
import fs from 'fs';
import path from 'path';
import os from 'os';

// The ava-integration directory (identity, voice config, session helpers, training).
export function integrationDir() {
  return process.env.AVA_INTEGRATION_DIR || path.join(os.homedir(), 'ava', 'ava-integration');
}

// The cmp-use Python tools directory (source of truth for the Python tool registry).
export function cmpuseToolsDir() {
  return process.env.AVA_CMPUSE_TOOLS_DIR || path.join(os.homedir(), 'cmp-use', 'cmpuse', 'tools');
}

// The daily-JSONL conversation logs directory (the ONE conversation log).
export function conversationLogsDir() {
  const cands = [
    process.env.AVA_CONVERSATION_LOGS_DIR,
    path.join(process.cwd(), 'logs', 'conversations'),
    path.join(os.homedir(), 'ava', 'ava-server', 'logs', 'conversations'),
    path.join(os.homedir(), 'ava-server', 'logs', 'conversations'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}

export default { integrationDir, cmpuseToolsDir, conversationLogsDir };
