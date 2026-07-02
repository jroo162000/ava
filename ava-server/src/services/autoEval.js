// autoEval.js — Tier 3 #21 (final piece): the keep-if-better A/B loop that closes the
// self-improvement cycle.
//
// evalHarness already scores AVA's routing accuracy (the deterministic proxy for the virtual
// training environment that moved her tool-use 69%→94.5%), and selfImprove already stamps a
// pre-apply baseline on routing-relevant proposals. What was missing: nothing MEASURED whether
// an applied change actually helped or hurt, and reverted it if it hurt. That let a self-mod
// silently DEGRADE her (e.g. break escalation routing) and just sit there applied.
//
// This module closes the loop, adapted to the restart-based apply model (JS/ESM changes only
// take effect after a server restart, so the "after" score can't be measured in the same
// process that applied the change):
//   1. when a ROUTING-RELEVANT proposal is applied, record a pending post-apply eval with the
//      pre-apply baseline score (durable in data/auto-eval.json)
//   2. the apply already schedules a restart; on the NEXT boot the change is live
//   3. shortly after boot, runPending() re-runs the eval and compares after vs baseline:
//        after >= baseline - margin  -> KEEP  (announce the confirmed delta, log it)
//        after <  baseline - margin  -> REGRESSION: revert to the known-good prior state via
//                                       the self-mod undo (restores the backup), announce it,
//                                       schedule a restart to load the revert
//
// Rollback/tuning: AVA_AUTO_EVAL=0 (off), AVA_AUTO_EVAL_MARGIN (default 0.125 = one task of
// eight; a net drop of at least this much is a regression), AVA_AUTO_EVAL_AUTOREVERT=0
// (measure + LOUDLY RECOMMEND instead of auto-reverting), AVA_AUTO_EVAL_BOOT_DELAY_SEC
// (default 150 — let the worker/tools warm up before the eval hits /respond/stream).
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import evolutionLog from './evolutionLog.js';
import { pushAnnouncement } from './announceQueue.js';

const FILE = path.join(process.cwd(), 'data', 'auto-eval.json');
const MAX_HISTORY = 40;
const BOOT_ID = `${process.pid}-${Date.now()}`;   // distinguishes "applied in THIS process" from a prior one

function _on() { return process.env.AVA_AUTO_EVAL !== '0'; }
function _margin() { const m = parseFloat(process.env.AVA_AUTO_EVAL_MARGIN || '0.125'); return Number.isFinite(m) ? m : 0.125; }
function _autoRevert() { return process.env.AVA_AUTO_EVAL_AUTOREVERT !== '0'; }

