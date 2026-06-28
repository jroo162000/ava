import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import logger from '../utils/logger.js';

let restartScheduled = false;

function dataDir() {
  return path.join(process.cwd(), 'data');
}

function writeRestartRecord(record) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir(), 'pending-server-restart.json'),
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

  const serverEntry = path.join(process.cwd(), 'src', 'server.js');
  const helper = path.join(process.cwd(), 'scripts', 'restart-server-after-delay.cjs');
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
      cwd: process.cwd(),
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

export { scheduleServerRestart };
export default { scheduleServerRestart };
