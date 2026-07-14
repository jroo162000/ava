// Main API routes: /respond and /chat share routes/respond.js; /train/*
// lives in routes/train.js. Spoken-reply
// shaping is services/speech.js and the self-mod voice flow is services/selfModVoice.js.
import express from 'express';
import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from '../services/memory.js';
import llmService from '../services/llm.js';
import toolsService from '../services/tools.js';
import conversationLogger from '../services/conversationLogger.js';
import artifactBus from '../services/artifactBus.js';
import memoryReviewer from '../services/memoryReviewer.js';
import skillStore from '../services/skillStore.js';
import skillCapture from '../services/skillCapture.js';
import lessonLearner from '../services/lessonLearner.js';
import sandbox from '../services/sandbox.js';
import { execSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import moltbookService from '../services/moltbook.js';
import moltbookScheduler from '../services/moltbookScheduler.js';
import respondRoutes from './respond.js';
import trainRoutes from './train.js';
import avaPaths from '../utils/paths.js';

const recentTurnKeys = new Map();
const DUPLICATE_TURN_MS = Math.max(500, parseInt(process.env.AVA_DUPLICATE_TURN_MS || '3000', 10));

function normalizeTurnText(text = '') {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function turnTokenSimilarity(a = '', b = '') {
  const aTokens = new Set(normalizeTurnText(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeTurnText(b).split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function markDuplicateTurn(endpoint, sessionId, text) {
  const normalized = normalizeTurnText(text);
  if (!normalized) return false;
  const now = Date.now();
  for (const [key, entry] of recentTurnKeys.entries()) {
    const seenAt = typeof entry === 'number' ? entry : entry?.seenAt || 0;
    if (now - seenAt > DUPLICATE_TURN_MS * 3) recentTurnKeys.delete(key);
  }
  const scope = `${endpoint}|${sessionId || ''}`;
  for (const [key, entry] of recentTurnKeys.entries()) {
    const seenAt = typeof entry === 'number' ? entry : entry?.seenAt || 0;
    if (!key.startsWith(`${scope}|`) || now - seenAt > DUPLICATE_TURN_MS) continue;
    const previous = typeof entry === 'object' ? entry.normalized || '' : '';
    const similarLength = Math.abs(previous.length - normalized.length) <= Math.max(6, Math.ceil(normalized.length * 0.2));
    if (previous === normalized || (similarLength && turnTokenSimilarity(previous, normalized) >= 0.82)) {
      recentTurnKeys.set(key, { seenAt: now, normalized });
      return true;
    }
  }
  const key = `${scope}|${crypto.createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 20)}`;
  recentTurnKeys.set(key, { seenAt: now, normalized });
  return false;
}

// LLM composition helpers
async function composeLLM({ system, user }, fallbackText){
  try {
    const response = await llmService.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.7, max_tokens: 900, localPriority: 'interactive' });
    return response?.content || response?.text || fallbackText;
  } catch { return fallbackText }
}

function redactForLLM(obj){
  try {
    const seen = new WeakSet();
    const walk = (v) => {
      if (v && typeof v === 'object'){
        if (seen.has(v)) return null;
        seen.add(v);
        if (Array.isArray(v)) return v.map(walk);
        const out = {};
        for (const [k,val] of Object.entries(v)){
          if (k === 'content' && typeof val === 'string'){
            out[k] = val.length > 200 ? val.slice(0,200) + '…' : val;
          } else {
            out[k] = walk(val);
          }
        }
        return out;
      }
      return v;
    };
    return walk(obj);
  } catch { return obj }
}

async function composeFromPlanAndResult({ userMsg, planned, result, isPreview }){
  const ALLOW_WRITE = process.env.ALLOW_WRITE === '1';
  const fallback = (()=>{
    const tools = planned?.length ? Array.from(new Set(planned.map(p=>p.tool))).join(', ') : '';
    if (!planned?.length) return 'Done.';
    if (isPreview){
      return ALLOW_WRITE
        ? `I can handle that using ${tools}. This was a preview. Say "run it" to execute.`
        : `I can handle that using ${tools}. Preview only — writes are disabled by server policy.`;
    }
    return `Completed using ${tools}.`;
  })();
  const sys = [
    'You are AVA, a friendly, concise assistant.',
    'Summarize the outcome naturally.',
    'Do not include raw JSON, code blocks, or shell commands.',
    'If this was a preview, say it has not been executed and suggest how to proceed (e.g., "run it").',
    'If access was denied (e.g., whitelist), explain briefly and suggest a safe remedy.'
  ].join(' ');
  const data = { request: userMsg, planned: redactForLLM(planned||[]), result: redactForLLM(result||[]) };
  const user = `User request:\n${userMsg}\n\nPlanned steps (JSON):\n${JSON.stringify(data.planned)}\n\nResults (JSON):\n${JSON.stringify(data.result)}`;
  return await composeLLM({ system: sys, user }, fallback);
}

const router = express.Router();

// Split-out route modules (Tier 2): the voice /respond turn handler, the typed /chat
// endpoint, and the /train/* trainer endpoints. Paths are unchanged.
router.use(respondRoutes);
router.use(trainRoutes);

// Resolve user directories safely
function userPath(which){
  const base = os.homedir();
  if (!base) return avaPaths.repoRoot();
  if (which === 'downloads') return path.join(base, 'Downloads');
  if (which === 'documents') return path.join(base, 'Documents');
  return base;
}

// Deterministic document creation (supports txt/md/csv/json/html/pdf/docx/xlsx/pptx/rtf)
router.post('/tools/file_gen', async (req, res) => {
  try {
    if (!config.ALLOW_WRITE) return res.status(403).json({ ok:false, error:'writes_disabled', next:['Set ALLOW_WRITE=1 to enable file creation'] });

    const fmt = String(req.body?.format||'txt').toLowerCase();
    const content = String(req.body?.content||'');
    const filename = String(req.body?.filename||'');
    const dirKey = (req.body?.dir==='documents'?'documents':'downloads');
    const dir = userPath(dirKey);
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const ext = (['txt','md','csv','json','html','pdf','docx','xlsx','pptx','rtf'].includes(fmt) ? fmt : 'txt');
    const ts = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14)
    const name = filename || `ava_${ts}.${ext}`;
    const full = path.join(dir, name);

    // Helpers
    const writeSimple = ()=>{ fs.writeFileSync(full, content, { encoding:'utf8' }); return fs.existsSync(full) };

    function writeSimplePdf(){
      const lines = String(content||'').split(/\r?\n/);
      const header = Buffer.from('%PDF-1.4\n','utf8');
      const objs = [];
      const addObj = (s)=>objs.push(Buffer.from(s,'utf8'));
      addObj('1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n');
      addObj('2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n');
      addObj('3 0 obj\n<</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /MediaBox [0 0 612 792] /Contents 5 0 R>>\nendobj\n');
      addObj('4 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n');
      let contentStream = 'BT\n/F1 12 Tf\n14 TL\n72 720 Td\n';
      for (let i=0;i<lines.length;i++){
        const line = lines[i].replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
        if (i>0) contentStream += '0 -14 Td\n';
        contentStream += `(${line}) Tj\n`;
      }
      contentStream += 'ET\n';
      const cs = Buffer.from(contentStream,'utf8');
      const stream = Buffer.concat([
        Buffer.from('5 0 obj\n<</Length '+cs.length+ '>>\nstream\n','utf8'),
        cs,
        Buffer.from('\nendstream\nendobj\n','utf8')
      ]);
      const body = Buffer.concat([...objs, stream]);
      const offsets = [];
      let pos = header.length;
      for (const b of [...objs, stream]){ offsets.push(pos); pos += b.length; }
      const xrefStart = pos;
      let xref = 'xref\n0 6\n0000000000 65535 f \n';
      for (const off of offsets){ xref += (String(off).padStart(10,'0') + ' 00000 n \n') }
      const trailer = 'trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n'+xrefStart+'\n%%EOF';
      const pdf = Buffer.concat([header, body, Buffer.from(xref,'utf8'), Buffer.from(trailer,'utf8')]);
      fs.writeFileSync(full, pdf);
      return fs.existsSync(full);
    }

    async function tryOffice(){
      // Use PowerShell COM automation if Office apps are installed
      const safe = content.replace(/`/g,'``').replace(/\"/g,'`"');
      if (fmt==='docx' || fmt==='rtf' || fmt==='pdf'){
        const ps = `
          $ErrorActionPreference='Stop';
          $out = "${full.replace(/\\/g,'/')}";
          $txt = "${safe}";
          $word = New-Object -ComObject Word.Application;
          $doc = $word.Documents.Add();
          $sel = $word.Selection; $sel.TypeText($txt);
          $fmt = 0; if ($out -like '*.rtf'){ $fmt=6 } elseif ($out -like '*.pdf'){ $fmt=17 } else { $fmt=12 }
          $doc.SaveAs([ref]$out, [ref]$fmt);
          $doc.Close(); $word.Quit();
        `;
        try { execSync(`powershell.exe -NoProfile -Command "${ps}"`, { stdio:'ignore', timeout: 20000 }); return fs.existsSync(full) } catch { return false }
      }
      if (fmt==='xlsx'){
        const ps = `
          $ErrorActionPreference='Stop';
          $out = "${full.replace(/\\/g,'/')}";
          $excel = New-Object -ComObject Excel.Application;
          $wb = $excel.Workbooks.Add();
          $sheet = $wb.Worksheets.Item(1);
          $sheet.Cells.Item(1,1).Value2 = "${safe}";
          $wb.SaveAs($out);
          $wb.Close($false); $excel.Quit();
        `;
        try { execSync(`powershell.exe -NoProfile -Command "${ps}"`, { stdio:'ignore', timeout: 20000 }); return fs.existsSync(full) } catch { return false }
      }
      if (fmt==='pptx'){
        const ps = `
          $ErrorActionPreference='Stop';
          $out = "${full.replace(/\\/g,'/')}";
          $ppt = New-Object -ComObject PowerPoint.Application;
          $pres = $ppt.Presentations.Add();
          $slide = $pres.Slides.Add(1,1);
          $shape = $slide.Shapes.AddTextbox(1,50,50,600,100);
          $shape.TextFrame.TextRange.Text = "${safe}";
          $pres.SaveAs($out);
          $pres.Close(); $ppt.Quit();
        `;
        try { execSync(`powershell.exe -NoProfile -Command "${ps}` + '"', { stdio:'ignore', timeout: 20000 }); return fs.existsSync(full) } catch { return false }
      }
      return false;
    }

    function tryEdge(){
      try {
        const edgePaths = [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
        ];
        const edge = edgePaths.find(p=>{ try { return fs.existsSync(p) } catch { return false } });
        if (edge){
          const tmpHtml = path.join(dir, 'ava_tmp_'+Math.random().toString(36).slice(2,8)+'.html');
          const html = `<html><meta charset="utf-8"><body><pre style="font-family:Segoe UI,Arial,Helvetica,sans-serif;white-space:pre-wrap">${content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body></html>`;
          fs.writeFileSync(tmpHtml, html, { encoding:'utf8' });
          const url = 'file:///' + tmpHtml.replace(/\\/g,'/');
          execSync(`"${edge}" --headless=new --disable-gpu --print-to-pdf="${full}" "${url}"`, { stdio:'ignore', timeout: 20000 });
          try { fs.unlinkSync(tmpHtml) } catch {}
          return fs.existsSync(full);
        }
      } catch { /* ignore */ }
      return false;
    }

    let ok = false;
    if (['txt','md','csv','json','html'].includes(ext)) ok = writeSimple();
    else if (ext==='pdf') ok = (await tryOffice()) || writeSimplePdf();
    else if (['docx','xlsx','pptx','rtf'].includes(ext)) ok = await tryOffice();
    else ok = writeSimple();

    if (!ok){
      logger.warn('file_gen failed', { format: ext, dir, path: full })
      return res.status(400).json({ ok:false, error:'filegen_failed', path: full, next:['Ensure Office installed for rich formats','Enable Edge for headless PDF','Fallback to txt/md'] });
    }

    logger.info('file_gen created', { format: ext, dir, path: full })
    return res.json({ ok:true, path: full });
  } catch (error) {
    logger.error('file_gen failed', { error: error.message });
    return res.status(500).json({ ok:false, error: error.message });
  }
});

// -------- Memory reviewer (on-demand "dreaming" pass) --------
router.post('/memory/review', async (req, res) => {
  try {
    const r = await memoryReviewer.reviewAndUpdate(req.body || {});
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Sandbox (virtual-device training environment) --------
router.get('/sandbox/status', async (_req, res) => {
  try {
    let tools = [];
    try { tools = await toolsService.getAllTools(); } catch { /* optional */ }
    const coverage = tools.map((t) => ({ name: t.name, policy: sandbox.policyFor(t.name) }));
    return res.json({
      ok: true,
      enabled: sandbox.isEnabled(),
      root: sandbox.sandboxRoot(),
      device: sandbox.deviceRoot(),
      tool_count: tools.length,
      coverage,
      ledger_count: sandbox.readLedger(100000).length,
    });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/sandbox/setup', (_req, res) => {
  try { return res.json({ ok: true, ...sandbox.setup() }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/sandbox/reset', (_req, res) => {
  try { return res.json({ ok: true, ...sandbox.reset() }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/sandbox/ledger', (req, res) => {
  try { return res.json({ ok: true, actions: sandbox.readLedger(parseInt(req.query.limit || '200', 10)) }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// -------- Lesson from error (detect -> reason -> remember) --------
router.post('/memory/lesson', async (req, res) => {
  try { const r = await lessonLearner.lessonFromError(req.body || {}); return res.json({ ok: true, ...r }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// -------- Skills (reusable how-tos AVA captures) --------
router.get('/skills', (_req, res) => {
  try { return res.json({ ok: true, skills: skillStore.listSkills() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/skills/review', async (req, res) => {
  try { const r = await skillCapture.reviewAndCapture(req.body || {}); return res.json({ ok: true, ...r }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// -------- Self Status (dynamic identity + capabilities) --------
function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')) } catch { return null } }
function readTextSafe(p){ try { return fs.readFileSync(p,'utf8') } catch { return '' } }
function listToolsSafe(dir){
  try {
    const files = fs.readdirSync(dir);
    return files.filter(f=>f.endsWith('.py')).map(f=>f.replace(/\.py$/,''));
  } catch { return [] }
}

function buildSelfStatus(){
  const home = os.homedir();
  const integ = config.AVA_INTEGRATION_DIR || path.join(home, 'ava-integration');
  const cmpUseTools = path.join(home, 'cmp-use', 'cmpuse', 'tools');
  const identity = readJsonSafe(path.join(integ, 'ava_identity.json')) || {};
  const vcfg = readJsonSafe(path.join(integ, 'ava_voice_config.json')) || {};
  const versionNote = readTextSafe(path.join(integ, 'AVA_VERSION_NOTE.txt'));
  const tools = listToolsSafe(cmpUseTools);
  const uptimeSec = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  return {
    identity,
    voice_config: vcfg,
    version_note_present: !!versionNote,
    tools,
    server: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      uptime_sec: uptimeSec,
      port: config.PORT
    }
  };
}

router.get('/self/status', (_req,res)=>{
  try {
    const status = buildSelfStatus();
    res.json({ ok:true, status });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

function buildSelfResponseText(status){
  try{
    const id = status.identity||{};
    const vc = status.voice_config||{};
    const tools = status.tools||[];
    const parts = [];
    parts.push(`I am ${id.name||'AVA'}, your local assistant developed by ${id.developer||'you'}.`);
    if (id.purpose) parts.push(`Purpose: ${id.purpose}`);
    parts.push(`I run on ${status.server.platform} with Node ${status.server.node}, server PID ${status.server.pid}, port ${status.server.port}.`);
    if (id.location) parts.push(`My files live in ${id.location}.`);
    const barge = (vc.barge||{}); const allowBarge = vc.allow_barge===true;
    parts.push(`Voice: Deepgram Agent with local TTS; barge-in ${allowBarge?'enabled':'disabled'} (min ${barge.min_tts_ms||'default'}ms, debounce ${barge.debounce_frames||'default'}).`);
    parts.push(`Capabilities include tools like: ${tools.slice(0,10).join(', ')}${tools.length>10?' …':''}.`);
    return parts.join(' ');
  }catch{ return 'I am your local assistant with dynamic awareness of my identity and tools.' }
}

// Summarized dynamic self-description
router.get('/self/summary', (_req,res)=>{
  try {
    const status = buildSelfStatus();
    const text = buildSelfResponseText(status);
    res.json({ ok:true, text, status });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Safe file download for created documents (Documents/Downloads only)
router.get('/files/download', (req, res) => {
  try {
    let p = String(req.query?.p || '')
    if (!p) return res.status(400).json({ ok:false, error:'missing_path' })
    // sanitize quotes and whitespace
    p = p.trim().replace(/^"+|"+$/g, '')
    // Normalize slashes
    const normalized = p.replace(/\//g, path.sep)
    let resolved = path.resolve(normalized)
    const docs = path.resolve(userPath('documents'))
    const dls = path.resolve(userPath('downloads'))
    const allowed = resolved.startsWith(docs + path.sep) || resolved.startsWith(dls + path.sep)
      || resolved === docs || resolved === dls
    if (!allowed) return res.status(403).json({ ok:false, error:'forbidden_path' })
    if (!fs.existsSync(resolved)){
      // Try a second resolution attempt with direct path (in case of odd escaping)
      try { resolved = path.resolve(p); } catch {}
      if (!fs.existsSync(resolved)) return res.status(404).json({ ok:false, error:'not_found', path: resolved })
    }
    return res.download(resolved)
  } catch (error) {
    return res.status(500).json({ ok:false, error: String(error?.message||error) })
  }
})

// Open a file / folder / URL on the machine in its default app — the "click a card to access it"
// action for the Stage popup panels (a file path can't be opened by a browser link, so the UI
// posts here and the server opens it locally via open_item). Deliberate user action, so it just
// opens what was asked. URLs open in the real browser; files/folders in their default handler.
router.post('/files/open', async (req, res) => {
  try {
    const target = String(req.body?.target || req.body?.path || req.body?.url || '').trim();
    if (!target) return res.status(400).json({ ok: false, error: 'missing target' });
    const r = await toolsService.executeTool('open_item', { target, confirm: true, confirmed: true },
      false, { source: 'ui-panel', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const ok = !(r && r.ok === false) && String(inner.status || 'ok').toLowerCase() !== 'error';
    res.json({ ok, target, result: inner });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Tier 1 #6/#8: deleted handleIntelligentFileSearch — a regex file-search path with
// hardcoded "C:\Users\USER 1\" directories from another machine; file requests now go
// through the agent loop (fs_find/fs_read/open_item chosen natively by the model).

// Health check
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    build: config.BUILD_STAMP,
    allowWrite: config.ALLOW_WRITE
  });
});

// Session info
router.get('/session', (_req, res) => {
  res.json({
    ok: true,
    model: config.REALTIME_MODEL,
    build: config.BUILD_STAMP
  });
});

// Debug endpoint
router.get('/debug', async (_req, res) => {
  try {
    const memoryStats = memoryService.getStats();
    const sessionStats = llmService.getSessionStats();

    res.json({
      ok: true,
      allowWrite: config.ALLOW_WRITE,
      config: {
        embedProvider: config.EMBED_PROVIDER,
        embedModel: config.EMBED_MODEL,
        logLevel: config.LOG_LEVEL
      },
      memory: memoryStats,
      sessions: sessionStats,
      build: config.BUILD_STAMP
    });
  } catch (error) {
    logger.error('Debug endpoint error', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Memory endpoints
router.get('/memory/health', (_req, res) => {
  const stats = memoryService.getStats();
  res.json({ ok: true, ...stats });
});

router.post('/memory/upsert', async (req, res) => {
  try {
    const record = await memoryService.upsert(req.body);
    res.json({ ok: true, record });
  } catch (error) {
    logger.error('Memory upsert failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Visual artifact panel feed (#225): the UI popup panel polls this for anything AVA wants to SHOW
// (diagrams, tables, web-result summaries, images, notes, the menu). Pass ?since=<ms> to get only new.
router.get('/artifacts/recent', (req, res) => {
  try {
    const s = req.query.since;
    res.json({ ok: true, now: Date.now(), artifacts: s ? artifactBus.since(s) : artifactBus.recent(20) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/artifacts/push', (req, res) => {
  try { res.json({ ok: true, artifact: artifactBus.push(req.body || {}) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Multi-card visual panel (presenter). The UI polls /panel/state and mirrors it exactly; AVA drives
// it (open a card, bring one to the front, close it) via the panel tool or these endpoints.
router.get('/panel/state', (_req, res) => {
  try { res.json({ ok: true, ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/open', (req, res) => {
  try { res.json({ ok: true, card: artifactBus.open(req.body || {}), ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/focus', (req, res) => {
  try { res.json({ ok: artifactBus.focus((req.body || {}).id), ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/close', (req, res) => {
  try { res.json({ ok: artifactBus.close((req.body || {}).id), ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/clear', (_req, res) => {
  try { artifactBus.clear(); res.json({ ok: true, ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/layout', (req, res) => {
  try { res.json({ ok: true, layout: artifactBus.setLayout((req.body || {}).mode), ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panel/move', (req, res) => {
  try { const b = req.body || {}; res.json({ ok: artifactBus.move(b.id, b.x, b.y), ...artifactBus.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/memory/search', async (req, res) => {
  try {
    const { query, k = 5 } = req.body;
    const results = await memoryService.search(query, k);
    res.json({ ok: true, results });
  } catch (error) {
    logger.error('Memory search failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/persona', (_req, res) => {
  try {
    const persona = memoryService.generatePersona();
    res.json({ ok: true, persona });
  } catch (error) {
    logger.error('Persona generation failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Compatibility alias backed by the canonical runtime tool registry.
router.get('/ava/tools', async (_req, res) => {
  try {
    const tools = await toolsService.getAllTools();
    res.json({ ok: true, tools });
  } catch (error) {
    logger.error('Tools fetch failed', { error: error.message });
    res.status(503).json({ ok: false, error: error.message });
  }
});

// Conversation log endpoints
router.get('/logs/conversation/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const summary = conversationLogger.getSessionSummary();

    if (!summary || summary.sessionId !== sessionId) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    res.json({ ok: true, session: summary });
  } catch (error) {
    logger.error('Session lookup failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/logs/conversation/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = conversationLogger.getRecentHistory(limit);

    res.json({
      ok: true,
      messages: history,
      count: history.length
    });
  } catch (error) {
    logger.error('Recent history fetch failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/logs/conversation/search', (req, res) => {
  try {
    const { q: query, days = 7 } = req.query;

    if (!query) {
      return res.status(400).json({ ok: false, error: 'Query parameter required' });
    }

    const results = conversationLogger.searchConversations(query, parseInt(days));

    res.json({
      ok: true,
      results,
      query,
      days: parseInt(days),
      count: results.length
    });
  } catch (error) {
    logger.error('Conversation search failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/logs/conversation/session/start', (req, res) => {
  try {
    const sessionId = conversationLogger.startSession(req.body.sessionId);

    res.json({
      ok: true,
      sessionId,
      message: 'Session started successfully'
    });
  } catch (error) {
    logger.error('Session start failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/logs/conversation/session/end', (req, res) => {
  try {
    conversationLogger.endSession();

    res.json({
      ok: true,
      message: 'Session ended successfully'
    });
  } catch (error) {
    logger.error('Session end failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});


// POST /moltbook/learn - Manually trigger Moltbook learning
router.post('/moltbook/learn', async (req, res) => {
  try {
    logger.info('Manual Moltbook learning triggered');
    const result = await moltbookScheduler.triggerMoltbookLearning();
    res.json({
      ok: true,
      ran: result.ran,
      reason: result.reason,
      storedCount: result.storedCount || 0,
      filteredCount: result.filteredCount || 0,
      outcome: result.outcome
    });
  } catch (error) {
    logger.error('Moltbook learning failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /moltbook/status - Get Moltbook status and learnings
router.get('/moltbook/status', async (req, res) => {
  try {
    const status = await moltbookService.getStatus();
    const learnings = moltbookService.getLearningsSummary();
    const activity = moltbookScheduler.getStats();
    res.json({ ok: true, ...status, learnings, activity });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /moltbook/issue - Track an issue for Moltbook help
router.post('/moltbook/issue', async (req, res) => {
  try {
    const { category, description, context } = req.body;
    if (!description) {
      return res.status(400).json({ ok: false, error: 'Description required' });
    }
    moltbookScheduler.trackIssue(category || 'general', description, context || {});
    res.json({ ok: true, message: 'Issue tracked for Moltbook help' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /moltbook/post - Post directly to Moltbook
router.post('/moltbook/post', async (req, res) => {
  try {
    const { submolt, title, content } = req.body;
    if (!submolt || !title || !content) {
      return res.status(400).json({ ok: false, error: 'submolt, title, and content required' });
    }
    const result = await moltbookScheduler.triggerMoltbookPost(submolt, title, content);
    res.json({ ok: result.success, postId: result.post?.id, error: result.error });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /moltbook/stats - Get Moltbook activity stats
router.get('/moltbook/stats', (req, res) => {
  try {
    const stats = moltbookScheduler.getStats();
    res.json({ ok: true, ...stats });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Shared with routes/respond.js: the duplicate-turn
// state lives ONLY in this module, and buildSelfStatus also backs /self/status + /self/summary.
export { markDuplicateTurn, buildSelfStatus };

export default router;
