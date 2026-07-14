// Deliver queued proactive findings at the policy-defined digest time.
import digestQueue from './digestQueue.js';
import autonomyLib from './autonomyPolicy.js';
import { pushAnnouncement } from './announceQueue.js';
import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

function hhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function digestTime() {
  try {
    const policy = autonomyLib.getAutonomy().getPolicy();
    return policy.quiet_hours?.during_quiet_hours?.digest_time || '07:15';
  } catch {
    return '07:15';
  }
}

function deliver(items) {
  if (!items.length) return;
  digestQueue.setLastDelivered(items);
  const highlights = items.slice(0, 3).map(item => item.title || item.summary).filter(Boolean);
  const extra = Math.max(0, items.length - highlights.length);
  const message = `I have ${items.length} proactive ${items.length === 1 ? 'finding' : 'findings'} for you. ${highlights.join('; ')}${extra ? `; plus ${extra} more` : ''}`.slice(0, 700);
  pushAnnouncement(message);
  emitVoiceEvent('digest.delivered', { count: items.length, items }, 'digest');
  logger.info('[digest] delivered', { count: items.length });
}

let timer = null;
let lastMinute = '';

export function startDigestScheduler() {
  if (process.env.DISABLE_AUTONOMY === '1' || timer) return false;
  const checkMs = Math.max(5000, Number(process.env.AVA_DIGEST_CHECK_MS) || 30000);
  const check = () => {
    try {
      const minute = hhmm();
      if (minute !== digestTime() || minute === lastMinute) return;
      lastMinute = minute;
      deliver(digestQueue.flush());
    } catch (error) {
      logger.warn('[digest] scheduler error', { error: error.message });
    }
  };
  timer = setInterval(check, checkMs);
  if (timer.unref) timer.unref();
  check();
  return true;
}

export function stopDigestScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export default { startDigestScheduler, stopDigestScheduler };
