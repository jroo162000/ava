// Doctor & Maintenance Service
// - Provides /self/doctor orchestration
// - Generates weekly maintenance reports
// - Creates automatic patch proposals (non-destructive by default)
// - Optional apply mode runs tests and rolls back on failure

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import memoryService from './memory.js';
import llmService from './llm.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';
import pythonWorker from './pythonWorker.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const MAINT_DIR = path.join(DATA_DIR, 'maintenance');
const REPORTS_DIR = path.join(MAINT_DIR, 'reports');
const PROPOSALS_DIR = path.join(MAINT_DIR, 'proposals');
const STATE_PATH = path.join(MAINT_DIR, 'state.json');

function ensureDirs() {
  for (const p of [DATA_DIR, MAINT_DIR, REPORTS_DIR, PROPOSALS_DIR]) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function readJsonSafe(p, fallback) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; }
  catch { return fallback; }
}

function writeJsonSafe(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { logger.warn('[doctor] Failed to write JSON', { path: p, error: e.message }); return false; }
}

function summarizeLogs() {
  // Lightweight log summary from conversation logs (if any)
  try {
    const convDir = path.join(process.cwd(), 'logs', 'conversations');
    if (!fs.existsSync(convDir)) return { files: 0, recent: 0 };
    const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
    let recentLines = 0;
    const since = Date.now() - 24 * 3600 * 1000; // last 24h
    for (const f of files) {
      const fp = path.join(convDir, f);
      try {
        const content = fs.readFileSync(fp, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if ((j.ts || 0) >= since) recentLines++;
          } catch {}
        }
      } catch {}
    }
    return { files: files.length, recent: recentLines };
  } catch (e) {
    return { error: e.message };
  }
}

function summarizeData() {
  // Count trace lines if present
  const tracesPath = path.join(DATA_DIR, 'traces.jsonl');
  let traces = 0;
  try {
    if (fs.existsSync(tracesPath)) {
      const content = fs.readFileSync(tracesPath, 'utf8');
      traces = content.split('\n').filter(l => l.trim()).length;
    }
  } catch {}
  return { traces };
}

async function collectChecks() {
  const checks = {};
  // Memory
  try { checks.memory = memoryService.getStats(); checks.memory.status = 'ok'; }
  catch (e) { checks.memory = { status: 'error', error: e.message }; }

  // LLM Session
  try { checks.llm = llmService.getSessionStats(); checks.llm.status = 'ok'; }
  catch (e) { checks.llm = { status: 'error', error: e.message }; }

  // Environment
  checks.env = {
    node: process.version,
    platform: process.platform,
    allowWrite: config.ALLOW_WRITE,
    build: config.BUILD_STAMP
  };

  // Logs & data
  checks.logs = summarizeLogs();
  checks.data = summarizeData();

  // Simple overall status
  const anyError = Object.values(checks).some(v => v && v.status === 'error');
  checks.overall = anyError ? 'unhealthy' : 'healthy';
  return checks;
}

async function generateProposals(checks, reason = '') {
  const proposals = [];

  // 1) Use Python worker self_mod to propose fixes if available
  if (pythonWorker.isReady()) {
    try {
      const resp = await pythonWorker.selfMod({ action: 'propose_fix', reason });
      if (resp?.ok && Array.isArray(resp.proposals)) {
        for (const p of resp.proposals) proposals.push({ source: 'python_worker', ...p });
      }
    } catch (e) {
      logger.warn('[doctor] python_worker propose_fix failed', { error: e.message });
    }
  }

  // 2) Built-in heuristics
  try {
    // Suggest enabling write for maintenance only when explicitly requested
    if (!config.ALLOW_WRITE) {
      proposals.push({
        source: 'heuristic',
        kind: 'config_suggestion',
        description: 'ALLOW_WRITE is disabled. Enable temporarily to apply maintenance changes safely (optional).',
        applyHint: 'Set env ALLOW_WRITE=true during controlled maintenance windows.'
      });
    }

    // If traces are huge, suggest rotation
    if ((checks.data?.traces || 0) > 100000) {
      proposals.push({
        source: 'heuristic',
        kind: 'log_rotation',
        description: 'traces.jsonl large; add rotation/archiving to prevent bloat.',
        patch: {
          file: 'src/routes/monitoring.js',
          note: 'Implement rotation or truncate policy (proposal only)'
        }
      });
    }
  } catch {}

  return proposals;
}

