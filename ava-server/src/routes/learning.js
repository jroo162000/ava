// Learning Routes - RLHF, ETA prediction, auto-learning
// Extracted from legacy server.js

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import doctorService from '../services/doctor.js';
import config from '../utils/config.js';
import pythonWorker from '../services/pythonWorker.js';
import autonomyLib from '../services/autonomyPolicy.js';
import digestQueue from '../services/digestQueue.js';
import selfImprove from '../services/selfImprove.js';
import selfRestart from '../services/selfRestart.js';
import { verifyFileSyntax } from '../utils/verifyFileSyntax.js';
import workflowEngine from '../services/workflowEngine.js';
import contextCompression from '../services/contextCompression.js';
import ftsIndex from '../services/ftsIndex.js';
import memorySearch from '../services/memorySearch.js';
import { triggerMoltbookSelfPost, triggerMoltbookEngage, getPendingVerifications, submitMoltbookVerification, previewSelfPosts } from '../services/moltbookScheduler.js';
import llmService from '../services/llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const RLHF_PATH = path.join(DATA_DIR, 'rlhf.jsonl');
const RLHF_MODEL_PATH = path.join(DATA_DIR, 'rlhf_model.json');
const ETA_PATH = path.join(DATA_DIR, 'eta.jsonl');
const ETA_MODEL_PATH = path.join(DATA_DIR, 'eta_model.json');
const STYLE_PATH = path.join(DATA_DIR, 'style.json');

const router = express.Router();

const CORE_PROPOSAL_FILES = {
  voice_main: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_local_voice.py'),
  voice_config: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_voice_config.json'),
  identity: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_identity.json'),
  self_awareness: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_self_awareness.py'),
  self_mod: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_self_modification.py'),
  worker: path.resolve(process.cwd(), '..', 'ava-integration', 'ava_python_worker.py'),
  server_main: path.resolve(process.cwd(), 'src', 'server.js'),
  api_routes: path.resolve(process.cwd(), 'src', 'routes', 'api.js'),
  agent_loop: path.resolve(process.cwd(), 'src', 'services', 'agentLoop.js'),
  tools_service: path.resolve(process.cwd(), 'src', 'services', 'tools.js'),
  llm_service: path.resolve(process.cwd(), 'src', 'services', 'llm.js'),
};

function resolveProposalFile(fileKey = '') {
  const raw = String(fileKey || '').trim();
  if (!raw) return '';
  if (CORE_PROPOSAL_FILES[raw]) return CORE_PROPOSAL_FILES[raw];
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const repoRoot = path.resolve(process.cwd(), '..');
  const candidates = [
    path.resolve(process.cwd(), raw),
    path.resolve(repoRoot, raw),
    path.resolve(repoRoot, 'ava-integration', raw),
    path.resolve(repoRoot, 'ava-server', raw),
    path.resolve(repoRoot, 'cmp-use', 'cmpuse', 'tools', raw),
  ];
  return candidates.find(p => fs.existsSync(p)) || path.resolve(repoRoot, raw);
}

function proposalReviewDiff(original, proposed) {
  return [
    'ORIGINAL CONTENT EXCERPT:',
    String(original || '').slice(0, 2800),
    '',
    'PROPOSED CONTENT EXCERPT:',
    String(proposed || '').slice(0, 2800),
  ].join('\n');
}

// Tokenization helpers
const stopWords = new Set(['the','a','an','and','or','but','if','then','else','for','of','on','in','to','is','are','was','were','be','been','being','i','you','he','she','it','we','they','me','my','your','our','their','this','that','these','those','with','as','at','by','from','about','into','over','after','before','so','not']);
function tokenize(t) {
  return String(t||'').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !stopWords.has(w));
}

// ========== Self-Awareness Endpoints ==========
router.get('/self/python-worker', async (_req, res) => {
  try {
    const response = await pythonWorker.ping();
    res.json({ ok: true, worker_ready: pythonWorker.isReady(), worker_pid: pythonWorker.getPid(), modules: pythonWorker.getModules(), response });
  } catch (e) {
    res.json({ ok: false, worker_ready: pythonWorker.isReady(), worker_pid: pythonWorker.getPid(), error: e.message });
  }
});

