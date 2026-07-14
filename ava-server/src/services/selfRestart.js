import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';

let restartScheduled = false;

function repoRelative(filePath) {
  if (!filePath) return '';
  const root = path.resolve(avaPaths.repoRoot());
  const absolute = path.resolve(String(filePath));
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  return relative && !relative.startsWith('../') && relative !== '..' ? relative : '';
}

function activationPlan(filePath) {
  const file = repoRelative(filePath);
  const lower = file.toLowerCase();
  if (!file) return { file, mode: 'server_restart', reason: 'target is outside the AVa repository' };

  if (lower.startsWith('ava-client/src/') || lower.startsWith('ava-client/public/') || lower === 'ava-client/index.html') {
    return { file, mode: 'frontend_hmr', reason: 'the Vite client loads this edit live' };
  }
  if (lower.startsWith('ava-integration/memory/') || lower.startsWith('ava-server/data/')
      || lower.startsWith('docs/') || lower.includes('/tests/') || /(^|\/)(readme|agents)\.md$/.test(lower)) {
    return { file, mode: 'live_data', reason: 'the runtime reads this content without reloading server modules' };
  }
  if (lower === 'ava-integration/ava_local_voice.py' || lower === 'ava-integration/ava_voice_config.json'
      || lower === 'ava-integration/.env' || lower.endsWith('/start_local_voice.bat')) {
    return { file, mode: 'voice_restart_required', reason: 'the voice process reads this only at startup' };
  }
  if (lower === 'ava-integration/ava_python_worker.py'
      || /^ava-integration\/(ava_self_awareness|ava_self_modification|ava_passive_learning)\.py$/.test(lower)
      || lower.startsWith('cmp-use/')) {
    return { file, mode: 'python_worker_restart', reason: 'only the Python tool worker owns this module' };
  }
  return { file, mode: 'server_restart', reason: 'the running Node process has this module loaded' };
}

function writeRestartRecord(record) {
  try {
    fs.mkdirSync(avaPaths.dataDir(), { recursive: true });
    fs.writeFileSync(
      path.join(avaPaths.dataDir(), 'pending-server-restart.json'),
      JSON.stringify(record, null, 2),
      'utf8'
    );
  } catch {}
}

function scheduleServerRestart({ reason = 'approved self-modification', delayMs = 2500 } = {}) {
  if (process.env.AVA_SELF_RESTART_OFF === '1') {
    return { scheduled: false, reason: 'disabled by AVA_SELF_RESTART_OFF' };
  }
  if (restartScheduled) {
    return { scheduled: true, alreadyScheduled: true, reason: 'restart already scheduled' };
  }

  const serverRoot = avaPaths.serverDir();
  const serverEntry = path.join(serverRoot, 'src', 'server.js');
  const helper = path.join(serverRoot, 'scripts', 'restart-server-after-delay.cjs');
  if (!fs.existsSync(serverEntry) || !fs.existsSync(helper)) {
    return { scheduled: false, reason: 'restart helper or server entry not found' };
  }

  const record = {
    requestedAt: new Date().toISOString(),
    reason,
    parentPid: process.pid,
    serverEntry,
    delayMs
  };
  writeRestartRecord(record);

  try {
    const child = spawn(process.execPath, [helper, serverEntry, String(delayMs)], {
      cwd: serverRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AVA_RESTART_PARENT_PID: String(process.pid) }
    });
    child.unref();
    restartScheduled = true;
    logger.warn('[selfRestart] server restart scheduled', record);
    setTimeout(() => process.exit(0), 700);
    return { scheduled: true, delayMs, reason };
  } catch (e) {
    logger.warn('[selfRestart] failed to schedule server restart', { error: e.message });
    return { scheduled: false, reason: e.message };
  }
}

async function activateAppliedChanges({ files = [], reason = 'approved self-modification', delayMs = 2500 } = {}) {
  const plans = [...new Set((files || []).filter(Boolean).map(String))].map(activationPlan);
  if (!plans.length) plans.push(activationPlan(''));

  const needsServer = plans.some(plan => plan.mode === 'server_restart');
  const needsVoice = plans.some(plan => plan.mode === 'voice_restart_required');
  if (needsServer) {
    return {
      mode: needsVoice ? 'server_and_voice_restart_required' : 'server_restart',
      plans,
      ...scheduleServerRestart({ reason, delayMs }),
      voiceRestartRequired: needsVoice,
    };
  }
  if (needsVoice) {
    return {
      mode: 'voice_restart_required',
      plans,
      scheduled: false,
      voiceRestartRequired: true,
      reason: 'voice runner restart required for this file type',
    };
  }
  if (plans.some(plan => plan.mode === 'python_worker_restart')) {
    try {
      const pythonWorker = (await import('./pythonWorker.js')).default;
      const worker = await pythonWorker.restart({ reason });
      return { mode: 'python_worker_restart', plans, scheduled: false, hotApplied: true, worker };
    } catch (error) {
      logger.warn('[selfRestart] Python worker hot activation failed', { error: error.message });
      return { mode: 'python_worker_restart_failed', plans, scheduled: false, hotApplied: false, error: error.message };
    }
  }
  return { mode: 'hot', plans, scheduled: false, hotApplied: true };
}

function describeActivation(activation = {}) {
  switch (activation.mode) {
    case 'hot': return 'The change is live without restarting AVa.';
    case 'python_worker_restart': return 'I reloaded only my Python tool worker; chat and voice stayed up.';
    case 'frontend_hmr': return 'The interface loaded the change live without restarting AVa.';
    case 'voice_restart_required': return 'This change belongs to the voice process and will load when that component is refreshed.';
    case 'server_and_voice_restart_required': return 'My server refresh is scheduled; the voice component also needs its own refresh for this change.';
    case 'server_restart': return activation.scheduled
      ? 'I scheduled a rolling server refresh so the loaded module can take effect; the voice runner stays up.'
      : 'The loaded server module still needs a refresh before this change takes effect.';
    default: return activation.error
      ? `I applied the file, but its live activation failed: ${activation.error}`
      : 'I applied the file, but could not determine its live activation state.';
  }
}

export { activateAppliedChanges, activationPlan, describeActivation, scheduleServerRestart };
export default { activateAppliedChanges, activationPlan, describeActivation, scheduleServerRestart };