function _ensureDir() { try { const d = path.dirname(FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
function _load() {
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && Array.isArray(j.records)) return j; } } catch { /* ignore */ }
  return { records: [] };
}
function _save(state) {
  try {
    _ensureDir();
    state.records = (state.records || []).slice(-MAX_HISTORY);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { try { logger.warn('[auto-eval] save failed', { error: e.message }); } catch { /* ignore */ } }
}

// Called from the apply path when a routing-relevant proposal is applied. `baseline` is the
// pre-apply eval score object (evalHarness.lastScore()). We stamp the CURRENT boot id so
// runPending only measures once the server has actually restarted INTO the change.
function recordApplied({ modId, file, baseline }) {
  if (!_on()) return;
  try {
    const state = _load();
    state.records.push({
      modId: modId || null,
      file: file || '',
      baseline: baseline && typeof baseline.score === 'number' ? { score: baseline.score, passed: baseline.passed, total: baseline.total } : null,
      appliedBoot: BOOT_ID,
      appliedAt: Date.now(),
      status: 'pending',
    });
    _save(state);
    logger.info('[auto-eval] recorded pending post-apply eval', { modId, file: path.basename(file || ''), baseline: baseline && baseline.score });
  } catch (e) { logger.warn('[auto-eval] recordApplied failed', { error: e.message }); }
}

// Measure every pending record whose change is now LIVE (recorded under a PRIOR boot id, i.e. the
// server has restarted since the apply). Runs the eval once and reuses that score for all pending
// records in this pass. Returns a summary.
async function runPending() {
  if (!_on()) return { ok: true, skipped: 'disabled' };
  const state = _load();
  const due = (state.records || []).filter(r => r.status === 'pending' && r.appliedBoot && r.appliedBoot !== BOOT_ID);
  if (!due.length) return { ok: true, evaluated: 0 };

  const evalHarness = (await import('./evalHarness.js')).default;
  let after;
  try { after = await evalHarness.runEval({ record: true }); }
  catch (e) { logger.warn('[auto-eval] eval run failed; leaving records pending', { error: e.message }); return { ok: false, error: e.message }; }

  const margin = _margin();
  const outcomes = [];
  for (const r of due) {
    const fn = path.basename(r.file || 'a change');
    const baseScore = r.baseline && typeof r.baseline.score === 'number' ? r.baseline.score : null;
    r.afterScore = after.score;
    r.evaluatedAt = Date.now();
    if (baseScore === null) {
      // No baseline to compare against — just note the post-apply score, keep the change.
      r.status = 'kept'; r.note = 'no pre-apply baseline; recorded post-apply score only';
      outcomes.push({ modId: r.modId, file: fn, outcome: 'kept', after: after.score });
      continue;
    }
    const delta = after.score - baseScore;
    const pctA = Math.round(baseScore * 100), pctB = Math.round(after.score * 100);
    if (delta >= -margin) {
      r.status = 'kept'; r.delta = delta;
      try { evolutionLog.record({ kind: 'eval_ab', title: `kept ${fn} — routing ${pctB}% (was ${pctA}%)`, detail: `post-apply eval held/improved routing accuracy`, meta: { modId: r.modId, before: baseScore, after: after.score } }); } catch { /* */ }
      if (delta > margin) pushAnnouncement(`Good news — the change I made to ${fn} actually improved my routing accuracy, from ${pctA}% to ${pctB}%. Keeping it.`);
      logger.info('[auto-eval] KEEP', { file: fn, before: pctA, after: pctB });
      outcomes.push({ modId: r.modId, file: fn, outcome: 'kept', before: baseScore, after: after.score });
    } else {
      // Regression beyond the margin.
      r.status = _autoRevert() ? 'reverting' : 'regressed';
      r.delta = delta;
      try { evolutionLog.record({ kind: 'eval_ab', title: `REGRESSION ${fn} — routing ${pctB}% (was ${pctA}%)`, detail: `post-apply eval dropped routing accuracy by ${Math.round(-delta * 100)} points`, meta: { modId: r.modId, before: baseScore, after: after.score, autoRevert: _autoRevert() } }); } catch { /* */ }
      if (_autoRevert() && r.modId) {
        let reverted = false;
        try {
          const pythonWorker = (await import('./pythonWorker.js')).default;
          const resp = await pythonWorker.selfMod({ action: 'undo', modification_id: r.modId });
          reverted = !!(resp && resp.ok);
        } catch (e) { logger.warn('[auto-eval] auto-revert undo failed', { error: e.message }); }
        if (reverted) {
          r.status = 'reverted';
          try { const selfRestart = (await import('./selfRestart.js')).default; r.restart = selfRestart.scheduleServerRestart({ reason: `auto-eval revert of regressing change ${r.modId}` }); } catch { /* */ }
          pushAnnouncement(`Heads up — I measured the change I'd made to ${fn} and it dropped my routing accuracy from ${pctA}% to ${pctB}%, so I reverted it back to how it was. I'll reload to make that stick.`);
          logger.warn('[auto-eval] AUTO-REVERTED a regression', { file: fn, before: pctA, after: pctB });
          outcomes.push({ modId: r.modId, file: fn, outcome: 'reverted', before: baseScore, after: after.score });
        } else {
          r.status = 'regressed'; r.note = 'auto-revert failed; flagged for manual revert';
          pushAnnouncement(`Heads up — my change to ${fn} dropped my routing accuracy from ${pctA}% to ${pctB}%, and I couldn't revert it automatically. You may want to revert it manually.`);
          outcomes.push({ modId: r.modId, file: fn, outcome: 'regressed_revert_failed', before: baseScore, after: after.score });
        }
      } else {
        pushAnnouncement(`Heads up — I measured the change to ${fn} and it dropped my routing accuracy from ${pctA}% to ${pctB}%. You may want to revert it.`);
        logger.warn('[auto-eval] REGRESSION (recommend-only)', { file: fn, before: pctA, after: pctB });
        outcomes.push({ modId: r.modId, file: fn, outcome: 'regressed', before: baseScore, after: after.score });
      }
    }
  }
  _save(state);
  return { ok: true, evaluated: due.length, score: after.score, outcomes };
}

// Pure decision helper (unit-tested): given before/after scores + margin, keep or revert.
function decide(before, after, margin = _margin()) {
  if (typeof before !== 'number') return { outcome: 'kept', reason: 'no baseline' };
  const delta = after - before;
  if (delta >= -margin) return { outcome: delta > margin ? 'kept_improved' : 'kept', delta };
  return { outcome: 'revert', delta };
}

let _timer = null;
function startup() {
  if (!_on()) { logger.info('[auto-eval] disabled (AVA_AUTO_EVAL=0)'); return; }
  const delayMs = (parseInt(process.env.AVA_AUTO_EVAL_BOOT_DELAY_SEC || '150', 10) || 150) * 1000;
  _timer = setTimeout(() => { runPending().catch(e => logger.warn('[auto-eval] startup runPending failed', { error: e.message })); }, delayMs);
  if (_timer.unref) _timer.unref();
  logger.info('[auto-eval] armed post-restart evaluation', { bootDelaySec: delayMs / 1000, margin: _margin(), autoRevert: _autoRevert() });
}

function list() { return _load().records; }

export { recordApplied, runPending, startup, list, decide };
export default { recordApplied, runPending, startup, list, decide };
