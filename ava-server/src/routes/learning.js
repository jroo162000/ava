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
      const idPath = path.default.join(os.homedir(), 'ava-integration', 'ava_identity.json');
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
    const ALLOWED = ['diagnose','propose_fix','approve','rollback','list_modifications','get_status'];
    const action = req.body?.action;
    if (!action || !ALLOWED.includes(action)) {
      return res.status(400).json({ ok: false, error: `action must be: ${ALLOWED.join(', ')}` });
    }
    const response = await pythonWorker.selfMod(req.body);
    if (response.ok) {
      const result = response.result || {};
      if (['propose_fix','approve','rollback'].includes(action)) {
        result.safety_note = '⚠️ Code modification requires user approval.';
      }
      res.json({ ok: true, ...result });
    } else {
      res.status(500).json({ ok: false, error: response.error });
    }
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

export default router;
