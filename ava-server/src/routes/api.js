// Main API routes
import express from 'express';
import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from '../services/memory.js';
import llmService from '../services/llm.js';
import conversationLogger from '../services/conversationLogger.js';
import { execSync } from 'child_process';
import os from 'os';
import agentLoop from '../services/agentLoop.js';
import moltbookService from '../services/moltbook.js';
import moltbookScheduler from '../services/moltbookScheduler.js';

// LLM composition helpers
async function composeLLM({ system, user }, fallbackText){
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return fallbackText;
    const model = process.env.CHAT_MODEL || 'gpt-4o-mini';
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [ { role:'system', content: system }, { role:'user', content: user } ], temperature: 0.7 })
    });
    if (!r.ok) return fallbackText;
    const j = await r.json().catch(()=>null);
    return (j?.choices?.[0]?.message?.content || fallbackText);
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

/**
 * Detect if response is a step execution status message (not natural language)
 */
function isStepStatusMessage(text) {
  if (!text || typeof text !== 'string') return false;
  
  const textClean = text.trim().toLowerCase();
  
  // Exact match blacklists
  const exactBlacklist = ['done', 'ready', 'ok', 'okay', 'success', 'complete', 'completed', 'finished'];
  if (exactBlacklist.includes(textClean)) return true;
  
  // Very short responses
  if (textClean.length <= 3) return true;
  
  // Pattern matching
  const stepPatterns = [
    /reached step \d+ of \d+/i,
    /currently running without any further actions/i,
    /executing step \d+/i,
    /plan step \d+/i,
    /completed \d+ of \d+ steps/i,
    /no further actions? to execute/i,
    /step \d+ complete/i,
    /task (complete|completed|finished|done)/i,
    /operation (complete|completed|finished|done)/i,
    /action (complete|completed|finished|done)/i,
    /i will execute/i,
    /i am (executing|running|processing)/i,
    /tool (executed|called|invoked)/i,
    /function (executed|called|invoked)/i,
    /automation (complete|completed|finished)/i,
    /working on step \d+/i,
    /step \d+ (done|finished|complete)/i,
    // Additional patterns for step status messages
    /current step \d+/i,
    /step \d+ of \d+/i,
    /completed successfully/i,
    /successfully completed/i,
    /execution complete/i,
    /process(ing)? complete/i,
    /running step/i,
    /proceeding to step/i,
    /moving to step/i,
  ];
  
  return stepPatterns.some(pattern => pattern.test(text));
}

/**
 * Get natural language response for voice mode
 */
function getNaturalResponse(originalQuery, badResponse) {
  const low = (originalQuery || '').toLowerCase();
  
  if (['hi', 'hello', 'hey'].some(x => low.includes(x))) {
    return "Hey there! How can I help you today?";
  }
  if (['huh', 'what', 'pardon', 'repeat'].some(x => low.includes(x))) {
    return "I'm not sure I understood. Could you say that again?";
  }
  if (low.includes('name')) {
    return "I'm AVA, your autonomous virtual assistant.";
  }
  if (['mouse', 'cursor', 'click'].some(x => low.includes(x))) {
    return "I can help control your mouse. Where would you like me to move it?";
  }
  if (['type', 'write', 'enter'].some(x => low.includes(x))) {
    return "I can type text for you. What should I enter?";
  }
  if (['screenshot', 'screen shot', 'capture'].some(x => low.includes(x))) {
    return "I'll capture a screenshot for you.";
  }
  if (['system', 'computer', 'info', 'specs'].some(x => low.includes(x))) {
    return "Let me check your system information.";
  }
  
  // Generic fallback
  const fallbacks = [
    "I'm here to help. What would you like me to do?",
    "What can I assist you with?",
    "I'm ready to help. What's next?",
    "How can I help you today?",
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

const router = express.Router();

// Realtime compatibility: route text/messages to Agent Loop with memory/tools
router.post('/respond', async (req, res) => {
  try {
    const { text, messages, sessionId = 'voice-default', freshSession = false } = req.body || {};
    const userText = (typeof text === 'string' && text.trim())
      ? text.trim()
      : Array.isArray(messages) && messages.length > 0
        ? String(messages[messages.length - 1]?.content || messages[messages.length - 1]?.text || '').trim()
        : '';

    if (!userText) {
      return res.status(400).json({ ok: false, error: 'Missing text/messages' });
    }

    try { conversationLogger.logUserMessage(userText, { sessionId, endpoint: '/respond', freshSession }); } catch {}

    const state = await (await import('../services/agentLoop.js')).default.runAgentLoop(userText, {});
    let finalText = state.final_result || 'Done.';
    
    // VOICE FILTER: Convert step status messages to natural responses
    if (isStepStatusMessage(finalText)) {
      console.log(`[respond] Filtering step status: ${finalText.slice(0, 50)}...`);
      finalText = getNaturalResponse(userText, finalText);
    }
    
    try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'agent' }); } catch {}

    res.json({ ok: true, output_text: String(finalText || '').slice(0, 4000), agent: {
      id: state.id,
      status: state.status,
      steps: state.step_count,
      result: state.final_result,
      errors: state.errors
    }});
  } catch (error) {
    logger.error('Respond failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Bridge configuration ---
const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3333;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.AVA_BRIDGE_TOKEN || 'local-dev-token';

// --- Call bridge /tool endpoint ---
async function callBridgeTool(tool, args) {
  try {
    const url = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/tool`;
    console.log(`[bridge-call] Calling ${url} with tool=${tool}, args=`, args);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_TOKEN}`
      },
      body: JSON.stringify({ tool, args })
    });
    console.log(`[bridge-call] Response status: ${r.status}`);
    if (r.ok) {
      const json = await r.json();
      console.log(`[bridge-call] Response:`, json);
      return json;
    }
    console.log(`[bridge-call] Error: Bridge returned ${r.status}`);
    return { ok: false, error: `Bridge returned ${r.status}` };
  } catch (e) {
    console.log(`[bridge-call] Exception:`, e.message);
    return { ok: false, error: e.message };
  }
}

// Track vision monitoring state
let visionMonitoringActive = false;

