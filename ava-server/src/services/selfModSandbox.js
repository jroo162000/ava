// selfModSandbox.js — Tier 2 #13: a safe, real sandbox for self-modification.
//
// Before an approved self-edit is allowed to touch the LIVE tree, it is applied to an
// ISOLATED git worktree and validated there:
//   1. syntax gate  — the proposed file must parse (node --check / py_compile / JSON.parse)
//   2. test gate    — for ava-server targets, the jest suite runs IN THE WORKTREE and must
//                     not fail any test that passes today (compared against a recorded
//                     baseline of known failures, so the documented pre-existing red tests
//                     never block an unrelated change)
//
// Design notes:
// - The worktree is created detached at HEAD, then the live tree's uncommitted TRACKED
//   modifications are overlaid so the sandbox mirrors what is actually running (the live
//   tree is routinely ahead of HEAD on this machine).
// - Gitignored runtime deps the tests need (ava-server/node_modules, ava-integration/.venv)
//   are junction-linked from the live tree; ava-integration/.env is copied. Junctions are
//   removed FIRST during teardown so nothing can ever recurse through them into live data.
// - Fail-closed on validation results, fail-OPEN on infrastructure errors: if git/worktree
//   itself breaks we fall back to the legacy apply path (post-apply syntax verify + undo)
//   with a warning, instead of bricking self-modification entirely.
// - This file is listed in PROTECTED_BASENAMES (ava_self_modification.py) so AVA cannot
//   weaken her own sandbox gate.
//
// Env:
//   AVA_SELFMOD_SANDBOX=0          — disable the whole gate (legacy behavior)
//   AVA_SELFMOD_TESTGATE=0         — keep the worktree syntax gate, skip the jest run
//   AVA_SELFMOD_TEST_TIMEOUT_MS    — jest timeout (default 240000)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../utils/logger.js';
import { verifyFileSyntax } from '../utils/verifyFileSyntax.js';

const execFileP = promisify(execFile);

function pendingStorePath() {
  return path.join(os.homedir(), '.cmpuse', 'pending_mods.json');
}

function baselinePath() {
  // cwd is ava-server when the server runs (all launchers cd there first).
  return path.resolve(process.cwd(), 'data', 'selfmod-test-baseline.json');
}

export function isEnabled() {
  return process.env.AVA_SELFMOD_SANDBOX !== '0';
}

async function git(repo, args, timeout = 30000) {
  const { stdout } = await execFileP('git', ['-C', repo, ...args], {
    timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout || '').trim();
}

// The pending store (written by ava_self_modification.py) is the one place that has the
// proposal's full replacement content — list_pending deliberately returns only the diff.
function readProposal(modId) {
  const data = JSON.parse(fs.readFileSync(pendingStorePath(), 'utf8'));
  const d = data && data[String(modId)];
  if (!d) throw new Error(`proposal ${modId} not found in the pending store`);
  if (!d.file || typeof d.new_content !== 'string' || !d.new_content.trim()) {
    throw new Error(`proposal ${modId} has no readable file/content`);
  }
  return { file: d.file, newContent: d.new_content };
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(baselinePath(), 'utf8')); } catch { return null; }
}

function saveBaseline(b) {
  try {
    fs.mkdirSync(path.dirname(baselinePath()), { recursive: true });
    fs.writeFileSync(baselinePath(), JSON.stringify(b, null, 2));
  } catch (e) { logger.warn('[selfmod-sandbox] failed to save test baseline', { error: e.message }); }
}

