import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import pythonWorker from './pythonWorker.js';
import uiPush from './uiPush.js';
import { emitVoiceEvent } from './voiceBus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(__dirname, '..', '..', 'data', 'external-proposal-reviews');
const bootstrapConfigPath = path.join(defaultRoot, 'config.json');
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}
const bootstrapConfig = readJson(bootstrapConfigPath);
const root = path.resolve(process.env.AVA_EXTERNAL_PROPOSAL_REVIEW_DIR || bootstrapConfig.queueRoot || defaultRoot);
const inboxDir = path.join(root, 'inbox');
const outboxDir = path.join(root, 'outbox');
const receiptDir = path.join(root, 'receipts');
const configPath = path.join(root, 'config.json');
let timer = null;
let processing = false;

function readConfig() {
  return { ...readJson(bootstrapConfigPath), ...readJson(configPath) };
}

export function isEnabled() {
  if (process.env.AVA_EXTERNAL_PROPOSAL_REVIEW === '0') return false;
  if (process.env.AVA_EXTERNAL_PROPOSAL_REVIEW === '1') return true;
  return readConfig().enabled === true;
}

function ensureDirs() {
  for (const dir of [inboxDir, outboxDir, receiptDir]) fs.mkdirSync(dir, { recursive: true });
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function requestIdFor(modificationId, diff) {
  const digest = crypto.createHash('sha256').update(`${modificationId}\n${diff || ''}`).digest('hex').slice(0, 12);
  return `${modificationId}-${digest}`;
}

export function queueReview({ modificationId, file, reason, diff, decisionModel, planModel, editModel, internalReview }) {
  if (!isEnabled()) return null;
  ensureDirs();
  const requestId = requestIdFor(modificationId, diff);
  const packet = {
    schemaVersion: 1,
    requestId,
    modificationId,
    targetFile: path.resolve(file),
    reason: String(reason || ''),
    diff: String(diff || ''),
    generator: { decisionModel, planModel, editModel },
    internalReview,
    requestedReviewer: 'codex-task',
    createdAt: new Date().toISOString(),
  };
  const target = path.join(inboxDir, `${requestId}.json`);
  if (!fs.existsSync(target)) atomicJson(target, packet);
  emitVoiceEvent('selfmod.external_review_requested', {
    requestId, modificationId, file: packet.targetFile,
  }, 'self-improvement');
  return packet;
}

function normalizeResult(raw, request) {
  const recommendation = String(raw?.recommendation || raw?.verdict || '').toLowerCase();
  if (!['approve', 'deny'].includes(recommendation)) throw new Error('external review must recommend approve or deny');
  if (String(raw?.requestId || '') !== request.requestId) throw new Error('external review requestId does not match');
  if (String(raw?.modificationId || '') !== request.modificationId) throw new Error('external review modificationId does not match');
  const reason = String(raw?.reason || '').trim();
  if (reason.length < 20) throw new Error('external review reason is too short to be evidence-based');
  return {
    reviewer: 'codex-task',
    model: String(raw?.model || 'codex-task'),
    recommendation,
    reason: reason.slice(0, 1200),
    risks: Array.isArray(raw?.risks) ? raw.risks.slice(0, 8).map(item => String(item).slice(0, 240)) : [],
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.slice(0, 8).map(item => String(item).slice(0, 300)) : [],
    reviewedAt: raw?.reviewedAt || new Date().toISOString(),
    requestId: request.requestId,
  };
}

function terminalProposalStatus(result) {
  const message = String(result?.message || '');
  const already = message.match(/\bModification already (rejected|applied|approved|failed)\b/i);
  if (already) return already[1].toLowerCase();
  if (/\bModification\s+\S+\s+not found\b/i.test(message)) return 'not_found';
  return null;
}

async function applyResult(request, review, status = 'complete') {
  const response = await pythonWorker.selfMod({
    action: 'update_review',
    modification_id: request.modificationId,
    external_review_status: status,
    review,
  });
  const result = (response && (response.result || response)) || {};
  if (!['ok', 'success'].includes(String(result.status || '').toLowerCase())) {
    const terminalStatus = terminalProposalStatus(result);
    if (terminalStatus) {
      atomicJson(path.join(receiptDir, `${request.requestId}.json`), {
        requestId: request.requestId,
        modificationId: request.modificationId,
        status: `proposal_${terminalStatus}`,
        review,
        terminalMessage: String(result.message || ''),
        appliedAt: new Date().toISOString(),
      });
      logger.info('[external-review] stale proposal packet closed', {
        requestId: request.requestId,
        modificationId: request.modificationId,
        terminalStatus,
      });
      return;
    }
    throw new Error(result.message || `could not update proposal ${request.modificationId}`);
  }
  atomicJson(path.join(receiptDir, `${request.requestId}.json`), {
    requestId: request.requestId,
    modificationId: request.modificationId,
    status,
    review,
    appliedAt: new Date().toISOString(),
  });
  await uiPush.pushSelfModPending();
  emitVoiceEvent('selfmod.external_review_completed', {
    requestId: request.requestId,
    modificationId: request.modificationId,
    status,
    recommendation: review.recommendation,
    reason: review.reason,
    modification: result.modification || null,
  }, 'self-improvement');
}

async function processInbox() {
  if (!isEnabled() || processing || !pythonWorker.isReady?.()) return;
  processing = true;
  try {
    ensureDirs();
    const timeoutMs = Math.max(60000, Number(process.env.AVA_EXTERNAL_REVIEW_TIMEOUT_MS)
      || Number(readConfig().timeoutMs) || 20 * 60 * 1000);
    const files = fs.readdirSync(inboxDir).filter(file => file.endsWith('.json'));
    for (const file of files) {
      const request = JSON.parse(fs.readFileSync(path.join(inboxDir, file), 'utf8'));
      if (fs.existsSync(path.join(receiptDir, `${request.requestId}.json`))) continue;
      const outbox = path.join(outboxDir, `${request.requestId}.json`);
      if (fs.existsSync(outbox)) {
        const review = normalizeResult(JSON.parse(fs.readFileSync(outbox, 'utf8')), request);
        await applyResult(request, review);
        continue;
      }
      const age = Date.now() - Date.parse(request.createdAt || 0);
      if (Number.isFinite(age) && age >= timeoutMs) {
        await applyResult(request, {
          reviewer: 'codex-task',
          model: 'external-task',
          recommendation: 'review',
          reason: 'The external Codex task did not return before the configured timeout. The proposal is being exposed with its internal reviews only, and this timeout is shown explicitly.',
          risks: ['External task verdict unavailable'],
          evidence: [],
          reviewedAt: new Date().toISOString(),
          requestId: request.requestId,
        }, 'timed_out');
      }
    }
  } catch (error) {
    logger.warn('[external-review] inbox processing failed', { error: error.message });
  } finally {
    processing = false;
  }
}

export function start() {
  if (!isEnabled() || timer) return;
  ensureDirs();
  processInbox().catch(() => {});
  timer = setInterval(() => processInbox().catch(() => {}),
    Math.max(5000, Number(process.env.AVA_EXTERNAL_REVIEW_POLL_MS) || 15000));
  timer.unref?.();
  logger.info('[external-review] proposal review bridge started', { inboxDir, outboxDir });
}

export const _internals = { normalizeResult, requestIdFor, terminalProposalStatus };
export default { isEnabled, queueReview, start, paths: { root, inboxDir, outboxDir, receiptDir, configPath }, _internals };
