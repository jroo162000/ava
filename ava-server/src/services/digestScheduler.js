// Digest Scheduler - auto-flush digest at quiet-hours digest time
import digestQueue from './digestQueue.js';
import autonomyLib from './autonomyPolicy.js';
import logger from '../utils/logger.js';

function hhmm(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function isDigestTime() {
  try {
    const { getAutonomy } = autonomyLib; const autonomy = getAutonomy(logger);
    const policy = autonomy.getPolicy();
    const qh = policy.quiet_hours || {};
    const digest = (qh.during_quiet_hours && qh.during_quiet_hours.digest_time) || '07:15';
    return hhmm() === digest;
  } catch { return false; }
}

let _timer = null;
let _lastMinute = '';

export function startDigestScheduler() {
  // Guard: skip scheduler when voice mode is active
  if (process.env.DISABLE_AUTONOMY === '1') {
    logger.info('[autonomy] disabled (voice mode) — digest scheduler will not start');
    return;
  }
  if (_timer) return;
  _timer = setInterval(() => {
    try {
      const nowMinute = hhmm();
      if (nowMinute !== _lastMinute) {
        _lastMinute = nowMinute;
        if (isDigestTime()) {
          const items = digestQueue.flush();
          if (items.length > 0) {
            digestQueue.setLastDelivered(items);
            logger.info(`[digest] Auto-delivered ${items.length} item(s) at digest time.`);
          }
        }
      }
    } catch (e) {
      logger.warn('[digest] scheduler error', { error: e.message });
    }
  }, 30 * 1000);
}

export default { startDigestScheduler };

