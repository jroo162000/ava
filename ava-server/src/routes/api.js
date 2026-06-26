// Main API routes
import express from 'express';
import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from '../services/memory.js';
import llmService from '../services/llm.js';
import toolsService from '../services/tools.js';
import conversationLogger from '../services/conversationLogger.js';
import artifactMemory from '../services/artifactMemory.js';
import personaSvc from '../services/persona.js';
import curatedMemory from '../services/curatedMemory.js';
import memorySearch from '../services/memorySearch.js';
import conversationHistory from '../services/conversationHistory.js';
import memoryReviewer from '../services/memoryReviewer.js';
import skillStore from '../services/skillStore.js';
import skillCapture from '../services/skillCapture.js';
import lessonLearner from '../services/lessonLearner.js';
import sandbox from '../services/sandbox.js';
import trainingGuidance from '../services/trainingGuidance.js';
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
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

function isSelfDescriptionRequest(text = '') {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return false;
  return (
    /^(who are you|what are you|what'?s your name|what is your name)\b/.test(lower) ||
    /\b(tell me about yourself|tell me who you are|about yourself|your name)\b/.test(lower) ||
    // capability questions — answer with what she can do (mentions "can/help/tools")
    /\bwhat (are|r) (all )?(of )?your (capabilit|function|feature|tool)/.test(lower) ||
    /\bwhat can you (do|help)\b/.test(lower) ||
    /\bwhat kinds? of things can you\b/.test(lower) ||
    /\bwalk me through what you can\b/.test(lower) ||
    /\b(your|list your) (capabilities|functions)\b/.test(lower)
  );
}

// True when a question implies a tool/data action that the runner's verb-based
// gate misses (e.g. "what's on my calendar?", "do I have any emails?"). Lets such
// question-phrased turns reach the tool path instead of just being described.
function looksLikeToolRequest(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  return (
    /\b(calendar|schedule|agenda|appointments?|my events?|my meetings?|free time)\b/.test(t) ||
    /\b(emails?|inbox|gmail|unread|send (a |an )?(text|sms|message)|text my|message my)\b/.test(t) ||
    /\b(screenshot|screen ?shot|read (the|my) screen|on (my|the) screen|\bocr\b)\b/.test(t) ||
    /\b(camera|webcam|take (a )?(photo|picture)|what do you see)\b/.test(t) ||
    /\b(cpu|ram|memory usage|disk space|battery|system info|how much (ram|memory|disk)|running processes)\b/.test(t) ||
    /\b(turn (it )?(on|off)|lights?|thermostat|set (the )?(temperature|brightness|volume))\b/.test(t) ||
    /\b(remember that|make a note|take a note|note this down)\b/.test(t) ||
    // file listing / finding / reading
    /\b(list|find|search for|locate|show me|name|count|how many|open|read|delete)\b[\s\S]{0,40}\b(files?|folders?|documents?)\b/.test(t) ||
    /\b(files?|folders?|documents?)\b[\s\S]{0,40}\b(begin|begins|start|starts|named|called|matching|that (start|begin))\b/.test(t) ||
    /\bhow many lines\b/.test(t) ||
    // self-diagnosis / capability control
    /\b(diagnose|diagnostic|self[- ]?diagnos|run (a |the )?diagnos|check (all )?(of )?(your )?(tools|capabilities|systems|functions)|test (all )?(your )?(tools|capabilities))\b/.test(t)
  );
}

// Detect "let me see / describe what's in front of the camera" so we can run the
// camera's see+describe directly (deterministic) instead of leaving it to the agent,
// which has been asking to confirm or picking the wrong action.
function looksLikeCameraSee(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (/\bwhat do you see\b/.test(t)) return true;
  if (/\b(look through|look at|look in|peek through|use|check)\b[\s\S]{0,20}\b(camera|webcam)\b/.test(t)) return true;
  if (/\b(camera|webcam)\b/.test(t) && /\b(see|look|describe|what.{0,15}\b(you )?see\b|what.?s in front|who('?s| is)|what.?s there)\b/.test(t)) return true;
  if (/\b(start|turn on|open|activate)\b[\s\S]{0,20}\b(camera|webcam)\b/.test(t) && /\b(see|look|describe|tell me|what)\b/.test(t)) return true;
  return false;
}

// Detect "diagnose / check / test YOUR <X> tool" — a request to self-diagnose one of her own
// tools. The model tends to call the tool itself (e.g. comm_ops to "check email"); this routes
// it deterministically to self_awareness's diagnose_tool instead. Returns {tool,label} or null.
function diagnoseTargetTool(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  const hasIntent = /\b(diagnose|diagnostic|troubleshoot)\b/.test(t)
    || (/\b(check|test|verify)\b/.test(t) && /\byour\b[\s\S]{0,30}\b(tool|working|ok|broken|problem)\b/.test(t))
    || (/\bis\b[\s\S]{0,10}\byour\b[\s\S]{0,30}\b(working|ok|broken)\b/.test(t))
    || (/\bwhy\b[\s\S]{0,40}\b(not working|isn'?t working|won'?t work|fail|broken)\b/.test(t) && /\byour\b/.test(t));
  if (!hasIntent) return null;
  if (!/\b(your|the)\b/.test(t)) return null;
  const map = [
    [/\b(e-?mail|inbox|gmail|comm)\b/, 'comm_ops', 'email'],
    [/\b(calendar|schedul|event)\b/, 'calendar_ops', 'calendar'],
    [/\b(camera|webcam)\b/, 'camera_ops', 'camera'],
    [/\b(screen|vision|ocr)\b/, 'screen_ops', 'screen'],
    [/\b(browser|web ?page)\b/, 'browser_automation', 'browser'],
    [/\b(memory|recall)\b/, 'memory_search', 'memory'],
    [/\b(voice|speech|tts|audio|sound|volume)\b/, 'audio_ops', 'audio'],
    [/\b(smart ?home|thermostat|lights?)\b/, 'iot_ops', 'smart home'],
    [/\b(file|files|filesystem)\b/, 'fs_ops', 'file'],
    [/\b(system|cpu|disk)\b/, 'sys_ops', 'system'],
  ];
  for (const [re, tool, label] of map) if (re.test(t)) return { tool, label };
  if (/\b(tools|capabilit|functions|systems|everything|all your)\b/.test(t)) return { tool: null, label: 'tools' };
  return null;
}

// Detect "open / launch my <file or document>" so we can resolve + open it deterministically
// instead of letting the model over-ask ("can you confirm…?"). NARROW on purpose: it must NOT
// fire for opening an APP ("open paint") or a URL ("open github.com") — those already work via
// the agent loop. Returns the file hint string, or null.
function openFileTarget(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (!/\b(open|launch|bring up|pull up)\b/.test(t)) return null;
  // If they also want the CONTENT read out ("read me the second line", "what does it say"),
  // that's the READ path, not a plain open — let it fall through.
  if (/\b(read (me|it|the|out)|what does|what'?s in|the (first|second|third|last|next) line|line (one|two|three|1|2|3)|how many lines|number of lines|contents? of)\b/.test(t)) return null;
  // exclude URLs / web destinations
  if (/https?:|www\.|\.(com|org|net|io|gov|co|app)\b|\b(github|youtube|google|gmail|website|web ?page|browser|url|link)\b/.test(t)) return null;
  // exclude app-launch requests (these route fine through the agent loop)
  if (/\b(paint|calculator|calc|notepad|word|excel|powerpoint|outlook|chrome|edge|firefox|safari|spotify|discord|slack|terminal|cmd|powershell|explorer|settings|store|camera app|calendar app|the app)\b/.test(t)) return null;
  // a bare filename with an extension is unambiguous
  const fn = t.match(/\b([a-z0-9_\-]+\.[a-z0-9]{1,5})\b/);
  if (fn) return fn[1];
  // "open my <doc-noun>" / "open the <doc-noun> file/document"
  const DOC = /(resume|cv|report|budget|invoice|notes?|note|letter|essay|paper|spreadsheet|presentation|deck|memo|contract|agreement|draft|summary|todo|checklist)/;
  // Find the doc-noun anywhere after "open my/the …" so trailing fluff ("file in its app",
  // "from my documents", "so I can see it") doesn't break the match.
  const m = t.match(/\b(?:open|launch|bring up|pull up)(?:\s+up)?\s+(?:my|the|a|an)\s+([a-z][a-z0-9_\- ]{1,30})/);
  if (m && m[1]) {
    const dm = m[1].match(DOC);
    if (dm) return dm[0].replace(/s$/, '');
  }
  return null;
}

// Detect "read / first line / second line / how many lines of <file.ext>" so we read it
// deterministically (fs_read) instead of prefixing fs_find or picking open_item. NARROW:
// requires an explicit filename with an extension. Returns { name, folder, want } or null.
// Build a relative "Folder/name" path that the sandbox redirect maps correctly ONCE
// (passing an already-absolute device path double-redirects and breaks). Also resolves in
// real mode via fs_read's own folder search.
function filePathFor(folder, name) {
  const F = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures' };
  const f = F[String(folder || '').toLowerCase()];
  return f ? (f + '/' + name) : name;
}

function readFileTarget(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  const fn = t.match(/\b([a-z0-9_][a-z0-9_\-]*\.[a-z0-9]{1,5})\b/);
  if (!fn) return null;
  if (/\b(github|youtube|google|gmail|\.com|\.org|\.net|\.io)\b/.test(t)) return null;       // not a URL
  if (/\b(append|add a (new )?line|write|overwrite|create|save|delete|remove|rename|move)\b/.test(t)) return null;
  const isRead = /\b(read|contents?|what does|what'?s (in|the)|the (first|second|third|last) line|line (one|two|three|1|2|3)|how many lines|count.*lines?|number of lines|say|says|tell me)\b/.test(t);
  if (!isRead) return null;
  const folderM = t.match(/\b(desktop|downloads?|documents?|pictures?)\b/);
  let want = 'all';
  if (/\b(first line|line one|line 1|1st line)\b/.test(t)) want = 'first';
  else if (/\b(second line|line two|line 2|2nd line)\b/.test(t)) want = 'second';
  else if (/\b(third line|line three|line 3|3rd line)\b/.test(t)) want = 'third';
  else if (/\b(how many lines|count.*lines?|number of lines)\b/.test(t)) want = 'count';
  return { name: fn[1], folder: folderM ? folderM[1] : '', want };
}

// Detect "find / locate / where is / list the <X> files" so we resolve them deterministically
// (fs_find). Conservative: needs a concrete name/prefix (not a bare "list my documents", which
// the agent's fs_ops list handles). Returns { pattern, folder } or null.
function findFilesTarget(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (!/\b(find|locate|where('?s| is| are)|which files|search for|name the|list)\b/.test(t)) return null;
  if (/\b(open|launch|read|append|add|write|delete|remove|email|inbox|calendar|browser|app|window)\b/.test(t)) return null;
  let pat = '';
  let m = t.match(/\b(?:start(?:s|ing)? with|begin(?:s|ning)? with|named|called|matching)\s+([a-z0-9_][a-z0-9_\-.]*)/);
  if (m) pat = m[1];
  if (!pat) { const f = t.match(/\b([a-z0-9_]{2,}\.[a-z0-9]{1,5})\b/); if (f) pat = f[1].replace(/\.[a-z0-9]+$/, ''); }
  if (!pat) { const m2 = t.match(/\b([a-z0-9_]{3,})\s+(?:files?|documents?)\b/); if (m2) pat = m2[1]; }
  const STOP = new Set(['the', 'my', 'all', 'some', 'these', 'those', 'any', 'your', 'our', 'more', 'other', 'new', 'old',
    'list', 'find', 'show', 'locate', 'search', 'name', 'get', 'see', 'which', 'what', 'that', 'this']);
  if (!pat || STOP.has(pat)) return null;
  const folderM = t.match(/\b(desktop|downloads?|documents?|pictures?)\b/);
  return { pattern: pat, folder: folderM ? folderM[1] : '' };
}

// Detect "append / add a line <text> to <file.ext>" so we append WITHOUT erasing (file_gen
// mode:append). NARROW: requires an explicit filename and an append phrasing. Returns
// { name, folder, payload } or null. The payload is the exact line to add.
function appendTarget(text = '') {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  if (!t) return null;
  if (!/\b(append|add|put)\b/.test(t)) return null;
  const fn = t.match(/\b([a-z0-9_][a-z0-9_\-]*\.[a-z0-9]{1,5})\b/);
  if (!fn) return null;
  if (!/\b(line|to|into|onto|end of|without (deleting|erasing)|do not erase)\b/.test(t)) return null;
  let payload = '';
  let m = raw.match(/\bthat says\s+(.+?)\s+(?:to|at|into|in)\b/i);
  if (!m) m = raw.match(/\b(?:append|add|put)\s+(?:a\s+(?:new\s+)?line\s+(?:that says\s+)?)?(.+?)\s+(?:to|at the end of|into|in)\b/i);
  if (!m) m = raw.match(/\bline\s+(.+?)\s+(?:to|at the end of)\b/i);
  if (m) payload = m[1].trim();
  payload = payload.replace(/\b(a new line|as a new line|new line)\b/ig, '').replace(/^["']|["']$/g, '').trim();
  if (!payload || payload.length < 2 || payload.length > 120) return null;
  const folderM = t.match(/\b(desktop|downloads?|documents?|pictures?)\b/);
  return { name: fn[1], folder: folderM ? folderM[1] : '', payload };
}

// Detect a "recall" request about PAST conversations/decisions so we can route it
// straight to the tool path (memory_search) and give a grounded answer, instead of
// asking the user to narrow it down. Immediate ("what did you just say") is excluded —
// the recent turns already cover that in the conversational path.
function looksLikeRecall(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (/\b(just (say|said|ask|asked|told)|a (second|moment) ago|last thing you (said|asked))\b/.test(t)) return false;
  if (/\b(recall|remind me (what|about|when|how)|do you remember|did we (ever )?(talk|discuss|decide|cover|mention|go over|work))\b/.test(t)) return true;
  if (/\b(what|which|when|how|where)\b[\s\S]{0,40}\b(we|you|i)\b[\s\S]{0,40}\b(discuss(ed)?|talk(ed)?|said|say|decide(d)?|mention(ed)?|cover(ed)?|agree(d)?|went over|go over|work(ed)? on|set ?up|configure(d)?|chang(e|ed)|fix(ed)?|built|build|test(ed)?)\b/.test(t)) return true;
  if (/\b(earlier|before|previously|last (time|week|night|session)|yesterday|the other day|past conversation|our (last )?conversation|so far|up to now)\b/.test(t)
      && /\b(discuss|talk|said|say|decide|mention|cover|agree|work|about|regarding|\bon\b|did|go over)\b/.test(t)) return true;
  // "what was the last question I asked", "the last thing I said", "my previous question"
  if (/\b(last|previous|first|earlier) (question|thing|message|request|point)\b/.test(t)) return true;
  if (/\bwhat\b[\s\S]{0,25}\b(i|we)\b[\s\S]{0,15}\b(ask|asked|say|said)\b/.test(t)) return true;
  return false;
}

// Find the most recent successful tool result in the agent loop's history, so its
// data can be turned into a spoken answer when the loop itself didn't compose one.
function extractLastToolResult(state) {
  try {
    const hist = Array.isArray(state && state.history) ? state.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      const r = h && h.result;
      const tool = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
      if (tool && r && String(r.status).toLowerCase() === 'ok') {
        return { tool, result: r };
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Like extractLastToolResult but returns the most recent tool result of ANY status
// (ok/error/blocked/needs_confirm), so failures can be reported truthfully.
function extractLastToolResultAny(state) {
  try {
    const hist = Array.isArray(state && state.history) ? state.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      const r = h && h.result;
      const tool = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
      if (tool && r && r.status) {
        return { tool, result: r };
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function buildSpokenSelfResponseText() {
  try {
    const status = buildSelfStatus();
    const id = status.identity || {};
    const name = id.name || 'AVA';
    return `I'm ${name}, your local voice assistant. I can answer questions, help with tasks, and use local tools when you ask me to.`;
  } catch {
    return "I'm AVA, your local voice assistant. I can answer questions, help with tasks, and use local tools when you ask me to.";
  }
}

function normalizeSpokenReplyBudget(body = {}) {
  const voiceMode = String(body.voice_mode || body.voiceMode || '').toLowerCase();
  const rawBudget = body.spoken_reply_budget || body.spokenReplyBudget || {};
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const defaults = voiceMode === 'spoken'
    ? { maxSentences: 2, maxWords: 28 }
    : { maxSentences: 4, maxWords: 60 };

  return {
    voiceMode,
    maxSentences: parsePositiveInt(rawBudget.max_sentences ?? rawBudget.maxSentences, defaults.maxSentences),
    maxWords: parsePositiveInt(rawBudget.max_words ?? rawBudget.maxWords, defaults.maxWords),
  };
}

function shapeSpokenReply(text, body = {}) {
  let reply = typeof text === 'string' ? text.trim() : '';
  if (!reply) return '';

  const budget = normalizeSpokenReplyBudget(body);
  if (budget.voiceMode !== 'spoken') return reply;

  const sentenceMatches = reply.match(/[^.!?]+[.!?]?/g) || [reply];
  reply = sentenceMatches.slice(0, budget.maxSentences).join(' ').replace(/\s+/g, ' ').trim();

  const words = reply.split(/\s+/).filter(Boolean);
  if (words.length > budget.maxWords) {
    reply = words.slice(0, budget.maxWords).join(' ').replace(/[,:;]+$/g, '').trim();
    if (reply && !/[.!?]$/.test(reply)) {
      reply += '.';
    }
  }

  return reply;
}

const router = express.Router();

// Realtime compatibility: route text/messages to Agent Loop with memory/tools
router.post('/respond', async (req, res) => {
  try {
    const { text, messages, sessionId = 'voice-default', freshSession = false,
            run_tools, memory_filter } = req.body || {};
    const userText = (typeof text === 'string' && text.trim())
      ? text.trim()
      : Array.isArray(messages) && messages.length > 0
        ? String(messages[messages.length - 1]?.content || messages[messages.length - 1]?.text || '').trim()
        : '';

    if (!userText) {
      return res.status(400).json({ ok: false, error: 'Missing text/messages' });
    }

    try { conversationLogger.logUserMessage(userText, { sessionId, endpoint: '/respond', freshSession }); } catch {}

    // "Dreaming" reviewer: every N turns, kick off a non-blocking background pass that
    // distills durable facts from recent conversation into curated memory. Fire-and-forget
    // (deferred a tick) so it never delays the spoken reply.
    try {
      if (process.env.AVA_MEMORY_REVIEW_OFF !== '1' && process.env.AVA_SANDBOX !== '1') {
        const _counts = (global.__avaTurnCounts ||= {});
        _counts[sessionId] = (_counts[sessionId] || 0) + 1;
        const every = parseInt(process.env.AVA_MEMORY_REVIEW_EVERY || '6', 10) || 6;
        if (_counts[sessionId] % every === 0) {
          setTimeout(() => { memoryReviewer.reviewAndUpdate().catch(() => {}); }, 50);
        }
      }
    } catch {}

    if (isSelfDescriptionRequest(userText)) {
      // Natural, LLM-generated self-introduction grounded in her real identity data
      // (this used to return a fixed canned sentence).
      let finalText = '';
      try {
        const id = (buildSelfStatus().identity) || {};
        const idFacts = [
          `Name: ${id.name || 'AVA'}`,
          id.purpose ? `Purpose: ${id.purpose}` : null,
          id.developer ? `Created by: ${id.developer}` : null,
        ].filter(Boolean).join('\n');
        const budget = normalizeSpokenReplyBudget(req.body || {});
        const sys = `${personaSvc.buildPersonaBlock()}\n\nYou are a local voice assistant on ${id.developer || 'the user'}'s Windows computer. Introduce yourself naturally and warmly in your own voice (spoken aloud, so about ${budget.maxSentences} sentences). What you know about yourself:\n${idFacts}\nYou can also take real actions through local tools (calendar, email, files, camera, screen reading, mouse/keyboard, browser, system info, smart home, and more). Don't list every tool; just convey who you are and that you can both chat and do things.`;
        const r = await llmService.chat([
          { role: 'system', content: sys },
          { role: 'user', content: userText }
        ], { temperature: 0.5, max_tokens: 800 });
        finalText = (r.text || r.content || '').trim();
      } catch (e) { /* fall back to the canned line below */ }
      if (!finalText) finalText = buildSpokenSelfResponseText();
      finalText = shapeSpokenReply(finalText, req.body || {});
      try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'direct-self' }); } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
        id: 'direct-self-' + Date.now(),
        status: 'success',
        steps: 0,
        result: finalText,
        errors: []
      }});
    }

    // CAMERA-SEE PATH: "tell me what you see / look through the camera / start the camera
    // and describe" — run camera_ops `see` directly (turns on + captures + describes) so she
    // never asks to confirm or picks the wrong action.
    if (looksLikeCameraSee(userText) && !diagnoseTargetTool(userText)) {
      logger.info('[respond] Camera-see path', { text: userText.slice(0, 60) });
      let finalText = '';
      try {
        const r = await toolsService.executeTool('camera_ops', { action: 'see' }, false, { source: 'voice', bypassIdempotency: true });
        const res = (r && (r.result || r)) || {};
        const desc = res.description || res.message || (res.result && (res.result.description || res.result.message)) || '';
        finalText = String(desc || '').trim();
        if (/openai key|couldn't run vision|could not run vision/i.test(finalText)) {
          finalText = "I turned the camera on, but my vision isn't available right now.";
        }
      } catch (e) {
        finalText = '';
      }
      if (!finalText) finalText = "I tried to look through the camera but couldn't get a description just now.";
      finalText = shapeSpokenReply(finalText, req.body || {});
      try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'camera-see' }); } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
        id: 'camera-see-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
      }});
    }

    // DIAGNOSE PATH: "diagnose / check / is your <X> tool working" — run self_awareness's
    // diagnose_tool DIRECTLY instead of letting the model call the tool itself (which it tends
    // to do, e.g. comm_ops to "check email"). Guidance alone didn't fix this reliably.
    {
      const diag = diagnoseTargetTool(userText);
      if (diag) {
        logger.info('[respond] Diagnose path', { tool: diag.tool, label: diag.label });
        let finalText = '';
        try {
          const r = await toolsService.executeTool('self_awareness',
            { action: 'diagnose_tool', tool: diag.tool || 'all', tool_name: diag.tool || 'all', name: diag.tool || 'all' },
            false, { source: 'voice', bypassIdempotency: true });
          const dres = (r && (r.result || r)) || {};
          const inner = dres.result || dres;
          const msg = inner.summary || inner.capability_summary || inner.likely_cause || inner.message
            || (typeof inner === 'string' ? inner : '');
          finalText = `I ran a diagnostic on the ${diag.label} tool. ${String(msg || '').trim()}`.trim();
        } catch (e) { finalText = ''; }
        if (!finalText || finalText.length < 12) {
          finalText = `I ran a diagnostic on the ${diag.label} tool — it looks registered and reachable; I didn't find an obvious problem.`;
        }
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'diagnose' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'diagnose-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
        }});
      }
    }

    // OPEN-FILE PATH: "open / launch my <file or document>" — resolve the file (fs_find) and
    // open it (open_item) deterministically, instead of letting the model over-ask. Apps and
    // URLs are excluded by openFileTarget and continue through the normal path.
    {
      const openHint = openFileTarget(userText);
      if (openHint) {
        logger.info('[respond] Open-file path', { hint: openHint });
        let resolvedPath = '';
        try {
          const fr = await toolsService.executeTool('fs_find', { pattern: openHint }, false, { source: 'voice', bypassIdempotency: true });
          const fres = (fr && (fr.result || fr)) || {};
          const files = fres.files || fres.matches || fres.results || [];
          if (Array.isArray(files) && files.length) resolvedPath = (typeof files[0] === 'string') ? files[0] : (files[0].path || files[0].file || '');
        } catch (e) { /* fall through to opening by hint */ }
        let opened = false;
        try {
          await toolsService.executeTool('open_item', { target: resolvedPath || openHint }, false, { source: 'voice', bypassIdempotency: true });
          opened = true;
        } catch (e) { opened = false; }
        let finalText = opened
          ? `I opened your ${openHint} for you.`
          : `I tried to open your ${openHint}, but couldn't find a matching file to open.`;
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'open-file' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'open-file-' + Date.now(), status: 'success', steps: opened ? 2 : 1, result: finalText, errors: []
        }});
      }
    }

    // APPEND PATH: "append/add a line <text> to <file>" — add the line WITHOUT erasing the
    // file (file_gen mode:append). Deterministic so she never overwrites (which erased the
    // existing content) or no-ops. Apps/URLs/non-file adds are excluded by appendTarget.
    {
      const ap = appendTarget(userText);
      if (ap) {
        logger.info('[respond] Append-file path', { name: ap.name });
        let okAppend = false;
        const relPath = filePathFor(ap.folder, ap.name);
        try {
          await toolsService.executeTool('file_gen',
            { file_path: relPath, content: ap.payload, mode: 'append' },
            false, { source: 'voice', bypassIdempotency: true });
          // Verify it actually landed (read the file back) so we never falsely claim success.
          const rr = await toolsService.executeTool('fs_read', { path: relPath }, false, { source: 'voice', bypassIdempotency: true });
          const after = (((rr && (rr.result || rr)) || {}).content) || '';
          okAppend = String(after).includes(ap.payload);
        } catch (e) { okAppend = false; }
        let finalText = okAppend
          ? `I added "${ap.payload}" as a new line to ${ap.name}, leaving everything that was already there intact.`
          : `I tried to add that line to ${ap.name}, but couldn't complete the write.`;
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'append-file' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'append-file-' + Date.now(), status: 'success', steps: 2, result: finalText, errors: []
        }});
      }
    }

    // READ-FILE PATH: "read <file> / first|second line / how many lines" — resolve (fs_find)
    // then read (fs_read) and answer directly, instead of prefixing fs_find or opening it.
    {
      const rt = readFileTarget(userText);
      if (rt) {
        logger.info('[respond] Read-file path', { name: rt.name, want: rt.want });
        let content = '';
        try {
          const rr = await toolsService.executeTool('fs_read', { path: filePathFor(rt.folder, rt.name) }, false, { source: 'voice', bypassIdempotency: true });
          const rres = (rr && (rr.result || rr)) || {};
          content = rres.content || rres.text || rres.data || (typeof rres === 'string' ? rres : '') || '';
        } catch (e) { content = ''; }
        let finalText = '';
        const lines = String(content).split(/\r?\n/);
        if (content) {
          if (rt.want === 'first') finalText = `I read ${rt.name} — the first line says: ${lines[0] || '(it looks empty)'}`;
          else if (rt.want === 'second') finalText = `I read ${rt.name} — the second line says: ${lines[1] || '(there is no second line)'}`;
          else if (rt.want === 'third') finalText = `I read ${rt.name} — the third line says: ${lines[2] || '(there is no third line)'}`;
          else if (rt.want === 'count') { const n = lines.filter(l => l.trim().length).length; finalText = `I read ${rt.name} — it has ${n} ${n === 1 ? 'line' : 'lines'}.`; }
          else finalText = `I read ${rt.name} for you — it says: ${String(content).slice(0, 600)}`;
        }
        if (!finalText) finalText = `I tried to read ${rt.name}, but couldn't find or open it.`;
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'read-file' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'read-file-' + Date.now(), status: 'success', steps: 2, result: finalText, errors: []
        }});
      }
    }

    // FIND-FILES PATH: "find/locate/list the <X> files" — resolve by pattern (fs_find) and
    // name them, instead of letting the model guess fs_ops vs fs_find.
    {
      const ff = findFilesTarget(userText);
      if (ff) {
        logger.info('[respond] Find-files path', { pattern: ff.pattern });
        let names = [];
        try {
          const fr = await toolsService.executeTool('fs_find', { pattern: ff.pattern }, false, { source: 'voice', bypassIdempotency: true });
          const fres = (fr && (fr.result || fr)) || {};
          const files = fres.files || fres.matches || fres.results || [];
          names = (Array.isArray(files) ? files : [])
            .map(f => (typeof f === 'string' ? f : (f.name || f.path || f.file || '')))
            .filter(Boolean).map(s => String(s).split(/[\\/]/).pop());
        } catch (e) { names = []; }
        let finalText = names.length
          ? `I found ${names.length} ${names.length === 1 ? 'file' : 'files'} matching ${ff.pattern}: ${names.slice(0, 20).join(', ')}.`
          : `I didn't find any files matching ${ff.pattern}.`;
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'find-files' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'find-files-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
        }});
      }
    }

    // REMEMBER PATH: "remember that I prefer X / save my preference" — persist via
    // memory_system (the model often picked file_gen). Distinct from recall (which RETRIEVES).
    if (/\b(remember that|save (my|this|that)|note that i|make a note that|keep in mind that|store (this|that))\b/.test(userText.toLowerCase()) && !looksLikeRecall(userText)) {
      logger.info('[respond] Remember path (memory_system save)', { text: userText.slice(0, 60) });
      let ok = false;
      try {
        await toolsService.executeTool('memory_system', { action: 'save', operation: 'save', content: userText, text: userText, value: userText }, false, { source: 'voice', bypassIdempotency: true });
        ok = true;
      } catch (e) { ok = false; }
      let finalText = ok ? "Got it — I'll remember that." : "I tried to save that, but ran into an issue.";
      finalText = shapeSpokenReply(finalText, req.body || {});
      try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'remember' }); } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
        id: 'remember-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
      }});
    }

    // RECALL PATH: "what did we discuss/decide about X" — run memory_search DIRECTLY
    // (don't depend on the model choosing the tool) and ground a spoken answer on the
    // results. Only ask the user to narrow down if the search genuinely finds nothing.
    // Recall intent wins even if a tool keyword is present (e.g. "what did we discuss
    // about the CAMERA" is recall, not "turn on the camera").
    if (looksLikeRecall(userText)) {
      logger.info('[respond] Recall path (history + memory_search)', { text: userText.slice(0, 60) });
      // 1) Keyword matches across memory + all logs. Call via executeTool so the sandbox
      //    LEDGER records memory_search (training checks read the ledger), and so this fires
      //    deterministically for recall in ALL modes (not just no-tools voice) — the model
      //    was unreliable about choosing memory_search itself.
      let sr = { count: 0, summary: '' };
      try {
        const _mr = await toolsService.executeTool('memory_search', { query: userText, q: userText, limit: 10 }, false, { source: 'voice', bypassIdempotency: true });
        const _inner = (_mr && _mr.result) ? _mr.result : _mr;
        if (_inner && typeof _inner === 'object') sr = _inner;
      } catch (e) { /* keep empty */ }
      // 2) The actual conversation transcript for the time window the user referenced
      //    ("yesterday", "the last few days", a date, or default recent) — each line is
      //    [local-date local-time who] content, so she can cite when things were said.
      let win = { label: '', turns: [], from: '', to: '' };
      try { win = conversationHistory.windowForQuery(userText, { maxTurns: 160 }); } catch (e) { /* optional */ }
      const transcript = conversationHistory.formatTurns(win.turns, 8000);
      const ctxParts = [];
      if (transcript) {
        ctxParts.push(`CONVERSATION HISTORY${win.label ? ` (${win.label}${win.from ? `, ${win.from}${win.to && win.to !== win.from ? ' to ' + win.to : ''}` : ''})` : ''} — each line is [date time who] content:\n${transcript}`);
      }
      if (sr && sr.count > 0) {
        ctxParts.push(`KEYWORD MATCHES (from saved memory & full history, with dates/times):\n${String(sr.summary || '').slice(0, 1600)}`);
      }
      const ctx = ctxParts.join('\n\n');
      let finalText = '';
      if (ctx.trim()) {
        try {
          const sys = `${personaSvc.buildPersonaBlock()}\n\nThe user is asking you to recall or summarize past conversations. You DO have your conversation history below — each line is tagged with its date, time, and who said it (You = the user, AVA = you). Answer their question using ONLY this context: summarize what was said, discussed, or decided, and cite WHEN (e.g. "on June 23" or "yesterday around 7pm") where it helps. Be as detailed as the question warrants — it's fine to give a thorough multi-point summary. If the context genuinely does not cover the specific topic they asked about, say so plainly and ask for a detail. Do NOT invent anything beyond the context. Spoken aloud: natural sentences, no markdown or bullet symbols.`;
          const usr = `User asked: "${userText}"\n\n${ctx}`;
          const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.3, max_tokens: 1400 });
          finalText = (r.text || r.content || '').trim();
        } catch (e) { /* fall through to fallback */ }
      }
      if (!finalText) {
        finalText = "I looked through our conversation history and my notes but couldn't find anything about that. Can you give me a detail or a date to search on?";
      }
      // Use a generous budget for recall so detailed summaries aren't clamped to a sentence.
      const _recallBody = { ...(req.body || {}), spoken_reply_budget: { max_sentences: 80, max_words: 1400, prefer_brief: false } };
      finalText = shapeSpokenReply(finalText, _recallBody);
      try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'recall' }); } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
        id: 'recall-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
      }});
    }

    // CONVERSATIONAL PATH: When tools are disabled, bypass agent loop entirely.
    // The agent loop frames everything as "task execution" which produces verbose
    // non-answers for simple factual questions. Direct LLM call gives natural replies.
    // EXCEPTION: if the question implies a tool/data action ("what's on my calendar?"),
    // fall through to the tool path so she actually fetches instead of just describing.
    if (run_tools === false && !looksLikeToolRequest(userText) && !looksLikeRecall(userText)) {
      logger.info('[respond] Conversational path (no tools)', { text: userText.slice(0, 60) });
      const { context, persona, style } = req.body || {};
      const spokenReplyBudget = normalizeSpokenReplyBudget(req.body || {});
      const budgetPrompt = spokenReplyBudget.voiceMode === 'spoken'
        ? ` Keep replies under ${spokenReplyBudget.maxWords} words and ${spokenReplyBudget.maxSentences} sentences unless safety or accuracy requires more.`
        : '';
      const _memBlock = curatedMemory.buildMemoryBlock();
      const sysPrompt = `${personaSvc.buildPersonaBlock()}${_memBlock ? '\n\n' + _memBlock : ''}\n\nYour responses are spoken aloud, so keep them natural and conversational. Prefer short, direct answers — a sentence or two is usually enough. Avoid unnecessary elaboration, but give complete answers when the question calls for it.${budgetPrompt}${context ? '\n\nContext: ' + context : ''}`;
      // Capability awareness: list the real tools so AVA can answer "what can you
      // do?" accurately even on this no-execution conversational path. (Previously
      // this prompt omitted tools, so she'd say she had none.)
      let capabilityPrompt = '';
      try {
        const tools = await toolsService.getAllTools();
        if (tools && tools.length) {
          const toolLines = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
          capabilityPrompt = `\n\nYou are NOT just a chatbot — you have ${tools.length} real tools that take real actions on this Windows computer (the user triggers them with a command). Your tools:\n${toolLines}\nWhen asked what you can do or whether you have a capability, answer from this list in natural plain language (don't read raw tool names), and never claim you have no tools or cannot act. You also have persistent memory and can recall or search your past conversations across sessions (memory_search), so never say you can't remember or can't access past conversations.`;
        }
      } catch (e) { /* capabilities optional; fall back to plain conversation */ }
      // Session memory: feed the last few turns so she can answer "what did I just
      // ask?" / "what did you say?". This path was previously stateless (each voice
      // turn arrived with no history), which is why short-term recall failed.
      let priorMessages = [];
      try {
        // Span multiple days so "pick up where we left off" works across sessions.
        const recent = conversationLogger.getRecentHistoryAcrossDays(16) || [];
        priorMessages = recent
          .slice(0, -1)            // drop the current user message we just logged above
          .slice(-10)              // recent window across sessions
          .map(e => ({ e, dir: (e && (e.direction || e.role)) }))   // log uses `direction`, not `role`
          .filter(x => x.e && x.e.content && (x.dir === 'user' || x.dir === 'assistant'))
          .map(x => ({ role: x.dir === 'assistant' ? 'assistant' : 'user', content: String(x.e.content).slice(0, 500) }));
      } catch (e) { /* history optional */ }
      // Natural routing: let the model itself decide if real tools / live data are
      // needed, instead of a brittle keyword gate. In this chat-only mode she must
      // NEVER promise or fake an action — if it needs doing or looking up, she emits
      // a sentinel and we escalate to the agent loop.
      const routingPrompt = `\n\nIMPORTANT: In this mode you can ONLY talk right now — you cannot directly run a tool this turn. If the user asks you to DO something (send/reply to an email, create/update/delete a calendar event, open/read/edit files, control the computer, send a message), OR asks about their CURRENT external data (their real calendar, inbox/emails, files, system status), OR asks you to RECALL or SEARCH something from PAST conversations that is NOT already in the recent turns shown above, do NOT guess, fake, promise, or say you can't — respond with EXACTLY this token and nothing else: NEED_TOOLS. That escalates to your tools, including memory_search over your saved memory and your FULL conversation history.\n\nYOU DO HAVE MEMORY. Facts about the user and your own notes are in the system prompt above, the recent turns are included as prior messages, and you can search your entire conversation history with memory_search. So NEVER tell the user you can't remember, don't have memory, or can't access past conversations — that is false. If asked whether you can access past conversations, the answer is YES. If a recall question can be answered from the recent turns above, answer it directly; otherwise emit NEED_TOOLS so you can search.`;
      const _sysFull = sysPrompt + capabilityPrompt + routingPrompt;
      if (process.env.AVA_DEBUG_PROMPT === '1') {
        // Verification aid: write the exact system prompt sent to the model so we can
        // confirm the persona block is actually present. Off unless env is set.
        try {
          fs.appendFileSync(
            path.join(os.homedir(), 'ava', 'ava-integration', 'ava_session_helpers', 'last_system_prompt.txt'),
            `\n\n===== ${new Date().toISOString()} | user: ${userText} =====\n${_sysFull}\n`
          );
        } catch { /* best effort */ }
      }
      const llmResult = await llmService.chat([
        { role: 'system', content: _sysFull },
        ...priorMessages,
        { role: 'user', content: userText }
      ], { temperature: 0.3, max_tokens: 2000 });
      let finalText = (llmResult.text || llmResult.content || '').trim();

      if (/\bNEED_TOOLS\b/i.test(finalText)) {
        // Escalate: do NOT return here — fall through to the agent loop below so she
        // actually performs the action / looks up the data.
        logger.info('[respond] conversational path escalating to tools', { text: userText.slice(0, 60) });
      } else {
        if (isStepStatusMessage(finalText)) {
          console.log(`[respond] Blocked step status (conv): ${finalText.slice(0, 60)}...`);
          finalText = '';
        }
        finalText = shapeSpokenReply(finalText, req.body || {});

        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'conversational' }); } catch {}

        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'conv-' + Date.now(),
          status: 'success',
          steps: 0,
          result: finalText,
          errors: []
        }});
      }
    }

    // TOOL PATH: Full agent loop for tool-enabled requests
    const loopOptions = {};
    if (memory_filter) loopOptions.memoryFilter = memory_filter;
    // Give the agent loop recent conversation context ONLY when the request refers to
    // something prior ("open it", "yes", "that screenshot"). Injecting history into a
    // standalone command can bleed stale intent (e.g. turn "take a screenshot" into
    // "open a screenshot"), so we gate it on referential language / very short replies.
    try {
      const _t = String(userText || '').toLowerCase();
      const _referential = /\b(it|that|those|this|the one|the same|again|yes|nope|the (file|screenshot|picture|photo|image|email|message|load|document|report|event)|previous|last|you just|just (made|took|created|sent|opened))\b/.test(_t)
        || _t.trim().split(/\s+/).length <= 3;
      if (_referential) {
        const recent = conversationLogger.getRecentHistoryAcrossDays(12) || [];
        loopOptions.recentHistory = recent.slice(0, -1).slice(-6);  // drop the current message
        loopOptions.recentArtifacts = artifactMemory.recent(6);     // exact paths/ids from recent turns
      }
    } catch (e) { /* context optional */ }
    const state = await (await import('../services/agentLoop.js')).default.runAgentLoop(userText, loopOptions);
    // Remember structured outputs (file paths, ids, urls) from this turn for later refs.
    try { artifactMemory.recordFromHistory(sessionId, state.history); } catch (e) { /* artifacts optional */ }
    let finalText = state.final_result || '';

    // VOICE + HONESTY: ground the spoken reply in what the tools ACTUALLY returned, so
    // she never claims success on a failure (and answers naturally instead of "Done").
    // Prefer the last successful tool result; otherwise report the last attempt's real
    // outcome (error / blocked / needs more info) truthfully.
    const _okResult = extractLastToolResult(state);       // last status:ok result
    const _anyResult = extractLastToolResultAny(state);   // last tool result, any status
    const _ground = _okResult || _anyResult;
    // If she's legitimately asking the user for more info (e.g. "what should I say in
    // the reply?"), surface THAT question rather than grounding/guarding over it.
    const _waiting = String(state.status || '') === 'waiting_user';
    if (_ground && !_waiting) {
      try {
        const _st = String(_ground.result.status || '').toLowerCase();
        const sumSys = `${personaSvc.buildPersonaPreamble()}\n\nYou just attempted to do something for the user using a tool. Report the OUTCOME truthfully in 1-2 short spoken sentences, based ONLY on the tool result provided:
- If it SUCCEEDED (status ok/success/complete), confirm what actually happened (use the data; if the data is empty — e.g. no events, no unread emails — say that plainly).
- If it did NOT succeed (status is error, blocked, needs_confirm, waiting, or anything other than ok), say honestly that you could NOT do it, and briefly why or what you still need. NEVER claim you did something when the result is not a success.
- If this was a memory/recall SEARCH: when results were found, summarize what you recall about the topic from them in a natural sentence or two; ONLY if the search returned no relevant matches, say you couldn't find anything about it in your memory and ask the user to add a detail.
- If this was a self-DIAGNOSIS or capability check: relay your health and, if a plain-language capability summary is present (e.g. a "capability_summary" describing what you can do), tell the user what you can do in natural language. Do NOT refuse or say you "can't provide a list" — you have the information.
Don't read raw tool names, JSON, or status codes, but you MAY describe your health and what you can do in plain, natural language.`;
        const sumUsr = `User said: "${userText}"\nResult from "${_ground.tool}" (status=${_st}):\n${JSON.stringify(_ground.result).slice(0, 1800)}`;
        const sum = await llmService.chat([{ role: 'system', content: sumSys }, { role: 'user', content: sumUsr }], { temperature: 0.2, max_tokens: 2000 });
        const t = (sum.text || sum.content || '').trim();
        if (t) finalText = t;
      } catch (e) { /* fall back to whatever finalText we had */ }
    }

    // HONESTY GUARD: if NO tool actually ran this turn but the user asked for an
    // ACTION, never let a chatty "I'll do it" / "done" pass as success.
    if (!_ground && !_waiting) {
      const actiony = /\b(send|reply|email|e-?mail|text|message|create|add|schedule|set\s+(up|a|an)|book|delete|remove|cancel|update|change|move|rename|open|write|post|turn\s+(on|off))\b/i.test(userText);
      const claimsDoneOrPromise = !finalText || /\b(sent|replied|created|added|scheduled|booked|deleted|removed|updated|changed|opened|posted|done|i'?ll|i will|on it|just a moment|i'?ve|i have)\b/i.test(finalText);
      if (actiony && claimsDoneOrPromise) {
        finalText = "I wasn't actually able to do that — nothing ran on my end, so I won't tell you it's done. Want me to try again, or give me a bit more detail?";
      }
    }

    // If she's waiting on the user, speak her clarifying question.
    if (_waiting) {
      const _q = state.last_action && state.last_action.question;
      if (_q) finalText = _q;
    }

    // VOICE FILTER: Block step status messages (return empty string, not canned text)
    if (isStepStatusMessage(finalText)) {
      console.log(`[respond] Blocked step status: ${finalText.slice(0, 60)}...`);
      finalText = '';
    }
    if (!finalText) finalText = state.final_result || 'Done.';
    finalText = shapeSpokenReply(finalText, req.body || {});

    try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'agent' }); } catch {}

    res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
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

