// selfModSandbox.js — Tier 2 #13 (+ Tier 3 #19 hardening): a safe, real sandbox for self-modification.
//
// Before an approved self-edit is allowed to touch the LIVE tree, it is applied to an
// ISOLATED git worktree and validated there:
//   1. syntax gate  — the proposed file must parse (node --check / py_compile / JSON.parse)
//   2. import gate  — (#19) for ava-server JS targets, the touched module's import graph must
//                     RESOLVE and load in the worktree. node --check parses one file in
//                     isolation, so a valid-looking import of a nonexistent path sails through
//                     it — the 2026-07-02 audit found exactly that applied to the live tree
//                     (selfRestart.js importing ../llm.js: fatal on the next server start).
//   3. test gate    — for ava-server targets, the jest suite runs IN THE WORKTREE and must
//                     not fail any test that passes today (compared against a recorded
//                     baseline of known failures, so the documented pre-existing red tests
//                     never block an unrelated change)
//   4. suite-load gate — (#19) a suite that RUNS tests in the baseline must still run them.
//                     A proposal that crashes a suite at LOAD time produces zero assertion
//                     results — no failure NAMES — so the name-based gate alone passes it
//                     (the exact hole the three bad 2026-07-02 self-mods went through).
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
import { pathToFileURL } from 'url';
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
  const suites = {};        // suite basename -> number of tests that actually RAN
  const loadFailures = [];  // suites that produced zero assertionResults (load/collect crash)
  for (const tr of (j.testResults || [])) {
    const suite = path.basename(tr.name || tr.testFilePath || 'unknown');
    const asserts = tr.assertionResults || [];
    suites[suite] = asserts.length;
    if (asserts.length === 0) {
      const msg = String(tr.message || tr.failureMessage || 'suite produced no test results')
        .replace(/\[[0-9;]*m/g, '').split('\n').slice(0, 6).join(' ').replace(/\s+/g, ' ').slice(0, 400);
      loadFailures.push({ suite, message: msg });
    }
    for (const ar of asserts) {
      if (ar.status === 'failed') failed.push(ar.fullName || ar.title || 'unknown test');
    }
  }
  return { failed, suites, loadFailures, total: j.numTotalTests | 0, passed: j.numPassedTests | 0 };
}

// Gate 2 (#19) — the touched module's import graph must resolve and load in the worktree.
// Runs with cwd = the worktree's ava-server (so relative/module resolution matches runtime)
// and AVA_SANDBOX=1 to soften service side effects. A timeout kill contains anything the
// module graph starts (jest already imports the same graph, so this adds no new exposure).
async function verifyModuleImports(sandboxTarget, sbServer, timeoutMs = 45000) {
  const url = pathToFileURL(sandboxTarget).href;
  try {
    await execFileP(process.execPath,
      ['--experimental-vm-modules', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      { cwd: sbServer, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AVA_SANDBOX: '1' } });
    return { ok: true };
  } catch (e) {
    const raw = String((e && (e.stderr || e.message)) || 'import failed').replace(/\[[0-9;]*m/g, '');
    const line = (raw.split('\n').find(l => /error|cannot find|not defined|unexpected|failed/i.test(l)) || raw.split('\n')[0] || '').trim();
    return { ok: false, error: line.slice(0, 300) };
  }
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

    const relUnix = rel.replace(/\\/g, '/');
    const testGateOn = process.env.AVA_SELFMOD_TESTGATE !== '0';
    const isServerTarget = /^ava-server\//.test(relUnix);
    const sbServer = path.join(sandboxDir, 'ava-server');
    let imports = null;
    let tests = null;

    if (isServerTarget) {
      const liveServer = path.join(repoRoot, 'ava-server');
      const liveInt = path.join(repoRoot, 'ava-integration');
      const sbInt = path.join(sandboxDir, 'ava-integration');

      // Gitignored runtime deps the gates need, linked read-through from the live tree.
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

      // Gate 2 (#19): the touched module's import graph must load. Cheap (seconds), precise
      // error, and catches the fatal class jest can miss when a crashed suite yields no names.
      if (/\.(mjs|js)$/i.test(relUnix)) {
        imports = await verifyModuleImports(sandboxTarget, sbServer);
        if (!imports.ok) {
          logger.info('[selfmod-sandbox] blocked by import gate', { modId, error: imports.error });
          return { ok: false, blocked: 'imports', error: imports.error, ms: Date.now() - t0 };
        }
      }

      // Gate 3: jest suite, judged against the known-failure baseline.
      if (testGateOn) {
        const timeoutMs = parseInt(process.env.AVA_SELFMOD_TEST_TIMEOUT_MS || '', 10) || 240000;
        tests = await runJest(sbServer, timeoutMs);

        const baseline = loadBaseline();
        if (!baseline || !Array.isArray(baseline.failed)) {
          // First ever run: record it. (The baseline is normally pre-generated; this path just
          // keeps the gate usable if that file is lost.)
          saveBaseline({
            generatedAt: new Date().toISOString(), note: 'auto-recorded by first sandbox run',
            totalTests: tests.total, failed: tests.failed, suites: tests.suites,
          });
          logger.warn('[selfmod-sandbox] no test baseline found; recorded this run as baseline', { failed: tests.failed.length });
        } else {
          // Gate 4 (#19): suite-load accounting. A suite that runs tests in the baseline must
          // still run them — a load-crashed suite has no failure NAMES, so the name check
          // below can't see it (the hole the 2026-07-02 bad self-mods went through).
          if (baseline.suites && typeof baseline.suites === 'object') {
            const broken = [];
            for (const [suite, count] of Object.entries(baseline.suites)) {
              if ((count | 0) > 0 && !((tests.suites[suite] | 0) > 0)) {
                const lf = (tests.loadFailures || []).find(x => x.suite === suite);
                broken.push({ suite, message: lf ? lf.message : 'suite missing from the run entirely' });
              }
            }
            if (!broken.length && (tests.total | 0) < (baseline.totalTests | 0)) {
              broken.push({ suite: '(total)', message: `only ${tests.total} tests ran vs ${baseline.totalTests} in the baseline` });
            }
            if (broken.length) {
              logger.info('[selfmod-sandbox] blocked by suite-load gate', { modId, broken: broken.slice(0, 3) });
              return {
                ok: false, blocked: 'suite-load', suites: broken.slice(0, 5),
                totals: { failed: tests.failed.length, passed: tests.passed, total: tests.total },
                ms: Date.now() - t0,
              };
            }
          } else {
            logger.warn('[selfmod-sandbox] baseline has no per-suite map; suite-load gate inactive — rerun scripts/gen-selfmod-baseline.mjs');
          }

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
    }

    return {
      ok: true,
      syntax: 'passed',
      imports: imports ? 'passed' : undefined,
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
  if (gate.blocked === 'imports') return `sandbox blocked it: the module fails to load (${gate.error})`;
  if (gate.blocked === 'suite-load') {
    const s = (gate.suites || [])[0] || {};
    return `sandbox blocked it: test suite ${s.suite || ''} would no longer load (${s.message || 'no detail'})`;
  }
  if (gate.blocked === 'tests') {
    const names = (gate.newFailures || []).slice(0, 3).join('; ');
    return `sandbox blocked it: ${gate.newFailures.length} test(s) that pass today would break (${names})`;
  }
  return 'sandbox blocked it';
}

export default { isEnabled, validateProposal, describeGate };