router.get('/self/introspect', async (_req, res) => {
  try {
    const response = await pythonWorker.introspect();
    res.json(response.ok ? { ok: true, introspection: response.result } : { ok: false, error: response.error });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/self/describe', async (_req, res) => {
  try {
    const response = await pythonWorker.describe();
    res.json(response.ok ? { ok: true, description: response.result } : { ok: false, error: response.error });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/self/diagnose', async (_req, res) => {
  try {
    const response = await pythonWorker.diagnose();
    res.json(response.ok ? { ok: true, diagnosis: response.result } : { ok: false, error: response.error });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Capability Inventory
router.get('/self/capabilities', async (_req, res) => {
  try {
    // Tools
    const toolsService = (await import('../services/tools.js')).default;
    const tools = await toolsService.getAllTools().catch(() => []);
    const toolNames = tools.map(t => ({ name: t.name, risk: t.risk_level, requires_confirm: !!t.requires_confirm }));

    // Permissions & write ability
    const securityService = (await import('../utils/security.js')).default;
    const security = securityService.getStatus();
    const writeEnabled = !!process.env.ALLOW_WRITE && (process.env.ALLOW_WRITE === '1' || process.env.ALLOW_WRITE === 'true');

    // Voice availability: check python modules and tool presence
    const pwReady = pythonWorker.isReady();
    const modules = pythonWorker.getModules() || {};
    const voiceTool = tools.find(t => t.name === 'voice_ops');
    const voiceAvailable = !!voiceTool || !!modules.voice || !!modules.voice_ops;

    // Bridge availability: ping bridge /health directly
    const config = (await import('../utils/config.js')).default;
    const bridgeHealthy = await new Promise(resolve => {
      try {
        const http = require('http');
        const req = http.request({
          hostname: config.BRIDGE_HOST || '127.0.0.1',
          port: config.BRIDGE_PORT || 3333,
          path: '/health', method: 'GET', timeout: 1500
        }, r => resolve(r.statusCode === 200));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      } catch { resolve(false); }
    });

    // Current LLM provider
    const llmService = (await import('../services/llm.js')).default;
    const llm = llmService.getSessionStats();

    // Policy status
    const autonomyLib = (await import('../services/autonomyPolicy.js')).default;
    const autonomy = autonomyLib.getAutonomy();
    const policyStatus = autonomy.getStatus();

    res.json({ ok: true, capabilities: {
      tools: toolNames,
      permissions: security,
      write: writeEnabled,
      voiceAvailable,
      bridge: { host: config.BRIDGE_HOST, port: config.BRIDGE_PORT, healthy: bridgeHealthy },
      llmProvider: llm.provider,
      policy: {
        loaded: policyStatus.loaded,
        validationMode: policyStatus.validationMode,
        strict: policyStatus.strict,
        policyVersion: policyStatus.policyVersion
      }
    }});
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Explain Yourself Mode
router.get('/self/explain', async (_req, res) => {
  try {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const config = (await import('../utils/config.js')).default;
    const llmService = (await import('../services/llm.js')).default;

    // Identity from ava_identity.json if present
    let identity = { name: 'AVA', purpose: 'personal assistant' };
    try {
      const idPath = path.default.join(config.AVA_INTEGRATION_DIR || path.default.join(os.homedir(), 'ava-integration'), 'ava_identity.json');
      if (fs.default.existsSync(idPath)) {
        identity = JSON.parse(fs.default.readFileSync(idPath, 'utf8')) || identity;
      }
    } catch {}

    // Capabilities (reuse internal call)
    const resp = await fetch('http://127.0.0.1:' + (config.PORT || 5051) + '/self/capabilities').then(r => r.json()).catch(() => ({ ok: false }));
    const caps = resp.ok ? resp.capabilities : {};

    // Provider
    const sessionStats = llmService.getSessionStats();

    const who = {
      name: identity.name || 'AVA',
      purpose: identity.purpose || 'personal assistant',
      build: config.BUILD_STAMP,
      platform: process.platform,
      node: process.version
    };

    const canDo = {
      tools: (caps.tools || []).map(t => t.name),
      write: !!caps.write,
      highRiskNeedsConfirm: true,
      bridgeHealthy: !!caps.bridge?.healthy,
      voiceAvailable: !!caps.voiceAvailable,
      llmProvider: sessionStats.provider
    };

    const improve = {
      diagnosis: '/self/doctor (propose/apply)',
      learning: ['/rlhf/*', '/learn', '/self/learn_correction'],
      guardrails: 'Server-side enforcement for risk gating and paths',
      applyMode: 'Requires ALLOW_WRITE=1 and confirm_token'
    };

    res.json({ ok: true, who, canDo, improve });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Doctor & Maintenance orchestrator
router.post('/self/doctor', async (req, res) => {
  try {
    const { mode = 'propose', reason = '', confirm_token } = req.body || {};
    if (!['propose','apply'].includes(mode)) {
      return res.status(400).json({ ok: false, error: "mode must be 'propose' or 'apply'" });
    }
    if (mode === 'apply') {
      if (!config.ALLOW_WRITE) {
        return res.status(403).json({ ok: false, error: 'apply mode requires ALLOW_WRITE=1' });
      }
      if (typeof confirm_token !== 'string' || !confirm_token.startsWith('YES_APPLY_')) {
        return res.status(400).json({ ok: false, error: "confirm_token required (format: 'YES_APPLY_<timestamp>')" });
      }
    }
    const result = await doctorService.runDoctor({ mode, reason });
    res.json({ ok: true, mode, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Autonomy decision audit: evaluate a decision without executing anything
router.post('/self/autonomy/decision', async (req, res) => {
  try {
    const { domain, trigger, risk, requiresWrite, isUserInitiated, signal } = req.body || {};
    const { getAutonomy } = autonomyLib;
    const autonomy = getAutonomy();
    const decision = autonomy.decide({ domain, trigger, risk, requiresWrite, isUserInitiated, signal });
    res.json({ ok: true, decision });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Digest endpoints
router.get('/self/digest/status', async (_req, res) => {
  try {
    res.json({ ok: true, digest: digestQueue.getStatus() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/self/digest/flush', async (_req, res) => {
  try {
    const items = digestQueue.flush();
    res.json({ ok: true, items, count: items.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/self/learn_correction', async (req, res) => {
  try {
    const { user_input, wrong, correct, context } = req.body || {};
    if (!user_input) return res.status(400).json({ ok: false, error: 'user_input required' });
    const response = await pythonWorker.learnCorrection(user_input, wrong, correct, context);
    res.json(response.ok ? { ok: true, learned: response.result === true } : { ok: false, error: response.error });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/self_mod', async (req, res) => {
  try {
    const ALLOWED = ['diagnose','propose_fix','approve','reject','rollback','undo','revert','list_pending','list_all','list_modifications','get_status'];
    const action = req.body?.action;
    if (!action || !ALLOWED.includes(action)) {
      return res.status(400).json({ ok: false, error: `action must be: ${ALLOWED.join(', ')}` });
    }
    let body = req.body;
    if (action === 'propose_fix') {
      const target = resolveProposalFile(req.body?.file);
      const proposedContent = req.body?.content;
      if (!target || !fs.existsSync(target)) {
        return res.json({
          ok: true,
          status: 'denied',
          approval_required: true,
          review_recommendation: 'deny',
          review_reason: `codex: target file "${req.body?.file || ''}" does not exist, so this proposal cannot be verified or applied safely.`,
          reviewers: [{
            reviewer: 'codex',
            model: 'local-gate',
            recommendation: 'deny',
            reason: `Target file "${req.body?.file || ''}" does not exist.`,
            risks: ['Model-invented file path', 'Applying would create or overwrite the wrong file'],
          }],
          message: `Refused: target file "${req.body?.file || ''}" does not exist.`,
        });
      }
      const textContent = typeof proposedContent === 'string' ? proposedContent : '';
      if (!textContent.trim()) {
        return res.json({
          ok: true,
          status: 'denied',
          approval_required: true,
          review_recommendation: 'deny',
          review_reason: 'codex: proposal did not include replacement file content.',
          reviewers: [{
            reviewer: 'codex',
            model: 'local-gate',
            recommendation: 'deny',
            reason: 'Proposal did not include replacement file content.',
            risks: ['Empty proposal content cannot be reviewed or applied safely'],
          }],
          message: 'Refused: proposal did not include replacement file content.',
        });
      }
      const suspiciousPatch = /^\s*(diff --git|---\s+a\/|\+\+\+\s+b\/|ERROR reading\b)/i.test(textContent);
      if (suspiciousPatch) {
        return res.json({
          ok: true,
          status: 'denied',
          approval_required: true,
          review_recommendation: 'deny',
          review_reason: 'codex: proposal content is a patch/error transcript, but self_mod requires full replacement content for an existing file.',
          reviewers: [{
            reviewer: 'codex',
            model: 'local-gate',
            recommendation: 'deny',
            reason: 'Proposal content is a patch/error transcript, not full replacement file content.',
            risks: ['Would replace source file with a patch transcript', 'Could destroy the target file contents'],
          }],
          message: 'Refused: self_mod proposals must provide full replacement content, not a patch transcript.',
        });
      }
      const original = fs.readFileSync(target, 'utf8');
      const proposalReview = await selfImprove.reviewProposal({
        file: target,
        reason: req.body?.reason || 'No reason provided',
        diff: proposalReviewDiff(original, textContent),
      });
      body = {
        ...req.body,
        file: target,
        metadata: {
          ...(req.body?.metadata || {}),
          generatorReason: req.body?.reason || 'manual self_mod proposal',
          proposedAt: new Date().toISOString(),
          reviewRecommendation: proposalReview.recommendation,
          reviewReason: proposalReview.reason,
          reviewers: proposalReview.reviewers,
        },
      };
    }

    const response = await pythonWorker.selfMod(body);
    if (response.ok) {
      const result = response.result || {};
      if (['propose_fix','approve','rollback','undo','revert'].includes(action)) {
        result.safety_note = '⚠️ Code modification requires user approval.';
      }
      if (action === 'approve' && result.status === 'success') {
        // Verify the applied file actually PARSES before restarting into it. A broken approve that
        // triggers a restart would take the server down — so if it doesn't parse, revert it and do
        // NOT restart. Matches the voice approval path; "applied" never means broken code.
        const appliedFile = result.file || result.file_path || body.file;
        const v = await verifyFileSyntax(appliedFile);
        if (!v.ok) {
          try { await pythonWorker.selfMod({ action: 'undo', modification_id: result.modification_id || req.body?.modification_id }); } catch { /* best effort */ }
          result.status = 'reverted';
          result.verify_error = v.error;
          result.message = `I applied it, but it failed a syntax check (${v.error}) — so I reverted it instead of restarting into broken code.`;
          return res.json({ ok: true, ...result });
        }
        result.restart = selfRestart.scheduleServerRestart({
          reason: `UI approved proposal ${result.modification_id || req.body?.modification_id || ''}`.trim()
        });
        if (result.restart?.scheduled) {
          result.message = `${result.message || 'Modification applied.'} Verified it parses; server refresh scheduled so the change can load.`;
        }
      }
      // Undoing an applied change also needs the server to reload to take effect.
      if ((action === 'undo' || action === 'revert') && result.status === 'success') {
        result.restart = selfRestart.scheduleServerRestart({
          reason: `UI undo of ${result.modification_id || req.body?.modification_id || ''}`.trim()
        });
        if (result.restart?.scheduled) {
          result.message = `${result.message || 'Change reverted.'} Server refresh scheduled so the revert can load.`;
        }
      }
      res.json({ ok: true, ...result });
    } else {
      res.status(500).json({ ok: false, error: response.error });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Manually trigger a self-improvement scan now (otherwise it runs on a schedule). Produces at
// most one proposed change, queued for approval in the UI / by voice. Never applies anything.
router.post('/improve', async (req, res) => {
  try {
    const out = await selfImprove.runScan({ reason: (req.body && req.body.reason) || 'manual', max: 1, avoid: (req.body && req.body.avoid) || [] });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Probe each model in the self-mod reasoning chain so we know which actually work.
router.post('/selfmod/probe', async (_req, res) => {
  const env = process.env;
  const k = (n) => config[n] || env[n] || '';
  const msgs = [{ role: 'user', content: 'Reply with the single word OK.' }];
  const primaryOpenAI = env.AVA_SM_OPENAI || 'gpt-5.5';
  const stableOpenAI = env.AVA_SM_OPENAI_FALLBACK || 'gpt-5.1';
  const openAIModels = [...new Set([primaryOpenAI, stableOpenAI].filter(Boolean))];
  const tests = [
    // Claude is the PRIMARY self-mod model — probe it FIRST so we can see if it's healthy.
    ['claude/' + (env.AVA_SM_CLAUDE || 'claude-opus-4-8'), () => llmService.createCompletionClaude({ messages: msgs, system: 'You reply tersely.', maxTokens: 50, model: env.AVA_SM_CLAUDE || 'claude-opus-4-8' })],
    ...openAIModels.map(model => ['openai/' + model, () => llmService._openaiCompat({ baseURL: 'https://api.openai.com/v1', apiKey: k('OPENAI_API_KEY'), model, system: 'You reply tersely.', messages: msgs, maxTokens: 512 })]),
    ['gemini/' + (env.AVA_SM_GEMINI || 'gemini-pro-latest'), () => llmService.createCompletionGemini({ messages: msgs, system: 'You reply tersely.', maxTokens: 512, model: env.AVA_SM_GEMINI || 'gemini-pro-latest' })],
    ['deepseek/' + (env.AVA_SM_DEEPSEEK || 'deepseek-reasoner'), () => llmService._openaiCompat({ baseURL: 'https://api.deepseek.com', apiKey: k('DEEPSEEK_API_KEY'), model: env.AVA_SM_DEEPSEEK || 'deepseek-reasoner', system: 'You reply tersely.', messages: msgs, maxTokens: 512 })],
    ['grok/' + (env.AVA_SM_GROK || 'grok-4'), () => llmService._openaiCompat({ baseURL: 'https://api.x.ai/v1', apiKey: k('GROK_API_KEY'), model: env.AVA_SM_GROK || 'grok-4', system: 'You reply tersely.', messages: msgs, maxTokens: 512 })],
  ];
  const out = [];
  for (const [name, fn] of tests) {
    try { const r = await fn(); out.push({ name, ok: !!String(r.content || r.text || '').trim(), sample: String(r.content || r.text || '').slice(0, 40) }); }
    catch (e) { out.push({ name, ok: false, error: String(e.message || e).slice(0, 170) }); }
  }
  // The decisive check: run the ACTUAL self-mod chain once and report which model actually wins
  // (this is exactly what gets recorded as the proposal's decision model).
  let chainWinner = null;
  try { const r = await llmService.chatSelfMod(msgs, { max_tokens: 512 }); chainWinner = r.provider || r.model || null; }
  catch (e) { chainWinner = 'chain-failed: ' + String(e.message || e).slice(0, 160); }
  res.json({ ok: true, chainWinner, chain: out });
});

// Judge ONE proposed self-modification for accuracy/safety (strong-model code review).
router.post('/selfmod/judge', async (req, res) => {
  try {
    const { file, reason, diff } = req.body || {};
    const sys = [
      'You are a strict senior code reviewer judging ONE proposed self-modification to an AVA',
      'source file. Decide if it is ACCURATE and SAFE to apply. Consider: does the change actually',
      'accomplish its stated reason; is it syntactically valid; could it break behavior, remove',
      'needed logic, change control flow incorrectly, or introduce a bug; is it minimal and on-target.',
      'Be skeptical — only "verify" if you are confident it is correct and safe.',
      'Respond STRICT JSON only: {"verdict":"verify"|"deny","issue":"<short: for deny the specific',
      'flaw; for verify why it is correct>","rule":"<if deny, a one-line general rule AVA should',
      'follow next time to avoid this mistake; else empty string>"}',
    ].join('\n');
    const user = `FILE: ${file}\nSTATED REASON: ${reason}\n\nDIFF:\n${String(diff || '').slice(0, 6000)}`;
    const r = await llmService.chatSelfMod(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { max_tokens: 600 }
    );
    const txt = String(r.text || r.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
    const m = txt.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (!j || !j.verdict) return res.json({ ok: true, verdict: 'deny', issue: 'judge could not parse a verdict', rule: '' });
    res.json({ ok: true, verdict: j.verdict === 'verify' ? 'verify' : 'deny', issue: String(j.issue || '').slice(0, 300), rule: String(j.rule || '').slice(0, 200) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Preview (debug): generate sample posts WITHOUT posting, to confirm they're persona-driven + varied.
router.get('/moltbook/preview', async (req, res) => {
  try {
    const n = Math.max(1, Math.min(6, parseInt(req.query.n, 10) || 4));
    res.json({ ok: true, ...(await previewSelfPosts(n)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Manually post one original self-interested post to Moltbook now.
router.post('/moltbook/selfpost', async (_req, res) => {
  try { res.json({ ok: true, ...(await triggerMoltbookSelfPost()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Manually comment on one of someone else's feed posts now.
router.post('/moltbook/engage', async (_req, res) => {
  try { res.json({ ok: true, ...(await triggerMoltbookEngage()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Posts awaiting the user's answer to a Moltbook verification challenge.
router.get('/moltbook/verifications', async (_req, res) => {
  try { res.json({ ok: true, pending: await getPendingVerifications() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// User submits the answer to a challenge -> publishes the post (AVA never auto-solves it).
router.post('/moltbook/verify', async (req, res) => {
  try {
    const { code, answer } = req.body || {};
    if (!code || answer === undefined || answer === '') return res.status(400).json({ ok: false, error: 'code and answer required' });
    const out = await submitMoltbookVerification(code, answer);
    res.json({ ok: out.ok, ...out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== RLHF Endpoints ==========
router.post('/rlhf/log', (req, res) => {
  try {
    const { text, context, liked } = req.body || {};
    fs.appendFileSync(RLHF_PATH, JSON.stringify({ ts: Date.now(), text: text||'', context: context||'', liked: !!liked }) + '\n');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/rlhf/train', (_req, res) => {
  try {
    const lines = fs.existsSync(RLHF_PATH) ? fs.readFileSync(RLHF_PATH,'utf8').split(/\r?\n/).filter(Boolean) : [];
    const pos = [], neg = [];
    for (const l of lines) {
      try { const j = JSON.parse(l); const txt = `${j.text||''} ${j.context||''}`; j.liked ? pos.push(txt) : neg.push(txt); } catch {}
    }
    const vocab = new Map();
    const count = (arr) => { const m = new Map(); for(const s of arr) for(const w of tokenize(s)) { if(!vocab.has(w)) vocab.set(w,vocab.size); m.set(w,(m.get(w)||0)+1); } return m; };
    const posM = count(pos), negM = count(neg);
    const V = Math.max(1, vocab.size), alpha = 1;
    const nPos = Array.from(posM.values()).reduce((a,b)=>a+b,0);
    const nNeg = Array.from(negM.values()).reduce((a,b)=>a+b,0);
    const priorPos = Math.log((pos.length+alpha)/(pos.length+neg.length+2*alpha));
    const priorNeg = Math.log((neg.length+alpha)/(pos.length+neg.length+2*alpha));
    const condPos = {}, condNeg = {};
    for (const [w] of vocab) {
      condPos[w] = Math.log(((posM.get(w)||0)+alpha)/(nPos+alpha*V));
      condNeg[w] = Math.log(((negM.get(w)||0)+alpha)/(nNeg+alpha*V));
    }
    fs.writeFileSync(RLHF_MODEL_PATH, JSON.stringify({ priorPos, priorNeg, condPos, condNeg }));
    res.json({ ok: true, positives: pos.length, negatives: neg.length, vocab: V });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/rlhf/predict', (req, res) => {
  try {
    const txt = `${req.body?.text||''} ${req.body?.context||''}`;
    if (!fs.existsSync(RLHF_MODEL_PATH)) return res.json({ ok: false, error: 'no_model' });
    const model = JSON.parse(fs.readFileSync(RLHF_MODEL_PATH,'utf8'));
    const toks = tokenize(txt);
    let llPos = model.priorPos||0, llNeg = model.priorNeg||0;
    for (const w of toks) { if (typeof model.condPos[w]==='number') llPos += model.condPos[w]; if (typeof model.condNeg[w]==='number') llNeg += model.condNeg[w]; }
    const m = Math.max(llPos, llNeg);
    res.json({ ok: true, probLiked: Math.exp(llPos-m)/(Math.exp(llPos-m)+Math.exp(llNeg-m)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/rlhf/style', (req, res) => {
  try {
    let s = fs.existsSync(STYLE_PATH) ? JSON.parse(fs.readFileSync(STYLE_PATH,'utf8')) : { concise:0, detail:0 };
    if (req.body?.action === 'concise') s.concise++;
    if (req.body?.action === 'detail') s.detail++;
    fs.writeFileSync(STYLE_PATH, JSON.stringify(s));
    res.json({ ok: true, ...s });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/rlhf/style', (_req, res) => {
  try {
    const s = fs.existsSync(STYLE_PATH) ? JSON.parse(fs.readFileSync(STYLE_PATH,'utf8')) : { concise:0, detail:0 };
    res.json({ ok: true, ...s, pref: s.concise >= s.detail ? 'concise' : 'detail' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== ETA Endpoints ==========
function etaFeatures(s) {
  const hash = (str) => { let h=2166136261; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; };
  return [1, Number(s.items_total||0), Number(s.items_done||0), Number(s.rate||0), Number(s.cpu||0), Number(s.ram||0), /ssd|nvme/.test(String(s.disk||'').toLowerCase())?1:0, Number(s.file_count||0), (hash(String(s.phase||'')+'0')%5)/5, (hash(String(s.phase||'')+'1')%5)/5];
}

router.post('/eta/log', (req, res) => {
  try {
    fs.appendFileSync(ETA_PATH, JSON.stringify({ ts: Date.now(), ...req.body }) + '\n');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/eta/train', (_req, res) => {
  try {
    const lines = fs.existsSync(ETA_PATH) ? fs.readFileSync(ETA_PATH,'utf8').split(/\r?\n/).filter(Boolean) : [];
    const byRun = new Map();
    for (const l of lines) { try { const j=JSON.parse(l); const k=String(j.run_id||'default'); if(!byRun.has(k)) byRun.set(k,[]); byRun.get(k).push(j); } catch{} }
    const X=[], y=[];
    for (const [_, arr] of byRun) {
      arr.sort((a,b)=>a.ts-b.ts);
      const tEnd = arr[arr.length-1]?.ts||0;
      for (let i=0;i<arr.length-1;i++) { X.push(etaFeatures(arr[i])); y.push(Math.max(0,(tEnd-arr[i].ts)/1000)); }
    }
    if (X.length<3) return res.json({ ok: false, error: 'not_enough_samples' });
    // Ridge regression solve
    const n = X[0].length, m = X.length;
    const At = Array.from({length:n},(_,i)=>X.map(r=>r[i]));
    const G = Array.from({length:n},()=>Array(n).fill(0));
    for(let i=0;i<n;i++) for(let j=0;j<n;j++) { let s=0; for(let k=0;k<m;k++) s+=At[i][k]*At[j][k]; G[i][j]=s+(i===j?1e-3:0); }
    const yv = Array.from({length:n},(_,i)=>{ let s=0; for(let k=0;k<m;k++) s+=At[i][k]*y[k]; return s; });
    const aug = G.map((row,i)=>row.concat([yv[i]]));
    for(let i=0;i<n;i++) { let p=i; for(let r=i+1;r<n;r++) if(Math.abs(aug[r][i])>Math.abs(aug[p][i])) p=r; if(p!==i){const tmp=aug[i];aug[i]=aug[p];aug[p]=tmp;} const piv=aug[i][i]||1e-12; for(let j=i;j<=n;j++) aug[i][j]/=piv; for(let r=0;r<n;r++) if(r!==i){const f=aug[r][i]; for(let j=i;j<=n;j++) aug[r][j]-=f*aug[i][j];} }
    const w = aug.map(row=>row[n]);
    const yhat = X.map(r=>r.reduce((a,v,i)=>a+v*w[i],0));
    const mean = y.reduce((a,b)=>a+b,0)/Math.max(1,y.length);
    let ssTot=0, ssRes=0; for(let i=0;i<y.length;i++){ssTot+=(y[i]-mean)**2; ssRes+=(y[i]-yhat[i])**2;}
    const r2 = 1-(ssRes/(ssTot||1e-9));
    fs.writeFileSync(ETA_MODEL_PATH, JSON.stringify({ w, r2 }));
    res.json({ ok: true, samples: X.length, r2 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/eta/predict', (req, res) => {
  try {
    const s = req.body||{};
    let model = fs.existsSync(ETA_MODEL_PATH) ? JSON.parse(fs.readFileSync(ETA_MODEL_PATH,'utf8')) : null;
    const feat = etaFeatures(s);
    let secs = 0, conf = 0;
    if (model?.w) { secs = feat.reduce((a,v,i)=>a+v*(model.w[i]||0),0); conf = model.r2||0; }
    else { secs = Math.max(0,Number(s.items_total||0)-Number(s.items_done||0))/Math.max(0.001,Number(s.rate||0)); }
    res.json({ ok: true, secs: Math.max(0,secs), conf });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/anomaly/check', (req, res) => {
  try {
    const { window=[], thresholdMinutes=2 } = req.body||{};
    if (!Array.isArray(window)||window.length<2) return res.json({ ok: false, error: 'not_enough_points' });
    const sorted = window.slice().sort((a,b)=>a.ts-b.ts);
    let progress=0; for(let i=1;i<sorted.length;i++) progress+=Math.max(0,(sorted[i].items_done||0)-(sorted[i-1].items_done||0));
    const dtMin = (sorted[sorted.length-1].ts-sorted[0].ts)/60000;
    res.json({ ok: true, stuck: dtMin>=thresholdMinutes && progress<=0, rate: progress/Math.max(0.001,dtMin) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/learn', async (req, res) => {
  try {
    const { user_message, ava_response } = req.body||{};
    if (!user_message || user_message.length < 5) return res.json({ ok: true, skipped: true, reason: 'message too short' });
    logger.info('[learn] Recording interaction', { userLen: user_message?.length, avaLen: ava_response?.length });
    res.json({ ok: true, learning: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- Long-horizon WORKFLOWS: plan a big goal into stages, run them with checkpointing + replanning ----
// Start a workflow: AVA plans the goal into stages and begins running them in the background.
router.post('/workflow/start', async (req, res) => {
  try {
    const goal = req.body?.goal || req.body?.text;
    if (!goal || String(goal).trim().length < 4) return res.status(400).json({ ok: false, error: 'goal required' });
    res.json(await workflowEngine.start(goal));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Status of one workflow (stages, progress, log).
router.get('/workflow/:id', (req, res) => {
  const wf = workflowEngine.get(req.params.id);
  if (!wf) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, ...wf });
});
// List recent workflows.
router.get('/workflows', (_req, res) => { res.json({ ok: true, workflows: workflowEngine.list() }); });
// Resume a paused/incomplete workflow on demand.
router.post('/workflow/:id/resume', (req, res) => { res.json(workflowEngine.resume(req.params.id)); });

// ---- Context compression + lineage (Hermes-style) ----
// Force/trigger a rolling-summary compression for a session and return the result.
router.post('/context/compress', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || req.body?.session_id || 'default';
    res.json({ ok: true, ...(await contextCompression.maybeCompress(sessionId, { force: !!req.body?.force })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Inspect the lineage chain (parent->child summary generations) for a session.
router.get('/context/lineage/:sessionId', (req, res) => { res.json({ ok: true, ...contextCompression.lineage(req.params.sessionId) }); });

// ---- FTS memory search (SQLite FTS5) ----
// Search memory + conversation history; reports whether the FTS index served it.
router.get('/memory/search', (req, res) => {
  try {
    const q = req.query.q || req.query.query || '';
    res.json({ ok: true, fts: ftsIndex.available(), ...memorySearch.search(String(q), parseInt(req.query.limit || '8', 10)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