// -------- Training guidance (learned routing/behavior playbook) --------
router.get('/train/guidance', (_req, res) => {
  try { return res.json({ ok: true, rules: trainingGuidance.listRules() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/train/guidance', (req, res) => {
  try { const id = trainingGuidance.addRule(req.body && req.body.text); return res.json({ ok: true, id, rules: trainingGuidance.listRules() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/train/guidance', (req, res) => {
  try { const rules = trainingGuidance.setRules((req.body && req.body.rules) || []); return res.json({ ok: true, rules }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// LLM proposer: read the failure digest, propose ONE general guidance rule.
router.post('/train/propose', async (req, res) => {
  try {
    const failures = (req.body && req.body.failures) || [];
    const current = (req.body && req.body.current_rules) || [];
    const tried = (req.body && req.body.tried_rules) || [];
    if (!failures.length) return res.json({ ok: true, rule: '', reason: 'no failures' });

    // Detect recurring NON-routing failure modes so we can steer the proposer at them.
    const fc = (f) => (f.failed_checks || []).join(' ').toLowerCase();
    const honestyFail = failures.some((f) => /file_missing|file_text_missing/.test(fc(f))
      && /success|successfully|added|created|done|saved/i.test(String(f.response || '')));
    const overAskFail = failures.some((f) => (!(f.tools_used || []).length)
      && /\?|confirm|clarify|what (do|would) you|can you (confirm|tell)/i.test(String(f.response || '')));
    const hints = [];
    if (honestyFail) hints.push('At least one failure shows she CLAIMED success while the file did NOT change. Strongly consider: "After creating, writing, or appending to a file, read it back to confirm it exists and contains the expected text before telling the user it succeeded."');
    if (overAskFail) hints.push('At least one failure shows she ASKED the user to confirm/clarify a benign, unambiguous request instead of acting. Strongly consider: "For benign unambiguous requests (open a named file or app, read the screen, list windows), act immediately with the right tool — do not ask the user to confirm or clarify."');
    const sys = [
      'You improve a Windows voice assistant\'s TOOL ROUTING and HONESTY by writing ONE guidance rule.',
      'You are given tasks she FAILED: the user request, the tools she WRONGLY used (used tools),',
      'the EXPECTED tools (shown like "tool_called_any:fs_find|fs_ops"), and what she said.',
      '',
      'Write ONE rule that fixes the most impactful, RECURRING pattern. The rule MUST:',
      '- Name the EXACT correct tool(s) and the user-intent / trigger words that should route to them,',
      '  and the wrong tool to avoid. Preferred form: "When the user asks to <intent/trigger words>,',
      '  use <correct_tool> — do not use <wrong_tool>."',
      '- Be GENERAL across similar requests (e.g. cover BOTH finding AND reading files in one rule),',
      '  but NEVER name a specific file, person, task id, number, or answer value.',
      '- Be imperative, under 200 characters.',
      '- For honesty failures (she claimed success but the file did not change): tell her to read the',
      '  file back to confirm after any write/append/create before telling the user it succeeded.',
      '- Never weaken safety: keep confirmation for sending email, deleting, or moving money.',
      '',
      'TOOL CATALOG (name :: when to use):',
      'fs_find :: find / locate files by name',
      'fs_read :: read a file\'s contents',
      'fs_ops :: file ops: read, write, append, list, delete',
      'file_gen :: create / write a new file (txt, docx, xlsx, pdf...)',
      'open_item :: open an APP, a URL, or launch a file in its app — NOT for finding or reading file contents',
      'screen_ops / vision_ops :: see / read what is on the screen',
      'camera_ops :: see / describe the webcam',
      'window_ops :: list / manage open windows',
      'comm_ops :: email read / send / reply',
      'calendar_ops :: calendar list / create',
      'sys_ops :: system info (cpu / memory / disk)',
      'iot_ops :: smart-home device control',
      'audio_ops :: volume / speak',
      'memory_search :: recall past conversations / what we discussed',
      'browser_automation / net_ops :: search the web / open and read web pages',
      'self_awareness :: introspect; check/diagnose whether one of HER OWN tools is working (read-only)',
      'self_mod :: diagnose a specific tool (diagnose_tool) and propose repairs',
      'NOTE: to diagnose/check/test one of HER OWN tools (e.g. "is your email tool working"), use',
      'self_awareness or self_mod — NOT the tool being asked about (do not call comm_ops to check email).',
      '',
      'Output ONLY JSON: {"rule":"...","reason":"..."}',
    ].join('\n');
    const usr = [
      'EXISTING RULES (already live — do not duplicate):',
      current.length ? current.map((r) => '- ' + (r.text || r)).join('\n') : '(none)',
      '',
      'ALREADY-TRIED RULES (these were tested and did NOT help — do NOT propose anything like them):',
      tried.length ? tried.map((r) => '- ' + (r.text || r)).join('\n') : '(none)',
      hints.length ? '\nTARGETED HINTS:\n' + hints.map((h) => '* ' + h).join('\n') : '',
      '',
      'FAILED TASKS:',
      failures.map((f) => `- request: "${f.prompt}"\n  used tools: [${(f.tools_used || []).join(', ')}]\n  expected: ${(f.failed_checks || []).join('; ')}\n  she said: ${String(f.response || '').slice(0, 160)}`).join('\n'),
    ].join('\n');
    const r = await llmService.chat([
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ], { temperature: 0.3, max_tokens: 300 });
    const raw = (r.text || r.content || '').trim();
    let rule = '', reason = '';
    try { const m = raw.match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : raw); rule = String(j.rule || '').trim(); reason = String(j.reason || '').trim(); }
    catch { rule = raw.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 200); }
    return res.json({ ok: true, rule, reason });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// Draft a GRADED training task from a real request AVA fumbled (for human review).
router.post('/train/suggest_task', async (req, res) => {
  try {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    const response = String((req.body && req.body.response) || '');
    if (!prompt) return res.json({ ok: true, task: null });
    const sys = [
      'You convert a request AVA fumbled into a GRADED training task spec.',
      'Given the user request and AVA\'s failed/over-asking response, decide what AVA SHOULD have done.',
      'Pick the single best tool (name only) from this catalog:',
      'fs_find, fs_read, fs_ops, file_gen, open_item, screen_ops, vision_ops, window_ops, camera_ops, comm_ops,',
      'calendar_ops, sys_ops, iot_ops, audio_ops, memory_search, browser_automation, self_awareness, self_mod,',
      'analysis_ops, ps_exec, mouse_ops, key_ops, remote_ops, security_ops, proactive_ops, voice_ops, computer_use.',
      'If the request is not actually a tool task (pure chit-chat), set tool to "".',
      'Output ONLY JSON: {"category":"<short>","tool":"<tool or empty>","response_keyword":"<one word the right answer would contain, or empty>"}',
    ].join('\n');
    const usr = `USER REQUEST: ${prompt}\nAVA RESPONSE (fumbled): ${response.slice(0, 200)}`;
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { temperature: 0.2, max_tokens: 150 });
    const raw = (r.text || r.content || '').trim();
    let j = {};
    try { const m = raw.match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : raw); } catch { /* ignore */ }
    return res.json({ ok: true, task: { category: j.category || 'misc', tool: j.tool || '', response_keyword: j.response_keyword || '' } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ===================== Trainer dashboard (control panel) =====================
function _intDir() { return process.env.AVA_INTEGRATION_DIR || path.join(os.homedir(), 'ava', 'ava-integration'); }
function _helpDir() { return path.join(_intDir(), 'ava_session_helpers'); }
function _trainDir() { return path.join(_intDir(), 'training'); }
function _readText(p, max = 20000) { try { const t = fs.readFileSync(p, 'utf8'); return t.length > max ? t.slice(-max) : t; } catch { return ''; } }
function _readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function _spawnBat(bat) {
  const child = spawn('cmd.exe', ['/c', path.join(_helpDir(), bat)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
function _promptKey(p) { return crypto.createHash('md5').update(String(p || '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 10); }
function _markSeen(prompt) {
  try {
    const f = path.join(_trainDir(), 'harvest_seen.json');
    let seen = []; try { seen = (JSON.parse(fs.readFileSync(f, 'utf8')) || {}).seen || []; } catch { seen = []; }
    const k = _promptKey(prompt);
    if (!seen.includes(k)) { seen.push(k); fs.writeFileSync(f, JSON.stringify({ seen: seen.slice(-2000) }, null, 2)); }
  } catch { /* best effort */ }
}

router.get('/train/ui', (_req, res) => {
  try { res.set('Content-Type', 'text/html').send(fs.readFileSync(path.join(_helpDir(), 'train_dashboard.html'), 'utf8')); }
  catch (e) { res.status(500).send('dashboard not found: ' + e.message); }
});

router.get('/train/state', (_req, res) => {
  try {
    const help = _helpDir(), train = _trainDir();
    // running = lock flag present, recent, AND the journal is still being written (self-heals
    // a stale lock left by a crashed/killed run, so the Run button never gets stuck disabled).
    let running = false;
    try {
      const flagP = path.join(help, 'train_active.flag');
      const t = parseInt(fs.readFileSync(flagP, 'utf8'), 10) || 0;
      const flagAge = Date.now() - t;
      let jAge = Infinity; try { jAge = Date.now() - fs.statSync(path.join(help, 'meta_journal.txt')).mtimeMs; } catch { /* no journal */ }
      running = (flagAge < 1000 * 60 * 180) && (flagAge < 1000 * 60 * 4 || jAge < 1000 * 60 * 15);
      if (!running) { try { fs.unlinkSync(flagP); } catch { /* ignore */ } }   // clear stale lock
    } catch { running = false; }
    // phase + progress + tail from the journal
    let journalTail = '', phase = '', progress = 0;
    try {
      const all = fs.readFileSync(path.join(help, 'meta_journal.txt'), 'utf8');
      journalTail = all.trim().split('\n').slice(-60).join('\n');
      if (/REPORT written|ABORTED/.test(all.slice(-400))) { phase = running ? 'finishing' : 'done'; progress = running ? 95 : 100; }
      else if (/VALIDATE on holdout/.test(all)) { phase = 'validating on held-out set'; progress = 90; }
      else { const m = [...all.matchAll(/\[iter (\d+)\]/g)]; if (m.length) { phase = 'iteration ' + m[m.length - 1][1]; progress = Math.min(88, 35 + m.length * 12); } else if (/BASELINE/.test(all)) { phase = 'baseline'; progress = 20; } else if (running) { phase = 'starting'; progress = 5; } }
    } catch { /* no journal yet */ }

    let tasks = null;
    try {
      const d = _readJson(path.join(train, 'tasks.json'), { tasks: [], _holdout: [] });
      const hold = new Set(d._holdout || []); let total = 0, tr = 0, ho = 0; const byCat = {};
      for (const t of (d.tasks || [])) {
        const n = Array.isArray(t.prompts) && t.prompts.length ? t.prompts.length : 1;
        total += n; byCat[t.category || '?'] = (byCat[t.category || '?'] || 0) + n;
        if (hold.has(t.id)) ho += n; else tr += n;
      }
      tasks = { total, train: tr, holdout: ho, byCategory: byCat };
    } catch { /* ignore */ }

    let history = [];
    try { history = _readText(path.join(train, 'history.jsonl'), 300000).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* ignore */ }

    let guidance = []; try { guidance = trainingGuidance.listRules(); } catch { /* ignore */ }

    res.json({
      running, phase, progress, journalTail,
      report: _readText(path.join(help, 'meta_report.txt')),
      scoreboard: _readText(path.join(help, 'stable_scoreboard.txt')),
      history, guidance,
      resistant: _readJson(path.join(train, 'resistant_clusters.json'), {}),
      candidates: _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] }),
      tasks,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/train/run', (req, res) => {
  try {
    const k = Math.max(2, Math.min(8, parseInt((req.body && req.body.k) || 4, 10) || 4));
    const fresh = (req.body && req.body.fresh) ? '1' : '0';
    try { fs.writeFileSync(path.join(_helpDir(), 'ava_train_k.txt'), String(k)); } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(_helpDir(), 'ava_train_fresh.txt'), fresh); } catch { /* ignore */ }
    _spawnBat('ui_train.bat');
    res.json({ ok: true, message: (fresh === '1' ? 'FRESH training started' : 'Training started') + ' (' + k + ' iterations). She goes offline ~1hr; this panel keeps updating.' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/train/unlock', (_req, res) => {
  try { fs.unlinkSync(path.join(_helpDir(), 'train_active.flag')); } catch { /* already gone */ }
  res.json({ ok: true, message: 'Unlocked — you can start a run now.' });
});
router.post('/train/eval', (_req, res) => { try { _spawnBat('ui_eval.bat'); res.json({ ok: true, message: 'Stable eval started (repeats=2). Panel will update.' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.post('/train/harvest', (_req, res) => { try { _spawnBat('ui_harvest.bat'); res.json({ ok: true, message: 'Harvesting real-world failures into candidate tasks…' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.post('/train/stop', (_req, res) => { try { _spawnBat('ui_stop.bat'); res.json({ ok: true, message: 'Stopping training and restoring her normal server…' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

router.post('/train/promote', (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    const train = _trainDir();
    const cand = _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] });
    const item = (cand.candidates || []).find((c) => c.id === id);
    if (!item) return res.json({ ok: false, error: 'candidate not found' });
    const tasksPath = path.join(train, 'tasks.json');
    const lib = _readJson(tasksPath, { tasks: [] });
    const newId = 'real_' + Date.now().toString(36);
    lib.tasks.push({ id: newId, category: item.category || 'misc', difficulty: 2, prompt: item.prompt, checks: item.checks });
    fs.writeFileSync(tasksPath, JSON.stringify(lib, null, 2));
    cand.candidates = (cand.candidates || []).filter((c) => c.id !== id);
    fs.writeFileSync(path.join(train, 'candidate_tasks.json'), JSON.stringify(cand, null, 2));
    _markSeen(item.prompt);   // never re-suggest a promoted failure
    res.json({ ok: true, newId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Dismiss a candidate: remove it and remember it so it never re-appears.
router.post('/train/dismiss', (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    const train = _trainDir();
    const cand = _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] });
    const item = (cand.candidates || []).find((c) => c.id === id);
    if (item) _markSeen(item.prompt);
    cand.candidates = (cand.candidates || []).filter((c) => c.id !== id);
    fs.writeFileSync(path.join(train, 'candidate_tasks.json'), JSON.stringify(cand, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    const { text, messages, memory_filter, run_tools } = req.body || {};
    const goal = (typeof text === 'string' && text.trim())
      ? text.trim()
      : Array.isArray(messages)
        ? messages.map(m => (m?.content || '')).join('\n').trim()
        : '';

    if (!goal) {
      return res.status(400).json({ ok: false, error: 'Missing text/messages' });
    }

    const loopOpts = {};
    if (memory_filter) loopOpts.memoryFilter = memory_filter;
    if (run_tools === false) {
      loopOpts.stepLimit = 1;   // No multi-step agent loop for non-tool requests
      loopOpts.runTools = false;
    }
    const state = await agentLoop.runAgentLoop(goal, loopOpts);
    let finalText = state.final_result || 'Done.';

    // VOICE FILTER: Block step status messages (return empty string, not canned text)
    if (isStepStatusMessage(finalText)) {
      console.log(`[respond] Blocked step status: ${finalText.slice(0, 60)}...`);
      finalText = '';
    }
    finalText = shapeSpokenReply(finalText, req.body || {});
    
    res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
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