// Run the jest suite inside the worktree's ava-server; return the failed test names.
// jest exits non-zero when tests fail — the JSON output file is still written, so the
// exec error is expected and ignored; a missing/unparseable output file is the real error.
async function runJest(serverDir, timeoutMs) {
  const outFile = path.join(serverDir, 'selfmod-jest-result.json');
  try {
    await execFileP(process.execPath,
      ['--experimental-vm-modules', path.join('node_modules', 'jest', 'bin', 'jest.js'),
        '--json', `--outputFile=${outFile}`, '--silent'],
      { cwd: serverDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch { /* non-zero exit = failing tests; the output file tells us which */ }
  const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const failed = [];
  for (const tr of (j.testResults || [])) {
    for (const ar of (tr.assertionResults || [])) {
      if (ar.status === 'failed') failed.push(ar.fullName || ar.title || 'unknown test');
    }
  }
  return { failed, total: j.numTotalTests | 0, passed: j.numPassedTests | 0 };
}

// Validate one pending proposal in an isolated worktree.
// Returns:
//   { ok:true, tests?, syntax?, skipped?, warning?, ms }          — safe to apply
//   { ok:false, blocked:'syntax'|'tests', error?, newFailures?, totals?, ms } — do NOT apply
export async function validateProposal(modId) {
  const t0 = Date.now();
  if (!isEnabled()) return { ok: true, skipped: 'sandbox disabled (AVA_SELFMOD_SANDBOX=0)' };

  let prop;
  try { prop = readProposal(modId); }
  catch (e) {
    logger.warn('[selfmod-sandbox] cannot read proposal; falling back to legacy gate', { modId, error: e.message });
    return { ok: true, skipped: `proposal content unreadable: ${e.message}`, warning: true };
  }

  let repoRoot;
  try { repoRoot = path.resolve(await git(path.dirname(prop.file), ['rev-parse', '--show-toplevel'])); }
  catch {
    return { ok: true, skipped: 'target file is not inside a git repo', warning: true };
  }
  const rel = path.relative(repoRoot, path.resolve(prop.file));
  if (!rel || rel.startsWith('..')) {
    return { ok: true, skipped: 'target resolves outside its repo', warning: true };
  }

  const sandboxDir = path.join(os.tmpdir(), `ava-selfmod-${String(modId).replace(/[^a-zA-Z0-9_-]/g, '')}-${Date.now()}`);
  const junctions = [];
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', sandboxDir], 90000);

    // Mirror the live tree: overlay uncommitted TRACKED modifications onto the worktree.
    let dirty = [];
    try { dirty = (await git(repoRoot, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean); } catch { dirty = []; }
    for (const f of dirty) {
      try {
        const src = path.join(repoRoot, f);
        const dst = path.join(sandboxDir, f);
        if (fs.existsSync(src) && fs.statSync(src).isFile()) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      } catch { /* per-file best effort */ }
    }

    // Apply the PROPOSED content inside the sandbox only.
    const sandboxTarget = path.join(sandboxDir, rel);
    fs.mkdirSync(path.dirname(sandboxTarget), { recursive: true });
    fs.writeFileSync(sandboxTarget, prop.newContent, 'utf8');

    // Gate 1: the proposed file must parse.
    const syn = await verifyFileSyntax(sandboxTarget);
    if (!syn.ok) {
      logger.info('[selfmod-sandbox] blocked by syntax gate', { modId, error: syn.error });
      return { ok: false, blocked: 'syntax', error: syn.error, ms: Date.now() - t0 };
    }

    // Gate 2: jest suite for ava-server targets, judged against the known-failure baseline.
    const relUnix = rel.replace(/\\/g, '/');
    const testGateOn = process.env.AVA_SELFMOD_TESTGATE !== '0';
    let tests = null;
    if (testGateOn && /^ava-server\//.test(relUnix)) {
      const liveServer = path.join(repoRoot, 'ava-server');
      const sbServer = path.join(sandboxDir, 'ava-server');
      const liveInt = path.join(repoRoot, 'ava-integration');
      const sbInt = path.join(sandboxDir, 'ava-integration');

      // Gitignored runtime deps the suite needs, linked read-through from the live tree.
      const nm = path.join(sbServer, 'node_modules');
      if (!fs.existsSync(nm) && fs.existsSync(path.join(liveServer, 'node_modules'))) {
        fs.symlinkSync(path.join(liveServer, 'node_modules'), nm, 'junction');
        junctions.push(nm);
      }
      const venv = path.join(sbInt, '.venv');
      if (fs.existsSync(sbInt) && !fs.existsSync(venv) && fs.existsSync(path.join(liveInt, '.venv'))) {
        fs.symlinkSync(path.join(liveInt, '.venv'), venv, 'junction');
        junctions.push(venv);
      }
      try {
        const envSrc = path.join(liveInt, '.env');
        if (fs.existsSync(envSrc) && fs.existsSync(sbInt)) fs.copyFileSync(envSrc, path.join(sbInt, '.env'));
      } catch { /* env optional; tests degrade to keyless behavior */ }

      const timeoutMs = parseInt(process.env.AVA_SELFMOD_TEST_TIMEOUT_MS || '', 10) || 240000;
      tests = await runJest(sbServer, timeoutMs);

      const baseline = loadBaseline();
      if (!baseline || !Array.isArray(baseline.failed)) {
        // First ever run: record it. (The baseline is normally pre-generated; this path just
        // keeps the gate usable if that file is lost.)
        saveBaseline({ generatedAt: new Date().toISOString(), note: 'auto-recorded by first sandbox run', failed: tests.failed });
        logger.warn('[selfmod-sandbox] no test baseline found; recorded this run as baseline', { failed: tests.failed.length });
      } else {
        const known = new Set(baseline.failed);
        const newFailures = tests.failed.filter(n => !known.has(n));
        if (newFailures.length) {
          logger.info('[selfmod-sandbox] blocked by test gate', { modId, newFailures: newFailures.slice(0, 5) });
          return {
            ok: false, blocked: 'tests',
            newFailures: newFailures.slice(0, 10),
            totals: { failed: tests.failed.length, passed: tests.passed, total: tests.total, baselineFailed: known.size },
            ms: Date.now() - t0,
          };
        }
      }
    }

    return {
      ok: true,
      syntax: 'passed',
      tests: tests
        ? { ran: true, passed: tests.passed, failed: tests.failed.length, newFailures: 0 }
        : { ran: false, reason: testGateOn ? 'no jest suite covers this target' : 'test gate disabled (AVA_SELFMOD_TESTGATE=0)' },
      ms: Date.now() - t0,
    };
  } catch (e) {
    // Infrastructure failure (git missing, worktree failure, jest output unreadable...):
    // fail OPEN with a warning — the legacy post-apply syntax verify + undo still guards.
    logger.warn('[selfmod-sandbox] infrastructure error; falling back to legacy gate', { modId, error: e.message });
    return { ok: true, skipped: `sandbox infrastructure error: ${e.message}`, warning: true, ms: Date.now() - t0 };
  } finally {
    try {
      // Junctions FIRST — rmdir removes only the link; then the worktree itself.
      for (const j of junctions) { try { fs.rmdirSync(j); } catch { /* already gone */ } }
      try { await git(repoRoot, ['worktree', 'remove', '--force', sandboxDir], 90000); } catch { /* fall through */ }
      if (fs.existsSync(sandboxDir)) { try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      try { await git(repoRoot, ['worktree', 'prune'], 30000); } catch { /* best effort */ }
    } catch { /* teardown must never throw */ }
  }
}

// One-line human summary for messages/announcements.
export function describeGate(gate) {
  if (!gate) return '';
  if (gate.ok) {
    if (gate.skipped) return `sandbox skipped (${gate.skipped})`;
    if (gate.tests && gate.tests.ran) return `sandbox passed: syntax OK, ${gate.tests.passed} tests passed with no new failures`;
    return 'sandbox passed: syntax OK (no test suite for this target)';
  }
  if (gate.blocked === 'syntax') return `sandbox blocked it: the file does not parse (${gate.error})`;
  if (gate.blocked === 'tests') {
    const names = (gate.newFailures || []).slice(0, 3).join('; ');
    return `sandbox blocked it: ${gate.newFailures.length} test(s) that pass today would break (${names})`;
  }
  return 'sandbox blocked it';
}

export default { isEnabled, validateProposal, describeGate };