// --- Simple intent → tool dispatcher (inline) ---
async function tryHandleSimpleTools(userText){
  try {
    const text = String(userText||'');
    const lower = text.toLowerCase();

    // Camera CLOSE/STOP intent: "close camera", "turn off camera", "stop watching"
    if (/\bcamera\b/.test(lower) && /\b(close|off|deactivate|stop|disable|shut)\b/.test(lower)) {
      console.log(`[vision] Stopping vision monitoring`);
      const result = await callBridgeTool('camera_ops', { action: 'stop_monitoring' });
      visionMonitoringActive = false;
      if (result.ok && result.status === 'ok') {
        return { text: 'Camera closed. I stopped watching.', tool: 'camera_ops' };
      }
      // Try regular close as fallback
      await callBridgeTool('camera_ops', { action: 'close' });
      return { text: 'Camera closed.', tool: 'camera_ops' };
    }

    // Vision memory/learning recall: "what have you learned", "what have you seen", "observations"
    if (/\b(what have you (learned|seen|observed)|what did you (learn|see|observe)|your observations|learned from (watching|seeing|the camera)|seen (so far|already|through))\b/.test(lower)) {
      console.log(`[vision] User asking about learned observations`);
      const obsResult = await callBridgeTool('camera_ops', { action: 'get_observations', count: 20 });

      if (obsResult.ok && obsResult.status === 'ok') {
        const summary = obsResult.data?.summary || obsResult.summary || '';
        const observations = obsResult.data?.observations || obsResult.observations || [];

        if (observations.length > 0 || summary) {
          // Build a response from observations
          let response = summary || '';

          // Add recent AI observations if available
          const aiObs = observations.filter(o => o.type === 'ai_analysis');
          if (aiObs.length > 0) {
            const recentDescriptions = aiObs.slice(-3).map(o => o.description).filter(Boolean);
            if (recentDescriptions.length > 0) {
              response += ' Recent observations: ' + recentDescriptions.join(' ');
            }
          }

          if (response.trim()) {
            return { text: response.trim(), tool: 'camera_ops' };
          }
        }
        return { text: "I've been watching but haven't recorded any notable observations yet. Keep the camera active and ask me what I see to build up my memory.", tool: 'camera_ops' };
      }
      return { text: "I don't have any stored observations right now. Activate the camera and ask me what I see to start building my visual memory.", tool: 'camera_ops' };
    }

    // Vision analysis intent: "what do you see", "describe what you see", "tell me what you see"
    if (/\b(what do you see|what can you see|describe what|tell me what you see|explain what you see|what are you seeing|what's happening)\b/.test(lower)) {
      console.log(`[vision] User asking what I see, monitoring active: ${visionMonitoringActive}`);

      // Get current frame from monitor (if active) or capture one
      let framePath = null;

      if (visionMonitoringActive) {
        // Get current frame from continuous monitor
        const frameResult = await callBridgeTool('camera_ops', { action: 'get_current_frame' });
        if (frameResult.ok && frameResult.status === 'ok') {
          framePath = frameResult.data?.frame_path || frameResult.frame_path;
          console.log(`[vision] Got current frame from monitor: ${framePath}`);
        }
      }

      // If no frame from monitor, capture one
      if (!framePath) {
        const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
        const savePath = path.join(tempDir, `ava_capture_${Date.now()}.png`);
        const captureResult = await callBridgeTool('camera_ops', { action: 'capture', save_path: savePath });
        if (captureResult.ok && captureResult.status === 'ok') {
          framePath = captureResult.data?.file_path || savePath;
        }
      }

      if (framePath) {
        console.log(`[vision] Analyzing frame: ${framePath}`);
        const visionResult = await callBridgeTool('vision_ops', {
          action: 'describe_image',
          image_path: framePath,
          question: 'Describe what you see in this image in detail. Include people, objects, actions, and any notable details.'
        });

        if (visionResult.ok && visionResult.status === 'ok') {
          const desc = visionResult.data?.description || visionResult.data?.analysis || visionResult.message || '';

          // Store this observation in the monitor
          if (visionMonitoringActive) {
            await callBridgeTool('camera_ops', { action: 'add_observation', description: desc });
          }

          return { text: desc, tool: 'vision_ops' };
        }
        return { text: `I'm having trouble analyzing what I see: ${visionResult.message || 'unknown error'}`, tool: 'vision_ops' };
      }

      return { text: 'I need to activate my camera first. Say "activate the camera" so I can see.', tool: 'none' };
    }

    // Camera ACTIVATE intent: "activate camera", "turn on camera", "start watching"
    if (/\bcamera\b/.test(lower) && /\b(activate|turn on|enable|start|open)\b/.test(lower) && !/\b(close|off|deactivate|stop|disable|shut)\b/.test(lower)) {
      console.log(`[vision] Starting continuous vision monitoring`);

      const result = await callBridgeTool('camera_ops', { action: 'start_monitoring', camera_index: 0 });

      if (result.ok && result.status === 'ok') {
        visionMonitoringActive = true;
        return { text: 'Camera activated. I can see now. Ask me what I see whenever you want.', tool: 'camera_ops' };
      }
      return { text: 'I tried to activate the camera but something went wrong: ' + (result.message || result.error || 'unknown error'), tool: 'camera_ops' };
    }

    // Take a picture (explicit capture without analysis)
    if (/\b(take|capture|snap)\b/.test(lower) && /\b(picture|photo|image|shot)\b/.test(lower)) {
      const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
      const savePath = path.join(tempDir, `ava_capture_${Date.now()}.png`);
      console.log(`[camera] Taking picture: ${savePath}`);

      const result = await callBridgeTool('camera_ops', { action: 'capture', save_path: savePath });
      if (result.ok && result.status === 'ok') {
        return { text: `Photo taken and saved. (${result.data?.dimensions || ''})`, tool: 'camera_ops' };
      }
      return { text: 'I tried to take a photo but something went wrong: ' + (result.message || result.error || 'unknown error'), tool: 'camera_ops' };
    }

    // Screenshot intent
    if (/\b(screenshot|screen shot|capture screen|grab screen)\b/.test(lower)) {
      const savePath = path.join(os.homedir(), 'Desktop', `ava_screenshot_${Date.now()}.png`);
      const result = await callBridgeTool('screen_ops', { action: 'screenshot', output_path: savePath });
      if (result.ok && result.status === 'ok') {
        return { text: `Screenshot saved to ${savePath}.`, tool: 'screen_ops' };
      }
      return { text: 'I tried to take a screenshot but something went wrong.' };
    }

    // Volume control
    if (/\b(volume|sound)\b/.test(lower)) {
      if (/\b(up|increase|louder|raise)\b/.test(lower)) {
        const result = await callBridgeTool('audio_ops', { action: 'increase', amount: 10 });
        return { text: result.ok ? 'Volume increased.' : 'Failed to change volume.', tool: 'audio_ops' };
      }
      if (/\b(down|decrease|quieter|lower)\b/.test(lower)) {
        const result = await callBridgeTool('audio_ops', { action: 'decrease', amount: 10 });
        return { text: result.ok ? 'Volume decreased.' : 'Failed to change volume.', tool: 'audio_ops' };
      }
      if (/\b(mute)\b/.test(lower)) {
        const result = await callBridgeTool('audio_ops', { action: 'mute' });
        return { text: result.ok ? 'Muted.' : 'Failed to mute.', tool: 'audio_ops' };
      }
      if (/\b(unmute)\b/.test(lower)) {
        const result = await callBridgeTool('audio_ops', { action: 'unmute' });
        return { text: result.ok ? 'Unmuted.' : 'Failed to unmute.', tool: 'audio_ops' };
      }
    }

    // Window operations
    if (/\b(list|show)\s+(windows?|apps?)\b/.test(lower)) {
      const result = await callBridgeTool('window_ops', { action: 'list' });
      if (result.ok && result.data?.windows) {
        const wins = result.data.windows.slice(0, 5).map(w => w.title || w.name).join(', ');
        return { text: `Open windows: ${wins}`, tool: 'window_ops' };
      }
      return { text: 'Could not list windows.' };
    }

    // Focus window
    if (/\b(focus|switch to|open)\b/.test(lower) && /\b(window|app)\b/.test(lower)) {
      const appMatch = text.match(/(?:focus|switch to|open)\s+(?:the\s+)?(\w+)/i);
      const app = appMatch?.[1] || '';
      if (app) {
        const result = await callBridgeTool('window_ops', { action: 'focus', window_title: app });
        return { text: result.ok ? `Focused ${app}.` : `Could not focus ${app}.`, tool: 'window_ops' };
      }
    }

    // Smart home / lights
    if (/\b(turn|switch)\s+(on|off)\b/.test(lower) && /\b(light|lights|lamp)\b/.test(lower)) {
      const action = /\bon\b/.test(lower) ? 'turn_on' : 'turn_off';
      const roomMatch = text.match(/\bin\s+(?:the\s+)?(\w+)/i);
      const room = roomMatch?.[1] || '';
      const result = await callBridgeTool('iot_ops', { action, room });
      return { text: result.ok ? `Lights ${action.replace('_', ' ')}.` : 'Could not control lights.', tool: 'iot_ops' };
    }

    // System info
    if (/\b(system|computer|device)\s*(info|status|information)\b/.test(lower)) {
      const result = await callBridgeTool('sys_ops', { action: 'get_info' });
      if (result.ok) {
        const cpu = result.data?.cpu_percent || 'unknown';
        const mem = result.data?.memory_percent || 'unknown';
        return { text: `System status: CPU ${cpu}%, Memory ${mem}%.`, tool: 'sys_ops' };
      }
      return { text: 'Could not get system info.' };
    }

    // Calendar - list events
    if (/\b(calendar|schedule|events?)\b/.test(lower) && /\b(today|tomorrow|list|show|what)\b/.test(lower)) {
      const result = await callBridgeTool('calendar_ops', { action: 'get_today' });
      if (result.ok && result.data?.events) {
        const events = result.data.events;
        if (events.length === 0) {
          return { text: 'No events on your calendar today.', tool: 'calendar_ops' };
        }
        const summary = events.slice(0, 3).map(e => e.summary || e.title).join(', ');
        return { text: `Today's events: ${summary}`, tool: 'calendar_ops' };
      }
      return { text: result.message || 'Could not check calendar.' };
    }

    // Create file intent: "create/make a file ... named X ... that says Y"
    if (/\b(create|make)\b.*\bfile\b/.test(lower)){
      const nameMatch = text.match(/named\s+([\w\-. ]+?)(?:\s+that|\s+with|\s+containing|\s+which|$)/i);
      const contentMatch = text.match(/(?:that|with|containing)\s+(?:says|say|text\s+of|content|the\s+text)\s+(.+)$/i);
      const filename = (nameMatch?.[1]||'').trim();
      const content = (contentMatch?.[1]||'').trim() || text;
      let dir = 'documents';
      if (lower.includes('download')) dir = 'downloads';
      const body = { format: 'txt', filename: filename || '', content, dir };
      const url = `http://${config.HOST}:${config.PORT}/tools/file_gen`;
      const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) }).catch(()=>null);
      if (r && r.ok){
        const j = await r.json().catch(()=>null);
        if (j?.ok){
          const p = j.path?.replace(/\\/g,'/')||'';
          return { text: `I created the file ${p}.`, path: j.path };
        }
      }
      return { text: 'I tried to create the file but something went wrong.' };
    }
  } catch (e) {
    logger.warn('tryHandleSimpleTools failed', { error: e.message });
  }
  return null;
}