function runJestTests(cwd) {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], { cwd, env: process.env });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => resolve({ code, stdout: out, stderr: err }));
  });
}

async function applyProposalsWithRollback(proposals) {
  const serverDir = process.cwd();
  let appliedCount = 0;
  let rolledBack = false;

  // Always run tests first — abort apply if failing
  const preTest = await runJestTests(serverDir);
  if (preTest.code !== 0) {
    return { appliedCount, rolledBack, preTestFailed: true, preTest };
  }

  // If writes not allowed, stop after pre-test
  if (!config.ALLOW_WRITE) {
    return { appliedCount, rolledBack, preTestFailed: false, preTest };
  }

  // Build list of patch ops from proposals
  const ops = collectPatchOperations(proposals || []);

  // If nothing to apply, just run post-test for sanity
  if (ops.length === 0) {
    const postTest = await runJestTests(serverDir);
    return { appliedCount, rolledBack, preTestFailed: false, preTest, postTest, note: 'no_ops_detected' };
  }

  // Create backup
  const backupInfo = await createBackup(serverDir);

  // Apply
  try {
    appliedCount = await applyPatchOperations(serverDir, ops);
  } catch (e) {
    logger.error('[doctor] Apply failed, restoring backup', { error: e.message });
    await restoreBackup(serverDir, backupInfo);
    rolledBack = true;
    return { appliedCount: 0, rolledBack, error: e.message, backup: backupInfo };
  }

  // Run tests after apply
  const postTest = await runJestTests(serverDir);
  if (postTest.code !== 0) {
    // Roll back
    await restoreBackup(serverDir, backupInfo);
    rolledBack = true;
    return { appliedCount, rolledBack, preTest, postTest, backup: backupInfo };
  }

  // Success — keep backup reference for audit
  return { appliedCount, rolledBack, preTest, postTest, backup: backupInfo };
}