// Resolve user directories safely
function userPath(which){
  const base = os.homedir();
  if (!base) return process.cwd();
  if (which === 'downloads') return path.join(base, 'Downloads');
  if (which === 'documents') return path.join(base, 'Documents');
  return base;
}

function sanitizeChatText(t){
  try {
    let s = String(t||'')
    // Remove any file:/// temp references and internal temp names
    s = s.replace(/file:\/\/[\w\-_.:%/]+/gi, '[link removed]')
    s = s.replace(/ava_tmp_[A-Za-z0-9]+\.html/gi, '[temp removed]')
    return s
  } catch { return t }
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
  const integ = path.join(home, 'ava-integration');
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

// Intelligent file search function
async function handleIntelligentFileSearch(message) {
  try {
    // Extract keywords from the message
    const searchKeywords = [];
    const words = message.toLowerCase().replace(',', ' ').replace('.', ' ').split(' ');
    for (const word of words) {
      const cleanWord = word.replace(/[.,!?]/g, '');
      if (cleanWord.length > 2 && !['read', 'show', 'display', 'open', 'file', 'the', 'my', 'and', 'can', 'you', 'please'].includes(cleanWord)) {
        searchKeywords.push(cleanWord);
      }
    }

    logger.info('File search initiated', { keywords: searchKeywords });

    // Enhanced search for specific files like "claude sessions" or contextual references
    if (/claude.*sessions|sessions.*claude|open.*claude.*sessions|open\s+the\s+claude\s+sessions|open\s+that\s+file|open\s+it|please\s+open|open.*please|open\s+the\s+file.*asked|open\s+the\s+file.*just/i.test(message)) {
      // If it's a contextual reference, default to "claude sessions" based on conversation history
      const isContextualReference = /open\s+that\s+file|open\s+it|please\s+open|open.*please|open\s+the\s+file.*asked|open\s+the\s+file.*just/i.test(message);
      const searchPattern = isContextualReference ? /claude.*sessions|sessions.*claude/i : /claude.*sessions|sessions.*claude/i;
      // Direct search for claude sessions file
      const searchPaths = [
        'C:\\Users\\USER 1\\',
        'C:\\Users\\USER 1\\Downloads\\',
        'C:\\Users\\USER 1\\Documents\\',
        'C:\\Users\\USER 1\\Desktop\\',
        'C:\\Users\\USER 1\\OneDrive\\',
        'C:\\Users\\USER 1\\AppData\\Local\\',
        'C:\\Users\\USER 1\\.cache\\',
        'C:\\Users\\USER 1\\.config\\'
      ];

      for (const searchPath of searchPaths) {
        try {
          if (fs.existsSync(searchPath)) {
            const files = fs.readdirSync(searchPath);
            for (const file of files) {
              const fileLower = file.toLowerCase();
              // For contextual references, search for claude sessions specifically
              const shouldMatch = isContextualReference ?
                /claude.*sessions|sessions.*claude/i.test(file) :
                /claude.*sessions|sessions.*claude/i.test(file);

              if (shouldMatch) {
                const fullPath = path.join(searchPath, file);
                logger.info('Found claude sessions file', { path: fullPath });

                // Try to open the file
                try {
                  const { execSync } = require('child_process');
                  execSync(`start "" "${fullPath}"`, { shell: true, timeout: 5000 });

                  return {
                    success: true,
                    response: `Found and opened "${file}" from ${searchPath}`,
                    filePath: fullPath
                  };
                } catch (openError) {
                  logger.error('Failed to open claude sessions file', { error: openError.message });
                  return {
                    success: true,
                    response: `Found "${file}" at ${fullPath} but couldn't open it: ${openError.message}`,
                    filePath: fullPath
                  };
                }
              }
            }
          }
        } catch (dirError) {
          logger.warn('Directory search failed', { path: searchPath, error: dirError.message });
        }
      }

      // If not found, return helpful message
      return {
        success: true,
        response: `I searched for "claude sessions" file in your common directories but couldn't find it. The file might be in a different location or have a different name. Can you provide the full path or check if it exists?`,
        filePath: null
      };
    }

    // Original search logic for other files
    const searchPaths = [
      'C:\\Users\\USER 1\\',
      'C:\\Users\\USER 1\\Downloads\\',
      'C:\\Users\\USER 1\\Documents\\',
      'C:\\Users\\USER 1\\Desktop\\',
      'C:\\Users\\USER 1\\OneDrive\\'
    ];

    const foundFiles = [];
    for (const searchPath of searchPaths) {
      try {
        if (fs.existsSync(searchPath)) {
          const files = fs.readdirSync(searchPath);
          for (const file of files) {
            const fileLower = file.toLowerCase();
            if (searchKeywords.some(keyword => fileLower.includes(keyword))) {
              foundFiles.push(path.join(searchPath, file));
            }
          }
        }
      } catch (err) {
        logger.warn('Search path inaccessible', { path: searchPath, error: err.message });
      }
    }

    if (foundFiles.length === 0) {
      logger.info('No files found matching keywords');
      return { success: false, error: 'No matching files found' };
    }

    // Use the first matching file
    const targetFile = foundFiles[0];
    logger.info('File found', { file: targetFile });

    try {
      const fileContent = fs.readFileSync(targetFile, 'utf8');
      const fileName = path.basename(targetFile);
      
      return {
        success: true,
        filePath: targetFile,
        response: `📄 **${fileName}**\n\n${fileContent}`
      };
    } catch (readError) {
      logger.error('Failed to read file', { file: targetFile, error: readError.message });
      return { success: false, error: `Could not read file: ${readError.message}` };
    }

  } catch (error) {
    logger.error('File search error', { error: error.message });
    return { success: false, error: error.message };
  }
}

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

// Chat endpoint with intelligent file search
router.post('/chat', async (req, res) => {
  try {
    // Accept both sessionId and session_id from clients
    const raw = req.body || {};
    const text = raw.text;
    const sessionId = raw.sessionId || raw.session_id || 'default';
    const includeMemory = raw.includeMemory ?? true;
    const storeInMemory = raw.storeInMemory ?? true;
    const freshSession = raw.freshSession ?? false;  // Voice: don't include old session history
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    // Log user message
    const userMessageId = conversationLogger.logUserMessage(text, { 
      sessionId, 
      endpoint: '/chat',
      includeMemory,
      storeInMemory 
    });

    // DIRECT OPENAI INTEGRATION - No external tool dependencies
    const startTime = Date.now();

    // Handle simple direct queries
    const lower = text.toLowerCase();

    // Early recall: answer "what did we last talk about" from recent session logs
    if (/(what did we (last )?(talk|speak) about|what did we discuss( last time)?)/i.test(lower)){
      try {
        const recent = conversationLogger.getRecentHistory(50)
        const bySess = recent.filter(e=>String(e?.metadata?.sessionId||'default') === String(sessionId))
        // Find last user message and/or assistant reply
        const lastUser = [...bySess].reverse().find(e=>e.direction==='user')
        const lastAssistant = [...bySess].reverse().find(e=>e.direction==='assistant')
        let responseText = ''
        if (lastUser) responseText = `Your last request was: "${lastUser.content}".`
        if (lastAssistant) responseText += (responseText?' ':'') + `I replied: "${lastAssistant.content.replace(/\s+/g,' ').slice(0,200)}"`
        if (!responseText) responseText = 'I do not have recent messages in this session yet.'
        responseText = sanitizeChatText(responseText)
        conversationLogger.logAssistantMessage(responseText, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'recall' })
        return res.json({ ok:true, text: responseText, sessionId })
      } catch {}
    }

    // Early intent: deterministic document creation (ensures verified writes and clear diagnostics)
    if (/(create|generate|make|write).*\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/.test(lower)) {
      try {
        if (!config.ALLOW_WRITE) {
          const msg = 'Writes are disabled (ALLOW_WRITE=0). Enable writes to create files.';
          conversationLogger.logAssistantMessage(msg, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'filegen_preview' });
          return res.json({ ok: false, text: msg, sessionId });
        }

        // Parse format and content
        const fmtMatch = lower.match(/\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/);
        const fmt = (fmtMatch ? fmtMatch[1] : 'txt').toLowerCase();
        const dir = /documents?/.test(lower) ? 'documents' : 'downloads';
        // Use a simple heuristic for "random" content
        const content = /random/.test(lower) ? `Random message ${Math.random().toString(36).slice(2,8)} from AVA.` : (text || 'Generated by AVA.');
        // Delegate to deterministic endpoint via local HTTP to reuse full logic (Edge/Office/minimal PDF)
        const resp = await fetch(`http://127.0.0.1:${config.PORT}/tools/file_gen`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: fmt, content, dir })
        })
        const result = await resp.json().catch(()=>null)
        if (!resp.ok || !result?.ok){
          const errText = `I tried to create ${fmt.toUpperCase()} but could not verify the file on disk. Try enabling Office or Edge for richer formats, or use TXT/MD.`;
          conversationLogger.logAssistantMessage(errText, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'filegen_error' });
          return res.status(400).json({ ok:false, text: errText, sessionId });
        }

        let responseText = `Created ${fmt.toUpperCase()}: ${result.path}`;
        responseText = sanitizeChatText(responseText)
        conversationLogger.logAssistantMessage(responseText, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'filegen_success' });
        return res.json({ ok:true, text: responseText, sessionId });
      } catch (e) {
        const errText = `File creation error: ${e.message}`;
        conversationLogger.logAssistantMessage(errText, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'filegen_error' });
        return res.status(500).json({ ok:false, text: errText, sessionId });
      }
    }

    // Handle time queries directly
    if (/what time|current time|time is it|what's the time/.test(lower)) {
      const now = new Date();
      const timeString = now.toLocaleString();
      const responseText = `The current time is ${timeString}`;

      conversationLogger.logAssistantMessage(responseText, {
        sessionId,
        responseTime: Date.now() - startTime,
        userMessageId,
        responseType: 'direct_response'
      });

      return res.json({
        ok: true,
        text: responseText,
        sessionId
      });
    }

    // Handle date queries directly
    if (/what date|today's date|what day|current date/.test(lower)) {
      const now = new Date();
      const dateString = now.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      let responseText = `Today is ${dateString}`;
      responseText = sanitizeChatText(responseText)

      conversationLogger.logAssistantMessage(responseText, {
        sessionId,
        responseTime: Date.now() - startTime,
        userMessageId,
        responseType: 'direct_response'
      });

      return res.json({
        ok: true,
        text: responseText,
        sessionId
      });
    }

    // Handle Moltbook queries - hybrid approach: call tools directly for Moltbook actions
    if (/moltbook|other agents|agent community|what.*(learned|learning)|agent.*(feed|posts|tips)/i.test(lower)) {
      try {
        let responseText = '';
        const status = await moltbookService.getStatus();

        // Search Moltbook
        if (/search|find|look.*for|tips.*about|how.*do/i.test(lower)) {
          const queryMatch = lower.match(/(?:search|find|look for|tips about|how do.*?)[\s:]+(.+)/i);
          const query = queryMatch ? queryMatch[1].trim() : text;
          const results = await moltbookService.search(query, 5);
          if (results.length > 0) {
            responseText = `I searched Moltbook for "${query}" and found ${results.length} results:\n\n`;
            results.slice(0, 3).forEach((r, i) => {
              responseText += `${i + 1}. "${r.title}" by ${r.author?.name || 'unknown'} in m/${r.submolt?.name || 'general'}\n`;
              if (r.content) responseText += `   ${r.content.slice(0, 150)}...\n\n`;
            });
          } else {
            responseText = `I searched Moltbook for "${query}" but didn't find any matching posts.`;
          }
        }
        // Check feed
        else if (/feed|happening|what.*posting|latest|new.*posts/i.test(lower)) {
          const posts = await moltbookService.getFeed(5, 'hot');
          if (posts.length > 0) {
            responseText = `Here's what's happening on Moltbook:\n\n`;
            posts.slice(0, 3).forEach((p, i) => {
              responseText += `${i + 1}. "${p.title}" by ${p.author?.name || 'unknown'} (${p.upvotes || 0} upvotes)\n`;
            });
          } else {
            responseText = `I couldn't fetch the Moltbook feed right now.`;
          }
        }
        // What I've learned
        else if (/learned|learning|insights|know.*from/i.test(lower)) {
          const learnings = moltbookService.getRecentLearnings(5);
          const summary = moltbookService.getLearningsSummary();
          if (typeof summary === 'object' && summary.totalLearnings > 0) {
            responseText = `I've collected ${summary.totalLearnings} insights from other agents on Moltbook.\n\n`;
            responseText += `Recent topics: ${summary.recentTopics?.join(', ') || 'various'}\n`;
            responseText += `Top communities: ${summary.topCommunities?.join(', ') || 'general'}\n\n`;
            if (learnings.length > 0) {
              responseText += `Recent learnings:\n`;
              learnings.slice(0, 3).forEach((l, i) => {
                responseText += `${i + 1}. "${l.title}" from ${l.author}\n`;
              });
            }
          } else {
            responseText = `I'm registered on Moltbook as "${status.agentName}" and subscribed to learning communities, but I haven't collected many insights yet. Let me check the feed to learn more.`;
          }
        }
        // General Moltbook status
        else {
          responseText = `I'm "${status.agentName}" on Moltbook, a social network for AI agents. `;
          responseText += status.claimed ? `I'm verified and active. ` : `I'm pending verification. `;
          const summary = moltbookService.getLearningsSummary();
          if (typeof summary === 'object' && summary.totalLearnings > 0) {
            responseText += `I've learned ${summary.totalLearnings} things from other agents so far.`;
          } else {
            responseText += `I'm learning from other agents about self-improvement, troubleshooting, and becoming a better assistant.`;
          }
        }

        if (responseText) {
          conversationLogger.logAssistantMessage(responseText, { sessionId, responseTime: Date.now() - startTime, userMessageId, responseType: 'moltbook' });
          return res.json({ ok: true, text: responseText, sessionId });
        }
      } catch (e) {
        logger.warn('[chat] Moltbook query failed, falling through to LLM', { error: e.message });
      }
    }

    // Handle creative writing requests directly using LLM
    if (/write.*poem|create.*poem|compose.*poem|write.*story|creative|generate.*text|haiku|write.*haiku|create.*haiku/.test(lower)) {
      try {
        const llmResponse = await llmService.createCompletion({
          messages: [{ role: 'user', content: text }],
          system: 'You are a helpful creative writing assistant. Write the requested content directly without preamble.',
          temperature: 0.9
        });

        conversationLogger.logAssistantMessage(llmResponse.content, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'creative_direct'
        });

        return res.json({
          ok: true,
          text: llmResponse.content,
          sessionId
        });
      } catch (error) {
        logger.error('Creative writing failed', { error: error.message });
      }
    }

    // Handle file operation requests
    if (/list.*file|show.*file|directory.*content|ls|dir\b|files in/i.test(text)) {
      try {
        const files = fs.readdirSync(process.cwd());
        const fileList = files.map(file => {
          const stats = fs.statSync(path.join(process.cwd(), file));
          const type = stats.isDirectory() ? 'DIR ' : 'FILE';
          const size = stats.isFile() ? ` (${stats.size} bytes)` : '';
          return `${type}: ${file}${size}`;
        }).join('\n');

        let responseText = `Files in current directory (${process.cwd()}):\n\n${fileList}`;
        responseText = sanitizeChatText(responseText)

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_direct'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      } catch (error) {
        const responseText = `I couldn't list the files. Error: ${error.message}`;

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_error'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      }
    }

    // Handle file reading requests
    if (/read.*file|show.*content|cat\s|open.*file/i.test(text)) {
      try {
        // Extract filename from request
        const fileMatch = text.match(/(?:read|show|cat|open)\s+(?:file\s+)?['"]*([^\s'"]+)['"]*|['"]*([^\s'"]+\.(txt|js|json|md|py|html|css))['"]/i);
        if (!fileMatch) {
          return res.json({
            ok: true,
            text: "Please specify a filename to read (e.g., 'read package.json')",
            sessionId
          });
        }

        const filename = fileMatch[1] || fileMatch[2];
        const filepath = path.join(process.cwd(), filename);

        if (!fs.existsSync(filepath)) {
          return res.json({
            ok: true,
            text: `File '${filename}' not found in current directory.`,
            sessionId
          });
        }

        const content = fs.readFileSync(filepath, 'utf8');
        const responseText = `Content of ${filename}:\n\n\`\`\`\n${content.substring(0, 2000)}${content.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``;

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_read'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      } catch (error) {
        const responseText = `I couldn't read the file. Error: ${error.message}`;

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_error'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      }
    }

    // Handle memory/learning requests
    if (/remember|memory|learn|store|recall/.test(lower)) {
      try {
        if (/remember/.test(lower)) {
          // Store the information
          const memoryText = text.replace(/remember\s+(that\s+)?/i, '');
          await memoryService.upsert({
            role: 'user',
            text: memoryText,
            meta: { sessionId, timestamp: Date.now(), type: 'memory_storage' }
          });

          const responseText = `I'll remember that: ${memoryText}`;

          conversationLogger.logAssistantMessage(responseText, {
            sessionId,
            responseTime: Date.now() - startTime,
            userMessageId,
            responseType: 'memory_store'
          });

          return res.json({
            ok: true,
            text: responseText,
            sessionId
          });
        }
      } catch (error) {
        logger.error('Memory operation failed', { error: error.message });
      }
    }

    // Handle file writing/creation requests
    if (/create.*file|write.*file|save.*file|make.*file/.test(lower)) {
      try {
        // Extract filename and content from request
        const fileMatch = text.match(/(?:create|write|save|make)\s+(?:file\s+)?([^\s]+)\s+(?:with\s+)?(?:content\s+)?['"]*(.+?)['"]*$/i);
        if (!fileMatch) {
          return res.json({
            ok: true,
            text: "Please specify both filename and content (e.g., 'create file test.txt with content hello world')",
            sessionId
          });
        }

        const filename = fileMatch[1];
        const content = fileMatch[2];
        const filepath = path.join(process.cwd(), filename);

        fs.writeFileSync(filepath, content, 'utf8');
        const responseText = `File '${filename}' created successfully with content: "${content}"`;

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_write'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      } catch (error) {
        const responseText = `I couldn't create the file. Error: ${error.message}`;

        conversationLogger.logAssistantMessage(responseText, {
          sessionId,
          responseTime: Date.now() - startTime,
          userMessageId,
          responseType: 'file_error'
        });

        return res.json({
          ok: true,
          text: responseText,
          sessionId
        });
      }
    }

    // Handle web automation requests directly
    if (/navigate to|go to|open website|click.*on|type.*into|fill.*form|search.*for/i.test(text)) {
      try {
        const CMPUSE_API_URL = process.env.CMPUSE_API_URL || 'http://127.0.0.1:8001';

        let webAction = {};

        // Parse navigation requests
        if (/navigate to|go to|open website/i.test(text)) {
          const urlMatch = text.match(/(?:navigate to|go to|open website)\s+(.+)/i);
          if (urlMatch) {
            let url = urlMatch[1].trim();
            if (!url.startsWith('http')) {
              url = 'https://' + url;
            }
            webAction = { action: 'navigate', url };
          }
        }

        // Parse click requests
        else if (/click.*on/i.test(text)) {
          const clickMatch = text.match(/click.*on\s+(.+)/i);
          if (clickMatch) {
            const selector = clickMatch[1].trim();
            webAction = { action: 'click', selector };
          }
        }

        // Parse type/input requests
        else if (/type.*into|fill.*form/i.test(text)) {
          const typeMatch = text.match(/(?:type|fill)\s+['"]*([^'"]+)['"]*\s+into\s+(.+)/i);
          if (typeMatch) {
            const textToType = typeMatch[1];
            const selector = typeMatch[2];
            webAction = { action: 'type', text: textToType, selector };
          }
        }

        // Parse search requests
        else if (/search.*for/i.test(text)) {
          const searchMatch = text.match(/search.*for\s+['"]*([^'"]+)['"]*/i);
          if (searchMatch) {
            const searchText = searchMatch[1];
            webAction = { action: 'search', text: searchText };
          }
        }

        if (Object.keys(webAction).length > 0) {
          const response = await fetch(`${CMPUSE_API_URL.replace(/\/$/, '')}/run?force=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'web_automation', args: webAction })
          });

          if (response.ok) {
            const cmpResult = await response.json();
            const result = cmpResult[0] || {};

            let responseText = '';
            if (result.status === 'ok') {
              if (webAction.action === 'navigate') {
                responseText = `Successfully navigated to ${webAction.url}. Page title: ${result.title || 'Unknown'}`;
              } else if (webAction.action === 'click') {
                responseText = `Successfully clicked on element: ${webAction.selector}`;
              } else if (webAction.action === 'type') {
                responseText = `Successfully typed "${webAction.text}" into ${webAction.selector}`;
              } else if (webAction.action === 'search') {
                responseText = `Successfully searched for "${webAction.text}"`;
              } else {
                responseText = `Web automation completed: ${result.message}`;
              }
            } else {
              responseText = `Web automation failed: ${result.message}`;
            }

            conversationLogger.logAssistantMessage(responseText, {
              sessionId,
              responseTime: Date.now() - startTime,
              userMessageId,
              responseType: 'web_automation'
            });

            return res.json({
              ok: true,
              text: responseText,
              sessionId
            });
          }
        }
      } catch (error) {
        logger.error('Web automation failed', { error: error.message });
      }
    }

    // All requests go directly to OpenAI for natural conversation

    // SYSTEM OPERATION DETECTION: Check if this is a system/folder operation request
    const lowerText = text.toLowerCase();
    const isSystemOperation = /\b(open|show|launch|run|start|execute|browse|navigate|go to|access)\b.*\b(folder|directory|documents|desktop|downloads|pictures|music|videos|explorer|file manager)\b/i.test(text) ||
                             /\b(documents|desktop|downloads|pictures|music|videos|home|root)\s+(folder|directory)\b/i.test(text) ||
                             /\b(open|browse|show|access)\s+(the\s+)?documents/i.test(text);

    if (isSystemOperation) {
      logger.info('System operation detected, executing folder operation', { text });

      try {
        const { execSync } = require('child_process');
        const path = require('path');
        const os = require('os');

        // Handle documents folder specifically
        if (/\b(open|browse|show|access)\s+(the\s+)?documents/i.test(text)) {
          const documentsPath = path.join(os.homedir(), 'Documents');
          logger.info('Opening documents folder', { path: documentsPath });

          try {
            // Use Windows start command to open the folder
            const startCmd = `start "" "${documentsPath}"`;
            execSync(startCmd, { timeout: 5000, shell: true, stdio: ['ignore', 'ignore', 'pipe'] });

            const responseText = `Successfully opened the Documents folder.`;

            conversationLogger.logAssistantMessage(responseText, {
              sessionId,
              responseTime: Date.now() - startTime,
              userMessageId,
              responseType: 'system_operation'
            });

            // Store in memory for learning
            if (storeInMemory) {
              try {
                const memoryService = (await import('../services/memory.js')).default;

                await memoryService.upsert({
                  role: 'user',
                  text: `User requested: ${text}`,
                  meta: {
                    sessionId,
                    timestamp: Date.now(),
                    category: 'system_operation',
                    operation: 'open_documents_folder'
                  }
                });

                await memoryService.upsert({
                  role: 'assistant',
                  text: `Successfully opened Documents folder for user. User often requests this folder access.`,
                  meta: {
                    sessionId,
                    timestamp: Date.now(),
                    category: 'system_operation',
                    operation: 'open_documents_folder',
                    result: 'success'
                  }
                });
              } catch (memErr) {
                logger.warn('Failed to store system operation in memory', { error: memErr.message });
              }
            }

            return res.json({
              ok: true,
              text: responseText,
              sessionId
            });
          } catch (execError) {
            // Fallback to PowerShell
            try {
              const powershellCmd = `powershell.exe -WindowStyle Hidden -Command "& {Start-Process explorer.exe -ArgumentList '${documentsPath}'}"`;
              execSync(powershellCmd, { timeout: 5000, shell: true });

              const responseText = `Successfully opened the Documents folder.`;

              conversationLogger.logAssistantMessage(responseText, {
                sessionId,
                responseTime: Date.now() - startTime,
                userMessageId,
                responseType: 'system_operation'
              });

              // Store in memory for learning
              if (storeInMemory) {
                try {
                  const memoryService = (await import('../services/memory.js')).default;

                  await memoryService.upsert({
                    role: 'user',
                    text: `User requested: ${text}`,
                    meta: {
                      sessionId,
                      timestamp: Date.now(),
                      category: 'system_operation',
                      operation: 'open_documents_folder'
                    }
                  });

                  await memoryService.upsert({
                    role: 'assistant',
                    text: `Successfully opened Documents folder for user via PowerShell fallback. User frequently requests documents access.`,
                    meta: {
                      sessionId,
                      timestamp: Date.now(),
                      category: 'system_operation',
                      operation: 'open_documents_folder',
                      result: 'success',
                      method: 'powershell_fallback'
                    }
                  });
                } catch (memErr) {
                  logger.warn('Failed to store system operation in memory', { error: memErr.message });
                }
              }

              return res.json({
                ok: true,
                text: responseText,
                sessionId
              });
            } catch (psError) {
              logger.error('Failed to open Documents folder', { error: psError.message });

              const errorText = `Failed to open Documents folder. Error: ${psError.message}`;

              conversationLogger.logAssistantMessage(errorText, {
                sessionId,
                responseTime: Date.now() - startTime,
                userMessageId,
                responseType: 'system_operation_error'
              });

              return res.json({
                ok: false,
                text: errorText,
                sessionId
              });
            }
          }
        }

        // Handle other folder operations
        // Add more folder handling logic here if needed

      } catch (systemError) {
        logger.error('System operation failed', { error: systemError.message });
        // Continue with normal processing as fallback
      }
    }

    // INTELLIGENT FILE SEARCH: Check if this is a file access request
    const fileAccessKeywords = ['read my', 'show my', 'open my', 'deployment', 'summary', 'report', 'document', 'notes', 'log', 'file'];
    // Debug: Log the text being tested
    logger.info('Testing file request detection', { text, lowerText: text.toLowerCase() });

    const isFileRequest = fileAccessKeywords.some(keyword => text.toLowerCase().includes(keyword)) ||
                         /open.*file|read.*file|show.*file|claude.*sessions|sessions.*file|open\s+that\s+file|open\s+it|please\s+open|open.*please|open\s+the\s+file.*asked|open\s+the\s+file.*just/i.test(text);

    logger.info('File request detection result', { isFileRequest, text });

    if (isFileRequest) {
      try {
        const searchResult = await handleIntelligentFileSearch(text);
        if (searchResult.success) {
          // Log file access response
          conversationLogger.logAssistantMessage(searchResult.response, {
            sessionId,
            responseTime: 0,
            userMessageId,
            responseType: 'file_access'
          });

          return res.json({
            ok: true,
            text: searchResult.response,
            sessionId,
            fileAccessed: searchResult.filePath
          });
        }
      } catch (fileError) {
        logger.warn('File search failed, falling back to LLM', { error: fileError.message });
      }
    }

    const result = await llmService.chatCompletion(sessionId, text, {
      includeMemory,
      storeInMemory,
      freshSession
    });
    const responseTime = Date.now() - startTime;

    // Log assistant response
    conversationLogger.logAssistantMessage(result.content, {
      sessionId,
      responseTime,
      userMessageId,
      tokens: result.usage,
      model: result.model || config.REALTIME_MODEL
    });

    res.json({
      ok: true,
      text: result.content,
      sessionId,
      usage: result.usage
    });
  } catch (error) {
    conversationLogger.logError(error, { 
      endpoint: '/chat', 
      sessionId: req.body.sessionId,
      userText: req.body.text 
    });
    logger.error('Chat failed', { error: error.message });
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// (Removed old LLM-based /respond; new /respond below routes to agent loop)

// Simple message router
function routeMessage(text) {
  const lower = text.toLowerCase();
  
  if (/^what'?s your name|who are you|your name/.test(lower)) {
    return { mode: 'direct' };
  }
  
  return { mode: 'auto' };
}

function handleDirectResponse(text) {
  const lower = text.toLowerCase();
  
  if (/^what'?s your name|who are you|your name/.test(lower)) {
    try {
      const status = buildSelfStatus();
      return buildSelfResponseText(status);
    } catch {
      return "I'm your local assistant.";
    }
  }
  
  return "I'm here to help! What would you like to know?";
}

// Tools endpoint placeholder
router.get('/ava/tools', async (_req, res) => {
  try {
    // Check if cmp-use API is available
    const response = await fetch(`${config.CMPUSE_API_URL}/tools`).catch(() => null);
    
    if (response && response.ok) {
      const tools = await response.json();
      return res.json(tools);
    }
    
    // Return basic built-in tools
    res.json({
      ok: true,
      tools: [
        { name: 'memory_search', description: 'Search through conversation memory' },
        { name: 'persona_info', description: 'Get user persona and preferences' },
        { name: 'chat', description: 'Have a conversation with the assistant' }
      ]
    });
  } catch (error) {
    logger.error('Tools fetch failed', { error: error.message });
    res.status(500).json({
      ok: false,
      error: 'Tools service unavailable. Start cmpuse API on 127.0.0.1:8000.'
    });
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

// Compatibility endpoint for realtime runner: route text to agent loop
router.post('/respond', async (req, res) => {
  try {
    const { text, messages } = req.body || {};
    const goal = (typeof text === 'string' && text.trim())
      ? text.trim()
      : Array.isArray(messages)
        ? messages.map(m => (m?.content || '')).join('\n').trim()
        : '';

    if (!goal) {
      return res.status(400).json({ ok: false, error: 'Missing text/messages' });
    }

    const state = await agentLoop.runAgentLoop(goal, {});
    let finalText = state.final_result || 'Done.';
    
    // VOICE FILTER: Convert step status messages to natural responses
    if (isStepStatusMessage(finalText)) {
      console.log(`[respond] Filtering step status: ${finalText.slice(0, 50)}...`);
      finalText = getNaturalResponse(goal, finalText);
    }
    
    res.json({ ok: true, output_text: String(finalText || '').slice(0, 4000), agent: {
      id: state.id,
      status: state.status,
      steps: state.step_count,
      result: state.final_result,
      errors: state.errors
    }});
  } catch (error) {
    logger.error('Respond failed', { error: error.message });
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

export default router;