function saveArtifact(dir, prefix, data) {
  ensureDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${prefix}-${ts}.json`);
  writeJsonSafe(file, data);
  return file;
}

async function runDoctor({ mode = 'propose', reason = '' } = {}) {
  ensureDirs();
  const startedAt = Date.now();

  const checks = await collectChecks();
  const proposals = await generateProposals(checks, reason);
  const summary = {
    status: checks.overall,
    proposals: proposals.length,
    startedAt,
    finishedAt: Date.now()
  };

  const report = { summary, checks };
  const reportPath = saveArtifact(REPORTS_DIR, 'report', report);

  const proposalsDoc = { reason, proposals, generatedAt: new Date().toISOString() };
  const proposalsPath = saveArtifact(PROPOSALS_DIR, 'proposals', proposalsDoc);

  let applyResult = null;
  if (mode === 'apply') {
    applyResult = await applyProposalsWithRollback(proposals);
  }

  return { reportPath, proposalsPath, report, proposals: proposalsDoc, applyResult };
}

function scheduleWeeklyReport() {
  ensureDirs();
  const state = readJsonSafe(STATE_PATH, { lastReportAt: 0 });

  async function maybeRun() {
    try {
      const now = Date.now();
      const WEEK_MS = 7 * 24 * 3600 * 1000;
      if (!state.lastReportAt || (now - state.lastReportAt) >= WEEK_MS) {
        logger.info('[doctor] Running scheduled weekly maintenance report');
        const res = await runDoctor({ mode: 'propose', reason: 'scheduled_weekly' });
        state.lastReportAt = Date.now();
        writeJsonSafe(STATE_PATH, state);
        logger.info('[doctor] Weekly report generated', { reportPath: res.reportPath, proposalsPath: res.proposalsPath });
      }
    } catch (e) {
      logger.warn('[doctor] Weekly report failed', { error: e.message });
    }
  }

  // Check on startup, then every 24h
  maybeRun();
  setInterval(maybeRun, 24 * 3600 * 1000);
}

export default {
  runDoctor,
  scheduleWeeklyReport,
};

// ---------------------------
// Patch application helpers
// ---------------------------

function collectPatchOperations(proposals) {
  const ops = [];
  for (const p of proposals) {
    const patch = p.patch || p.suggested_patch || null;
    if (!patch) continue;
    // Supported minimal forms:
    // 1) { op: 'file_write', path, content }
    // 2) { op: 'json_merge', path, merge: {} }
    // 3) { op: 'text_replace', path, search, replace }
    // 4) { file, content } (alias of file_write)
    if (patch.op === 'file_write' && patch.path && typeof patch.content === 'string') {
      ops.push({ type: 'file_write', path: patch.path, content: patch.content });
    } else if (patch.op === 'json_merge' && patch.path && patch.merge && typeof patch.merge === 'object') {
      ops.push({ type: 'json_merge', path: patch.path, merge: patch.merge });
    } else if (patch.op === 'text_replace' && patch.path && typeof patch.search === 'string') {
      ops.push({ type: 'text_replace', path: patch.path, search: patch.search, replace: patch.replace || '' });
    } else if (patch.file && typeof patch.content === 'string') {
      ops.push({ type: 'file_write', path: patch.file, content: patch.content });
    }
  }
  return ops;
}

async function createBackup(serverDir) {
  ensureDirs();
  const backupsDir = path.join(MAINT_DIR, 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupsDir, `backup-${ts}`);
  fs.mkdirSync(backupDir, { recursive: true });

  // Copy key areas: src, tests, top-level config files
  const copyList = [
    { rel: 'src' },
    { rel: 'tests' },
    { rel: 'package.json' },
    { rel: 'jest.config.js' },
    { rel: 'README.md', optional: true },
    { rel: 'MAINTENANCE.md', optional: true }
  ];

  for (const item of copyList) {
    const from = path.join(serverDir, item.rel);
    const to = path.join(backupDir, item.rel);
    if (!fs.existsSync(from)) {
      if (item.optional) continue;
      else continue;
    }
    await fs.promises.cp(from, to, { recursive: true });
  }

  return { backupDir };
}

async function restoreBackup(serverDir, backupInfo) {
  if (!backupInfo?.backupDir || !fs.existsSync(backupInfo.backupDir)) return false;
  const srcDir = path.join(serverDir, 'src');
  const testsDir = path.join(serverDir, 'tests');

  // Restore src and tests and key files
  await fs.promises.cp(path.join(backupInfo.backupDir, 'src'), srcDir, { recursive: true });
  if (fs.existsSync(path.join(backupInfo.backupDir, 'tests'))) {
    await fs.promises.cp(path.join(backupInfo.backupDir, 'tests'), testsDir, { recursive: true });
  }
  for (const f of ['package.json', 'jest.config.js', 'README.md', 'MAINTENANCE.md']) {
    const from = path.join(backupInfo.backupDir, f);
    if (fs.existsSync(from)) await fs.promises.cp(from, path.join(serverDir, f));
  }
  return true;
}

async function applyPatchOperations(serverDir, ops) {
  let count = 0;
  for (const op of ops) {
    const target = path.resolve(serverDir, op.path);
    // Ensure target is within serverDir
    if (!target.startsWith(path.resolve(serverDir))) {
      throw new Error(`Refusing to write outside server directory: ${op.path}`);
    }

    if (op.type === 'file_write') {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, op.content, 'utf8');
      count++;
    } else if (op.type === 'json_merge') {
      let json = {};
      if (fs.existsSync(target)) {
        json = JSON.parse(fs.readFileSync(target, 'utf8'));
      }
      const merged = { ...json, ...op.merge };
      await fs.promises.writeFile(target, JSON.stringify(merged, null, 2), 'utf8');
      count++;
    } else if (op.type === 'text_replace') {
      if (!fs.existsSync(target)) continue;
      const text = fs.readFileSync(target, 'utf8');
      const replaced = text.split(op.search).join(op.replace || '');
      if (replaced !== text) {
        await fs.promises.writeFile(target, replaced, 'utf8');
        count++;
      }
    }
  }
  return count;
}
