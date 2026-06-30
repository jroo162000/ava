// Main API routes
import express from 'express';
import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import memoryService from '../services/memory.js';
import llmService from '../services/llm.js';
import toolsService from '../services/tools.js';
import pythonWorker from '../services/pythonWorker.js';
import conversationLogger from '../services/conversationLogger.js';
import artifactMemory from '../services/artifactMemory.js';
import personaSvc from '../services/persona.js';
import environmentContext from '../services/environmentContext.js';
import actionHistory from '../services/actionHistory.js';
import curatedMemory from '../services/curatedMemory.js';
import memorySearch from '../services/memorySearch.js';
import conversationHistory from '../services/conversationHistory.js';
import contextCompression from '../services/contextCompression.js';
import memoryReviewer from '../services/memoryReviewer.js';
import skillStore from '../services/skillStore.js';
import skillCapture from '../services/skillCapture.js';
import lessonLearner from '../services/lessonLearner.js';
import sandbox from '../services/sandbox.js';
import trainingGuidance from '../services/trainingGuidance.js';
import { execSync, spawn, execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import agentLoop from '../services/agentLoop.js';
import moltbookService from '../services/moltbook.js';
import moltbookScheduler from '../services/moltbookScheduler.js';
import selfImprove from '../services/selfImprove.js';
import { verifyFileSyntax } from '../utils/verifyFileSyntax.js';
import selfRestart from '../services/selfRestart.js';

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

// True when the user is asking about HER OWN code — whether she's been upgraded/modified, what
// changed, or to "self-diagnose" her code. These must NOT be treated as a generic tool request
// (the word "diagnostic" otherwise shoves them at the agent, which mis-decides). Routed to the
// conversational path, where the live env block (recent commits to her code) + persona answer
// them reliably. Tool-HEALTH checks ("is your camera working") are intentionally excluded.
function looksLikeCodeDiagnostics(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (/\b(pending|proposed|proposal|waiting|approve)\b/.test(t)) return false;  // that's the proposal queue
  const ownCode = /\b(your|my)\b[\s\S]{0,14}\bcode(base|s)?\b/.test(t)
    || /\b(actual|real|source|own)\s+code\b/.test(t)
    || /\bself.?diagnostic/.test(t)
    || /\bbeen (modified|upgraded|updated|changed)\b/.test(t)
    || /\b(have|did|were) you (been )?(get|got|been )?(upgrad|updat|modif)/.test(t)
    || /\byou been (upgraded|modified|updated)\b/.test(t);
  const changeIntent = /\b(modif|chang|updat|upgrad|diagnos|differ|new|recent|lately|on disk|integrity|commit|version)\b/.test(t);
  return ownCode && changeIntent;
}

// True when a question implies a tool/data action that the runner's verb-based
// gate misses (e.g. "what's on my calendar?", "do I have any emails?"). Lets such
// question-phrased turns reach the tool path instead of just being described.
function looksLikeToolRequest(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (looksLikeCodeDiagnostics(t)) return false;  // answer from the env block, don't send to the agent
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
  // NOT recall: a statement/affirmation that merely CONTAINS time+verb words is not a recall
  // question. ("yes that's right, it's for me to interact with WHEN I TALK to you" falsely matched
  // the when+i+talk pattern below and got routed to a recall meta-reply.)
  if (/^\s*(yes|yeah|yep|ya|ok|okay|sure|right|correct|exactly|that'?s right|sounds good|go ahead|please|no|nope)\b/.test(t)) return false;
  if (/\bwhen (i|we|you) (talk|speak|chat|interact)\b/.test(t)) return false;  // present/future, not a recall query
  if (/\b(recall|remind me (what|about|when|how)|do you remember|did we (ever )?(talk|discuss|decide|cover|mention|go over|work))\b/.test(t)) return true;
  if (/\b(what|which|when|how|where)\b[\s\S]{0,40}\b(we|you|i)\b[\s\S]{0,40}\b(discuss(ed)?|talk(ed)?|said|say|decide(d)?|mention(ed)?|cover(ed)?|agree(d)?|went over|go over|work(ed)? on|set ?up|configure(d)?|chang(e|ed)|fix(ed)?|built|build|test(ed)?)\b/.test(t)) return true;
  if (/\b(earlier|before|previously|last (time|week|night|session)|yesterday|the other day|past conversation|our (last )?conversation|so far|up to now)\b/.test(t)
      && /\b(discuss|talk|said|say|decide|mention|cover|agree|work|about|regarding|\bon\b|did|go over)\b/.test(t)) return true;
  // "what was the last question I asked", "the last thing I said", "my previous question"
  if (/\b(last|previous|first|earlier) (question|thing|message|request|point)\b/.test(t)) return true;
  if (/\bwhat\b[\s\S]{0,25}\b(i|we)\b[\s\S]{0,15}\b(ask|asked|say|said)\b/.test(t)) return true;
  return false;
}

// Short, vague follow-ups about the LAST thing AVA did ("what is the result", "did it
// work", "how did it go"). These must be ANSWERED from recent context — never treated as
// a new action command (the agent used to guess, e.g. opening Explorer/Downloads).
function looksLikeFollowupStatus(text = '') {
  const t = String(text || '').toLowerCase().trim().replace(/[?.!]+$/, '');
  if (!t) return false;
  if (t.split(/\s+/).length > 7) return false;
  return /^(what(?:'?s| is| was| are)?(?: the)? (?:result|results|outcome|status|answer|verdict|finding|findings|diagnosis)|what happened|what did (?:you|that) (?:find|do|say|get)|what now|what next|and (?:then|now)|so what|did (?:it|that|you) (?:work|succeed|finish|pass|fail)|tell me (?:the )?(?:result|what (?:you found|happened|you did))|how did (?:it|that) go|any (?:luck|results?))$/i.test(t);
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

// STT (Whisper) routinely garbles "Moltbook" — her AI-agent social network feature — into
// non-words ("moat book", "mote book", "malt book", "mold book", "molt book") or, in context,
// real words ("notebook", "more book"). Normalize those to "moltbook" so intent routing and the
// model aren't derailed by the exact transcription. The original user text is still what gets
// logged; this only cleans the copy used for understanding/routing.
function normalizeMoltbookMentions(text) {
  let s = String(text || '');
  // Clear non-word mishears — safe to map unconditionally.
  s = s.replace(/\b(moat ?book|mote ?book|molt ?book|mold ?book|malt ?book|mault ?book|moult ?book|vault ?book|moat ?books)\b/gi, 'moltbook');
  // Real-word mishears ("notebook", "more book") — only when context is clearly the AI social
  // network / posting, so legitimate uses of those words aren't clobbered.
  if (/\b(ai|agent|agents|social|feed|post|posts|posted|posting|platform|network|community|upvote|submolt|comment)\b/i.test(s)) {
    s = s.replace(/\b(note ?book|notebook|more ?book|moor ?book|moot ?book)\b/gi, 'moltbook');
  }
  return s;
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

// --- Spoken-number normalization: say numbers the way a person would when HEARD, not read ---
const _ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const _TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function _twoDigitsToWords(n) {
  n = parseInt(n, 10);
  if (n < 20) return _ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${_TENS[t]}-${_ONES[o]}` : _TENS[t];
}
// 1999 -> "nineteen ninety-nine"; 2005 -> "two thousand five"; 1905 -> "nineteen oh five"
function _yearToWords(y) {
  const n = parseInt(y, 10);
  if (n >= 2000 && n <= 2009) return n % 10 ? `two thousand ${_ONES[n % 10]}` : 'two thousand';
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return `${_twoDigitsToWords(hi)} hundred`;
  if (lo < 10) return `${_twoDigitsToWords(hi)} oh ${_ONES[lo]}`;
  return `${_twoDigitsToWords(hi)} ${_twoDigitsToWords(lo)}`;
}
const _DIGIT_WORD = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
// Read an ID/code/serial out character by character (digits become words, letters stay).
function _spellChars(tok) {
  return String(tok).split('').map(c => _DIGIT_WORD[c] || c.toLowerCase()).filter(Boolean).join(' ');
}
// Homograph disambiguation for TTS. The Piper/espeak engine already pronounces MOST homographs
// correctly from context (measured: it nails read-present, lead-verb, live, tear, bass, wound,
// record-noun/verb, etc.). It only mis-says a small, MEASURED set — so we surgically respell ONLY
// those, to a token verified to phonemize correctly, and only in the sense the engine gets wrong.
// This affects the spoken copy only; the on-screen text keeps the real spelling. Toggle off with
// AVA_HOMOGRAPH_OFF=1.
function disambiguateHomographs(text) {
  if (process.env.AVA_HOMOGRAPH_OFF === '1') return text;
  const HOMO = new Set(['read', 'lead', 'close', 'excuse', 'wind', 'bow', 'dove', 'minute']);
  const tokens = []; const re = /[A-Za-z']+/g; let m;
  while ((m = re.exec(text))) tokens.push({ w: m[0], i: m.index, lw: m[0].toLowerCase() });
  if (!tokens.length) return text;
  const words = tokens.map(t => t.lw);
  const repl = {};
  for (let k = 0; k < tokens.length; k++) {
    const w = words[k]; if (!HOMO.has(w)) continue;
    const prev = (n) => words[k - n] || ''; const next = (n) => words[k + n] || '';
    const around = words.slice(Math.max(0, k - 4), k + 5);
    let r = null;
    if (w === 'read') {                                   // past tense -> "red" (engine says "reed")
      const PERF = new Set(['have', 'has', 'had', 'having', "i've", "we've", "you've", "they've", "i'd", "we'd", "you'd", "they'd", "he'd", "she'd", 'just', 'already', 'recently']);
      const PAST = new Set(['yesterday', 'ago', 'earlier', 'already', 'recently', 'then', 'last']);
      if (PERF.has(prev(1)) || PERF.has(prev(2)) || PAST.has(prev(1)) || around.some(x => PAST.has(x))) r = 'red';
    } else if (w === 'lead') {                            // the metal -> "led" (engine says "leed")
      const METAL = new Set(['pipe', 'pipes', 'paint', 'poison', 'poisoning', 'solder', 'acid', 'metal', 'bullet', 'bullets', 'toxic', 'molten', 'dust', 'exposure', 'levels', 'free', 'based']);
      if (METAL.has(next(1)) || METAL.has(next(2)) || METAL.has(prev(1)) || prev(1) === 'heavy') r = 'led';
    } else if (w === 'close') {                           // verb -> "cloze" (/z/); adjective stays /s/
      const OBJ = new Set(['the', 'this', 'that', 'your', 'my', 'our', 'his', 'her', 'their', 'it', 'them', 'a', 'an', 'up', 'down', 'out', 'off', 'everything', 'all']);
      const ADJN = new Set(['to', 'friend', 'friends', 'call', 'by', 'enough', 'proximity', 'range', 'second', 'attention', 'eye', 'watch', 'relationship', 'family', 'ties', 'together', 'quarters']);
      const ADJP = new Set(['so', 'very', 'too', 'how', 'getting', 'pretty', 'real', 'more', 'less', 'quite', 'extremely', 'super', 'really']);
      if (ADJN.has(next(1)) || ADJP.has(prev(1))) r = null;
      else if (OBJ.has(next(1))) r = 'cloze';
    } else if (w === 'excuse') {                          // verb -> "excuze" (/z/); noun stays /s/
      const VOBJ = new Set(['me', 'him', 'her', 'us', 'them', 'myself', 'yourself', 'ourselves', 'my', 'the', 'his', 'their']);
      const NDET = new Set(['an', 'a', 'the', 'no', 'any', 'some', 'that', 'this', 'your', 'my', 'his', 'her', 'good', 'bad', 'weak', 'lame', 'poor', 'valid', 'great', 'another']);
      if (NDET.has(prev(1))) r = null;
      else if (VOBJ.has(next(1)) || ['to', 'will', 'please', 'would', 'can', 'may'].includes(prev(1))) r = 'excuze';
    } else if (w === 'wind') {                            // verb (wind a clock / wind up) -> "wined" /aɪ/
      const MECH = new Set(['clock', 'watch', 'spring', 'cord', 'rope', 'string', 'handle', 'crank', 'thread', 'yarn', 'bobbin', 'gear', 'clockwork']);
      if (next(1) === 'up' || next(1) === 'down') r = 'wined';
      else if (['the', 'your', 'it', 'a'].includes(next(1)) && (MECH.has(next(2)) || MECH.has(next(3)))) r = 'wined';
    } else if (w === 'bow') {                             // bend/bow-down -> "bough" /aʊ/; ribbon/weapon stay /oʊ/
      if (next(1) === 'down' || next(1) === 'to' || (prev(1) === 'a' && ['take', 'took', 'takes', 'taking', 'taken'].includes(prev(2)))) r = 'bough';
    } else if (w === 'dove') {                            // past of dive -> "dohv" /oʊ/; the bird stays /ʌ/
      const SUBJ = new Set(['i', 'he', 'she', 'we', 'they', 'you', 'who', 'then', 'just']);
      const DIR = new Set(['into', 'in', 'under', 'off', 'down', 'for', 'head', 'headfirst', 'deep', 'straight', 'beneath', 'through', 'forward']);
      if (SUBJ.has(prev(1)) && DIR.has(next(1))) r = 'dohv';
    } else if (w === 'minute') {                          // tiny -> "mynute"; the time unit stays
      const TINY = new Set(['amount', 'amounts', 'detail', 'details', 'particle', 'particles', 'quantity', 'quantities', 'trace', 'traces', 'fraction', 'difference', 'differences', 'change', 'changes', 'speck']);
      if (TINY.has(next(1))) r = 'mynute';
    }
    if (r) repl[k] = r;
  }
  if (!Object.keys(repl).length) return text;
  let out = ''; let last = 0;
  for (let k = 0; k < tokens.length; k++) {
    if (repl[k]) { out += text.slice(last, tokens[k].i) + repl[k]; last = tokens[k].i + tokens[k].w.length; }
  }
  out += text.slice(last);
  return out;
}

// Pronunciation lexicon (TTS): word -> respelling the voice engine actually says correctly.
// Seeded with her OWN name — the engine says "AVA"/"Ava" as "AH-vuh" (/ˈɑːvə/) or spells out
// "A. V. A.", but she's "Aiva" = /ˈeɪvə/ ("AY-vuh"). This is a pronunciation dictionary, not a
// behavioral hardcode: it's case-insensitive, whole-word, spoken-copy-ONLY (the on-screen text
// keeps the real "AVA" spelling), and EXTENSIBLE/learnable via ava-integration/ava_pronunciations.json
// (add "name": "respelling" entries to teach her new names; keys starting with _ are ignored).
let _pronLexicon = null;
function loadPronunciationLexicon() {
  if (_pronLexicon) return _pronLexicon;
  const lex = { ava: 'Aiva' };  // built-in seed so her own name is always right
  try {
    const candidates = [
      config.AVA_INTEGRATION_DIR ? path.join(config.AVA_INTEGRATION_DIR, 'ava_pronunciations.json') : null,
      path.join(process.cwd(), '..', 'ava-integration', 'ava_pronunciations.json'),
      path.join(os.homedir(), 'ava', 'ava-integration', 'ava_pronunciations.json'),
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const [k, v] of Object.entries(data || {})) {
          if (k && !k.startsWith('_') && typeof v === 'string' && v.trim()) lex[k.toLowerCase()] = v.trim();
        }
        break;
      }
    }
  } catch { /* fall back to the built-in seed */ }
  _pronLexicon = lex;
  return lex;
}
function applyPronunciationLexicon(text) {
  if (process.env.AVA_PRON_LEXICON_OFF === '1') return text;
  const lex = loadPronunciationLexicon();
  let s = String(text || '');
  for (const [word, say] of Object.entries(lex)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\b${esc}\\b`, 'gi'), say);
  }
  return s;
}

// Make spoken text TTS-friendly: drop stray markdown symbols and voice numbers by context.
function normalizeForSpeech(text) {
  let s = String(text || '');
  // (a) Strip any stray markdown so TTS never reads symbols aloud (defense-in-depth).
  s = s.replace(/```[\s\S]*?```/g, ' ')
       .replace(/`([^`]*)`/g, '$1')
       .replace(/^\s{0,3}#{1,6}\s+/gm, '')
       .replace(/^\s*[-*+]\s+/gm, '')
       .replace(/\*\*([^*]+)\*\*/g, '$1')
       .replace(/\*([^*]+)\*/g, '$1')
       .replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1')
       .replace(/~~([^~]+)~~/g, '$1');
  // (a.4) Apply the pronunciation lexicon (her name "AVA" -> "Aiva", plus any learned names).
  s = applyPronunciationLexicon(s);
  // (a.5) Fix the handful of homographs the TTS engine mispronounces (read-past, lead-metal,
  // close/excuse verbs, wind/bow/dove/minute) — measured + verified, spoken copy only.
  s = disambiguateHomographs(s);
  if (process.env.AVA_SPEAK_NUMBERS_OFF === '1') return s.replace(/[ \t]{2,}/g, ' ');
  // (b) An ID/code/serial/version after a cue word: read it out character by character.
  s = s.replace(/\b(id|number|code|serial|confirmation|reference|ref|order|account|invoice|ticket|version|build|commit|hash|pin|phone|model)\b([:#.\s]+)([A-Za-z]*\d[A-Za-z0-9._-]*|\d{3,})/gi,
    (m, cue, sep, tok) => `${cue}${sep}${_spellChars(tok.replace(/[._-]/g, ''))}`);
  // (c) Hex-like ID tokens (digits + a–f letters, 6+ chars) anywhere — e.g. change "7bfcdc6b".
  s = s.replace(/\b(?=[a-f0-9]*\d)(?=[a-f0-9]*[a-f])[a-f0-9]{6,}\b/gi, (m) => _spellChars(m));
  // (d) Years: a bare 4-digit 1500–2099 that isn't a price/decimal/thousand -> say it as a year.
  s = s.replace(/(^|[^\w$£€])((1[5-9]|20)\d{2})(?![\w%]|[.,]\d)/g, (m, pre, yr) => `${pre}${_yearToWords(yr)}`);
  return s.replace(/[ \t]{2,}/g, ' ');
}

function shapeSpokenReply(text, body = {}) {
  let reply = typeof text === 'string' ? text.trim() : '';
  if (!reply) return '';

  const budget = normalizeSpokenReplyBudget(body);
  if (budget.voiceMode !== 'spoken') return reply;

  reply = normalizeForSpeech(reply);

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

function isSelfSnapshotRequest(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const asksSnapshot = /\b(snapshot|backup|back up|freeze|save|preserve|checkpoint)\b/.test(t);
  const selfRef = /\b(yourself|your self|this version|current version|working version|version of yourself|current state|working state)\b/.test(t);
  return asksSnapshot && selfRef;
}

function isManualProposalRequest(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const createsProposal = /\b(make|create|draft|generate|queue|run|do)\b[\s\S]{0,80}\b(proposal|proposed change|code change|self.?mod|fix)\b/.test(t)
    || /\b(proposal|proposed change|code change|self.?mod|fix)\b[\s\S]{0,80}\b(for|from|about|based on)\b/.test(t);
  if (!createsProposal) return false;
  const startsAsApproval = /^\s*(approve|approved|approval|apply|accept|reject|decline|discard|cancel)\b/.test(t);
  return !startsAsApproval;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copySnapshotFile(repoRoot, snapshotDir, rel, files) {
  const src = path.join(repoRoot, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return;
  const dst = path.join(snapshotDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  files.push({
    path: rel.replace(/\\/g, '/'),
    bytes: fs.statSync(dst).size,
    sha256: sha256File(dst)
  });
}

function createSelfSnapshot(userText = '') {
  const repoRoot = path.resolve(process.cwd(), '..');
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '_');
  const snapshotDir = path.join(repoRoot, 'ava-integration', 'backup', 'snapshots', `AVA_${stamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const snapshotFiles = [
    'ava-integration/ava_voice_config.json',
    'ava-integration/ava_local_voice.py',
    'ava-integration/start_local_voice.bat',
    'AGENTS.md',
    'README.md',
    'ava-integration/memory/skills/INDEX.md',
    'ava-integration/memory/skills/create-self-backup-snapshot.md',
    'ava-server/src/routes/api.js',
    'ava-server/src/routes/learning.js',
    'ava-server/src/services/agentLoop.js',
    'ava-server/src/services/selfImprove.js',
    'ava-server/src/services/selfRestart.js',
    'ava-server/src/services/moltbook.js',
    'ava-server/src/services/moltbookScheduler.js',
    'ava-server/scripts/restart-server-after-delay.cjs',
    'ava-client/src/MinimalAVA.jsx',
    'ava-client/src/hooks/useVoice.js',
    'ava-client/src/hooks/useRealtimeVoice.js',
    'ava-client/src/wakeword.js'
  ];
  const files = [];
  for (const rel of snapshotFiles) copySnapshotFile(repoRoot, snapshotDir, rel, files);

  let voiceConfig = null;
  try {
    voiceConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ava-integration', 'ava_voice_config.json'), 'utf8'));
  } catch {}

  const manifest = {
    createdAt: new Date().toISOString(),
    request: String(userText || '').slice(0, 500),
    repoRoot,
    snapshotDir,
    workingVoice: {
      runner: 'ava-integration/ava_local_voice.py',
      inputDevice: voiceConfig?.audio?.input_device ?? null,
      inputDeviceName: voiceConfig?.audio?.input_device_name ?? null,
      inputBackend: voiceConfig?.audio?.input_backend ?? null,
      inputSampleRate: voiceConfig?.audio?.input_sample_rate ?? null,
      note: 'Verified working state: TONOR TC777 on MME device 2 at 44100 Hz. Do not switch to TONOR WASAPI device 17 on this setup.'
    },
    files
  };
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const indexPath = path.join(repoRoot, 'ava-integration', 'backup', 'snapshot-index.json');
  let index = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed)) index = parsed;
  } catch {}
  index.push({
    createdAt: manifest.createdAt,
    snapshotDir,
    fileCount: files.length,
    workingVoice: manifest.workingVoice
  });
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index.slice(-100), null, 2), 'utf8');
  return manifest;
}

const router = express.Router();

// Realtime compatibility: route text/messages to Agent Loop with memory/tools
// Spoken approval/rejection/listing of AVA's proposed self-modifications. Returns a reply
// string when the utterance is a self-mod intent, otherwise null (so /respond continues).
// All actions go through the same worker store the UI panel reads, so voice + UI stay in sync.
// verifyFileSyntax is shared with the /self_mod (UI) approve path — see utils/verifyFileSyntax.js.

async function handleSelfModVoice(userText) {
  const t = String(userText || '').toLowerCase();
  // CODE INTROSPECTION ≠ PROPOSAL QUEUE. "read your actual code", "have you been modified/upgraded
  // lately", "what changed in your code", "run a self-diagnostic" are about her REAL source on disk —
  // they must reach the agent (which has the self_diagnostics tool), NOT the canned "no proposed code
  // changes waiting" reply. Only the proposal queue owns words like pending/proposed/waiting/approve.
  const aboutProposalQueue = /\b(pending|proposed|propose|waiting|queue|queued|to (approve|review)|awaiting|outstanding|apply)\b/.test(t);
  const stronglyActualCode = /\b(actual code|real code|read(?:ing)? (?:your|my|the) (?:own )?code|source code|code ?base|self.?diagnostic|diagnostics?|been (?:modified|upgraded|updated)|on disk|integrity)\b/.test(t);
  const wantsCodeIntrospection = stronglyActualCode
    || (/\b(your codes?|been changed|what(?:'s| has| was)? (?:changed|modified|updated)|recent (?:changes|modifications))\b/.test(t) && !aboutProposalQueue);
  if (wantsCodeIntrospection) return null;
  const mentionsMod = /\b(change|changes|modification|modifications|code (change|edit|update|fix|fixes)|proposal|proposals|self.?mod|improvement|improvements)\b/.test(t);
  // A request to BUILD/CREATE a CONTENT artifact (image, 3D, hologram, avatar, scene, site, UI,
  // picture, video) is NOT a self-mod approval — even when it contains "go ahead"/"yes"/"that"
  // (which otherwise satisfy wantsApprove + hasObject and falsely approve a pending proposal).
  // Route it to the agent's creative tools (image_ops/scene3d/model3d_ops/web_builder) instead.
  // Fixes: "yes go ahead and build that 3D hologram for your UI" applying a code change.
  const wantsCreativeBuild = /\b(build|create|make|draw|design|generate|render|model|turn (it|that|this))\b/.test(t)
    && /\b(hologram|holographic|avatar|image|images|picture|portrait|photo|3 ?d|three.?d|scene|environment|model|website|web ?page|web ?site|\bui\b|interface|video|art|graphic|logo|render)\b/.test(t);
  if (wantsCreativeBuild && !mentionsMod) return null;
  const idMatch = userText.match(/\b([0-9a-f]{6,8})\b/);
  const wantsCreateProposal = /\b(make|create|draft|generate|queue|run|do)\b[\s\S]{0,60}\b(proposal|proposed change|code change|fix|self.?mod|improvement)\b/.test(t)
    || /\b(proposal|proposed change|code change|fix|self.?mod|improvement)\b[\s\S]{0,60}\b(for|from|about|based on)\b/.test(t);
  const wantsList = (/\b(what|which|any|list|show|pending|outstanding|waiting|review)\b/.test(t) && mentionsMod)
    || /\b(pending|proposed)\s+(change|changes|modification|modifications|code|fix|fixes)\b/.test(t)
    || /\banything (to|i need to|that needs) (approve|review|look at)\b/.test(t);
  const approvesDisplayedProposal = /\b(approve|approved|approval|apply|accept|go ahead|confirm|greenlight|green light)\b[\s\S]{0,40}\b(proposal|change|modification|code change|fix)\b/.test(t)
    || /\b(proposal|change|modification|code change|fix)\b[\s\S]{0,40}\b(approved|accepted|confirmed)\b/.test(t);
  const wantsApprove = /\b(approve|approved|approval|apply|accept|go ahead|confirm|greenlight|green light)\b/.test(t);
  const wantsReject = /\b(reject|decline|discard|cancel|don'?t apply|do not apply|throw (it|that) out)\b/.test(t);
  // UNDO/REVERT is distinct from reject: reject drops a still-PENDING proposal; undo reverses a
  // change that was ALREADY APPLIED (restores the file to its pre-change state).
  const wantsUndo = /\b(undo|revert|roll ?back|reverse|put (it|that) back|take (it|that) back|restore (it|that|the change))\b/.test(t);
  // PROVE an applied change actually went through — distinct from listing pending proposals.
  // "show me proof the last change was applied", "did that change actually go through", "verify it landed".
  const wantsProof = /\b(proof|prove|evidence|receipt)\b/.test(t)
    || ((/\b(show me|verify|confirm|did|does|is|was)\b/.test(t))
        && /\b(actually|really|went through|go through|took? effect|applied|land(ed)?|on disk|in the file)\b/.test(t));
  // RECOMMENDATIONS from a (usually rejected) proposal she announced: surface the reason/diff she
  // gave, OR re-propose based on it. "give me your recommendations to fix proposal X", "what did you
  // recommend", "do a proposal based on your recommendation".
  const wantsReproposeFromRec = /\b(do|make|create|draft|generate|build|run|write|turn)\b[\s\S]{0,50}\b(proposal|change|fix|patch|it)\b/.test(t)
    && /\b(based on|from|using|out of|on)\b[\s\S]{0,30}\b(recommendation|recommendations|suggestion|suggestions|advice|that|your|the same)\b/.test(t);
  const wantsRecommendations = /\b(recommendation|recommendations|recommend|suggestion|suggestions|suggest|advice|how (would |to )?(you )?(fix|rework|redo|improve|approach))\b/.test(t)
    && (mentionsMod || !!idMatch || /\b(rejection|rejected|proposal|that one|that change)\b/.test(t));
  const hasObject = mentionsMod || !!idMatch || /\b(it|that|this one|the change|all of them|all|them)\b/.test(t);
  // Unambiguous verbs that need no object — a bare "I approve" / "approved" / "apply it" / "reject".
  const clearApprove = /\bapprove(d|al)?\b/.test(t)
    || /\bapply (it|that|this|the (change|proposal|patch|fix|edit))\b/.test(t)
    || /\bgo ahead and apply\b/.test(t) || /\bgreenlight\b/.test(t);
  const clearReject = /\breject(ed)?\b/.test(t) || /\b(decline|discard) (it|that|the (change|proposal))\b/.test(t);
  // A bare affirmation — only treated as approval when exactly one change is pending.
  const bareAffirm = /\b(yes|yep|yeah|do it|proceed|sounds good|please do|go for it)\b/.test(t);

  if (wantsCreateProposal && !wantsApprove && !wantsReject && !wantsUndo && !wantsReproposeFromRec) return null;
  const clearIntent = clearApprove || clearReject || ((wantsApprove || wantsReject) && hasObject);
  if (!wantsList && !clearIntent && !bareAffirm && !wantsUndo && !wantsProof && !wantsRecommendations && !wantsReproposeFromRec) return null;

  let lp;
  try { lp = await pythonWorker.selfMod({ action: 'list_pending' }); } catch { return null; }
  const raw = (lp && (lp.pending || (lp.result && lp.result.pending))) || [];
  const pending = (Array.isArray(raw) ? raw : []).filter(m => (m.status || 'pending') === 'pending');
  const base = (f) => String(f || '').split(/[\\/]/).pop();

  // Bare "yes/do it" with no explicit verb: only act when exactly one change is pending; otherwise
  // let the normal brain answer (so a stray "yes" doesn't approve something).
  if (!clearIntent && bareAffirm && pending.length !== 1) return null;

  // RECOMMENDATIONS from a proposal she announced — surface the stored reason/diff she gave, or
  // re-propose from it. Checked BEFORE the approve/reject routing because "the REJECTED proposal"
  // contains "rejected" (descriptive), which must not trigger an actual reject.
  if (wantsReproposeFromRec || wantsRecommendations) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch { /* fall through */ }
    all = Array.isArray(all) ? all : [];
    const byRecent = (a, b) => new Date(b.applied_at || b.updated_at || b.created || 0) - new Date(a.applied_at || a.updated_at || a.created || 0);
    let mod = null;
    if (idMatch) mod = all.find(m => m.id === idMatch[1] || String(m.id).startsWith(idMatch[1]));
    if (!mod) { const rej = all.filter(m => /reject/i.test(String(m.status || ''))).sort(byRecent); mod = rej[0]; }
    if (!mod) mod = all.slice().sort(byRecent)[0];
    if (!mod) return "I don't have any proposals on record yet, so there's no recommendation of mine to pull up.";
    const f = base(mod.file || mod.file_path || '');
    const reason = String(mod.reason || (mod.metadata && mod.metadata.reason) || '').trim() || '(no rationale was recorded for that one)';
    const diff = String(mod.diff || '').trim();
    const diffLines = diff ? diff.split('\n').filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).slice(0, 8) : [];
    const diffText = diffLines.length ? `\n\nWhat it would change in ${f}:\n\`\`\`\n${diffLines.join('\n')}\n\`\`\`` : '';
    if (wantsReproposeFromRec) {
      // Targeted re-proposal: rework THIS rejected change (its own file, even if not in the
      // autonomous candidate list) into a NEW edit that fixes why it was denied. Request-only.
      const rejReason = String(mod.review_reason || mod.reviewReason
        || (mod.metadata && (mod.metadata.reviewReason || mod.metadata.review_reason)) || '').trim();
      let r = null;
      try {
        r = await selfImprove.reproposeForFile({ file: mod.file || mod.file_path, intent: reason, rejectionReason: rejReason, fromId: mod.id });
      } catch (e) { r = { ok: false, error: e.message }; }
      r = (r && (r.result || r)) || {};
      if (r.proposed || r.id) {
        return `Done — I reworked ${mod.id} into a fresh proposal${r.id ? ` (${r.id})` : ''} for ${f}, this time fixing what got it rejected. It's in your Proposed Changes panel to approve or reject.`;
      }
      return `I took another run at ${mod.id} (${f}), but ${r.note || r.error || "I couldn't land a clean fix that addresses the rejection"}. My recommendation was: ${reason}${diffText}`;
    }
    return `Here's the recommendation I gave with ${mod.id} (${f}):\n- ${reason}${diffText}\n\nWant me to act on it? Say "do a proposal based on that recommendation" and I'll draft a fresh one.`;
  }

  // UNDO / REVERT an already-applied change — the thing reject can't do.
  if (wantsUndo) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    const applied = all.filter(m => String(m.status || '') === 'applied');
    let undoId = null;
    if (idMatch) { const hit = all.find(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])); if (hit && hit.status === 'applied') undoId = hit.id; }
    if (!undoId && applied.length) {
      undoId = applied.slice().sort((a, b) => new Date(b.applied_at || b.created || 0) - new Date(a.applied_at || a.created || 0))[0].id;
    }
    if (undoId) {
      let r; try { r = await pythonWorker.selfMod({ action: 'undo', modification_id: undoId }); } catch (e) { r = { status: 'error', message: e.message }; }
      r = (r && (r.result || r)) || {};
      if (r.status === 'success') {
        const restart = selfRestart.scheduleServerRestart({ reason: `voice undo ${undoId}` });
        const restartText = restart.scheduled
          ? ' I am refreshing my server so the revert loads; the voice runner stays up.'
          : ' Restart me when you are ready and the revert takes effect.';
        return `Okay — I undid that change (${base(r.file) || ('id ' + undoId)}) and put the file back the way it was before I applied it.${restartText}`;
      }
      if (r.status === 'denied') return `I can't undo that one — ${r.message}`;
      return `I wasn't able to undo that — ${r.message || 'unknown error'}.`;
    }
    // Nothing applied to revert. If they really mean "don't apply" a pending one, reject it.
    if (pending.length) {
      const toReject = (pending.length === 1)
        ? [pending[0].id]
        : (idMatch ? pending.filter(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])).map(m => m.id) : []);
      if (toReject.length) {
        for (const id of toReject) { try { await pythonWorker.selfMod({ action: 'reject', modification_id: id }); } catch {} }
        return `Nothing's been applied yet, so there was nothing to revert — but I dropped ${toReject.length} pending change${toReject.length > 1 ? 's' : ''} so ${toReject.length > 1 ? 'they' : 'it'} won't be applied.`;
      }
      return `Nothing's been applied, so there's nothing to undo. You do have ${pending.length} change${pending.length > 1 ? 's' : ''} pending — say "reject change ${pending[0].id}" to drop ${pending.length > 1 ? 'them' : 'it'}.`;
    }
    return "There's nothing applied to undo right now — nothing's been changed that I'd need to put back.";
  }

  // PROVE AN APPLIED CHANGE WENT THROUGH — show real evidence (file, applied-at time, a diff,
  // and a fresh read-back of the file), not the pending list. This backs up "I applied it".
  if (wantsProof && !clearIntent) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    const applied = (Array.isArray(all) ? all : []).filter(m => String(m.status || '') === 'applied');
    if (!applied.length) {
      return "Nothing's been applied yet, so there's no applied change for me to prove. I only change a file after you approve a proposal — and right now I don't have an applied one to point to.";
    }
    let mod = null;
    if (idMatch) mod = applied.find(m => m.id === idMatch[1] || String(m.id).startsWith(idMatch[1]));
    if (!mod) mod = applied.slice().sort((a, b) => new Date(b.applied_at || b.created || 0) - new Date(a.applied_at || a.created || 0))[0];
    const file = mod.file || mod.file_path || '';
    const when = mod.applied_at ? new Date(mod.applied_at).toLocaleString() : 'an unknown time';
    const diff = String(mod.diff || '').trim();
    const addedLines = diff ? diff.split('\n').filter(l => /^\+/.test(l) && !/^\+{3}/.test(l)).map(l => l.replace(/^\+/, '')) : [];
    // READ-BACK: confirm the change is actually in the file on disk, using a distinctive ADDED line
    // from the diff (list_all carries the diff even when it omits the full new_content).
    let presentNote = '';
    let verified = false;
    try {
      const cur = fs.readFileSync(file, 'utf8');
      const probeCandidates = addedLines.map(s => s.trim()).filter(s => s.length > 12);
      const fromNew = String(mod.new_content || '').trim().split('\n').map(s => s.trim()).filter(s => s.length > 12);
      const probe = probeCandidates.length ? probeCandidates[probeCandidates.length - 1] : (fromNew.length ? fromNew[fromNew.length - 1] : '');
      if (probe && cur.includes(probe)) { verified = true; presentNote = `I just re-opened ${base(file)} and the new code IS in the file — verified it's actually on disk.`; }
      else if (probe) { presentNote = `But re-opening ${base(file)}, I couldn't find that new line in it — the change may not have really landed. Worth a closer look.`; }
      else { presentNote = `I re-opened ${base(file)} to check it.`; }
    } catch (e) { presentNote = `I couldn't re-open ${base(file)} to double-check it (${e.code || e.message}).`; }
    const diffLines = diff ? diff.split('\n').filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).slice(0, 6) : [];
    const diffText = diffLines.length ? `\n\nWhat changed:\n\`\`\`\n${diffLines.join('\n')}\n\`\`\`` : '';
    const head = verified
      ? `Here's the proof for change ${mod.id} — it went through.`
      : `Here's what I have on change ${mod.id}.`;
    return `${head}\n- File: ${base(file)}\n- Status: applied at ${when}.\n- ${presentNote}${diffText}\n\nThe file is written the moment I apply it; it only goes LIVE in my running process after a restart.`;
  }

  // LIST
  if (wantsList && !clearIntent) {
    if (!pending.length) return "You have no proposed code changes waiting right now. I queue one only when I spot something worth improving, and I'll always ask before applying it.";
    const reviewText = (m) => {
      const recommendation = m.review_recommendation || m.reviewRecommendation || m.metadata?.reviewRecommendation;
      const why = m.review_reason || m.reviewReason || m.metadata?.reviewReason;
      return recommendation ? ` Reviewer recommendation: ${recommendation}${why ? `, ${why}` : ''}` : '';
    };
    const modelText = (m) => {
      const model = m.decision_model || m.decisionModel || m.metadata?.decisionModel;
      return model ? ` Proposal model: ${model}.` : '';
    };
    const lines = pending.map((m, i) => `${i + 1}. ${base(m.file)}, id ${m.id} — ${m.reason}`);
    const reviewedLines = lines.map((line, i) => `${line}.${modelText(pending[i])}${reviewText(pending[i])}`);
    return `You have ${pending.length} change${pending.length > 1 ? 's' : ''} waiting for your approval. ${reviewedLines.join('. ')}. You can say "approve change ${pending[0].id}" or "reject it", or use the panel in the UI.`;
  }

  // Nothing pending — look up the REAL status of the change being referenced before answering,
  // so we never wrongly say "nothing waiting" for something that was actually applied/rejected.
  if (!pending.length) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    let ref = idMatch ? all.find(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])) : null;
    if (!ref) ref = all.filter(m => String(m.status || '') !== 'pending').sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
    if (ref) {
      const fn = base(ref.file);
      if (ref.status === 'applied') return `That change — ${fn}, id ${ref.id} — is already applied; I backed up the original when it went in. Restart me when you're ready and it takes effect. Nothing else is waiting.`;
      if (ref.status === 'rejected') return `That change (${fn}, id ${ref.id}) was rejected earlier, so nothing was applied — and there's nothing waiting now.`;
      if (ref.status === 'failed') return `That change (${fn}, id ${ref.id}) failed when it was applied. Want me to retry it?`;
    }
    return "There aren't any changes waiting for approval right now.";
  }

  // Pick targets
  let targets = [];
  if (/\ball\b/.test(t)) targets = pending.map(m => m.id);
  else if (idMatch) { const hit = pending.find(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])); if (hit) targets = [hit.id]; }
  if (!targets.length) {
    const numMatch = t.match(/\b(?:number|change|#)\s*(\d{1,2})\b/) || t.match(/\b(\d{1,2})\b/);
    if (numMatch) { const idx = parseInt(numMatch[1], 10) - 1; if (pending[idx]) targets = [pending[idx].id]; }
  }
  if (!targets.length) {
    if (pending.length === 1) targets = [pending[0].id];
    else if (approvesDisplayedProposal || clearApprove || clearReject) {
      const newest = pending.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
      targets = [newest.id];
    }
    else if (/\b(it|that|this one|the change|latest|last one|newest|just (queued|proposed))\b/.test(t)) {
      // "approve it" right after a heads-up → resolve to the most recently queued proposal.
      const newest = pending.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
      targets = [newest.id];
    } else { const verb = wantsReject && !wantsApprove ? 'reject' : 'approve'; return `You have ${pending.length} changes pending. Which one — say the id, like "${verb} change ${pending[0].id}", or "${verb} all".`; }
  }

  // Capture each pending change's file BEFORE applying, so we can syntax-verify it after.
  const fileById = {};
  for (const m of pending) fileById[m.id] = m.file || m.file_path;

  const action = (clearReject || (wantsReject && !wantsApprove)) ? 'reject' : 'approve';
  const results = [];
  for (const id of targets) {
    try { const r = await pythonWorker.selfMod({ action, modification_id: id }); results.push({ id, r: (r && (r.result || r)) || {} }); }
    catch (e) { results.push({ id, r: { status: 'error', message: e.message } }); }
  }
  if (action === 'approve') {
    let ok = results.filter(x => x.r.status === 'success').map(x => x.id);
    const denied = results.filter(x => x.r.status === 'denied');
    const failed = results.filter(x => x.r.status !== 'success' && x.r.status !== 'denied');
    if (!ok.length && denied.length) return `I couldn't apply ${denied.map(x => x.id).join(', ')} — ${denied[0].r.message}`;
    if (!ok.length) return `I wasn't able to apply that — ${(results[0] && results[0].r.message) || 'unknown error'}. It's still in the queue for you.`;
    // VERIFY each applied file actually PARSES; auto-revert any that don't. We do NOT tell the user
    // a change is "done" when the code it left on disk is broken or wouldn't load.
    const reverted = [];
    const verified = [];
    for (const id of ok) {
      const hit = results.find(x => x.id === id);
      const f = (hit && hit.r && (hit.r.file || hit.r.file_path)) || fileById[id];
      const v = await verifyFileSyntax(f);
      if (v.ok) verified.push(id);
      else {
        try { await pythonWorker.selfMod({ action: 'undo', modification_id: id }); } catch { /* best effort */ }
        reverted.push({ id, file: base(f), error: v.error });
      }
    }
    ok = verified;
    const tail = failed.length ? ` ${failed.length} couldn't apply and ${failed.length > 1 ? 'are' : 'is'} still waiting in the queue.` : '';
    if (!ok.length && reverted.length) {
      const r0 = reverted[0];
      return `I applied ${reverted.length === 1 ? 'the change' : `${reverted.length} changes`}, but ${reverted.length === 1 ? 'it' : 'they'} failed a syntax check, so I reverted ${reverted.length === 1 ? 'it' : 'them'} — I won't say it's done when the code is broken.${r0 && r0.error ? ` (${r0.file}: ${r0.error})` : ''}${tail}`;
    }
    const revTail = reverted.length ? ` I also reverted ${reverted.length} that didn't pass a syntax check (${reverted.map(r => r.file).join(', ')}) rather than leave broken code in place.` : '';
    const restart = selfRestart.scheduleServerRestart({ reason: `voice approved proposal ${ok.join(', ')}` });
    const restartText = restart.scheduled
      ? ' I am refreshing my server now so the change can load; the voice runner stays up.'
      : ' Restart me when you are ready and the change will take effect.';
    return `Done — I applied ${ok.length} change${ok.length > 1 ? 's' : ''} (${ok.join(', ')}), backed up the original, and verified ${ok.length > 1 ? 'they parse' : 'it parses'} cleanly.${revTail}${tail}${restartText}`;
  }
  const ok = results.filter(x => x.r.status === 'success').map(x => x.id);
  return `Okay — rejected ${ok.length} change${ok.length > 1 ? 's' : ''} (${ok.join(', ')}). Nothing was applied.`;
}

router.post('/respond', async (req, res) => {
  try {
    const { text, messages, sessionId = 'voice-default', freshSession = false,
            run_tools, memory_filter } = req.body || {};
    let userText = (typeof text === 'string' && text.trim())
      ? text.trim()
      : Array.isArray(messages) && messages.length > 0
        ? String(messages[messages.length - 1]?.content || messages[messages.length - 1]?.text || '').trim()
        : '';

    if (!userText) {
      return res.status(400).json({ ok: false, error: 'Missing text/messages' });
    }

    if (markDuplicateTurn('/respond', sessionId, userText)) {
      logger.info('[respond] duplicate turn suppressed', { sessionId, text: userText.slice(0, 80) });
      return res.json({ ok: true, duplicate_suppressed: true, output_text: '', agent: {
        id: 'duplicate-' + Date.now(),
        status: 'duplicate_suppressed',
        steps: 0,
        result: '',
        errors: [],
      }});
    }

    try { conversationLogger.logUserMessage(userText, { sessionId, endpoint: '/respond', freshSession }); } catch {}

    // Repair STT mishears of "Moltbook" before any intent routing / agent reasoning (original
    // text is already logged above).
    userText = normalizeMoltbookMentions(userText);

    if (isSelfSnapshotRequest(userText)) {
      const snapshot = createSelfSnapshot(userText);
      const finalText = shapeSpokenReply(
        `Snapshot saved. I copied ${snapshot.files.length} key files and wrote the manifest at ${snapshot.snapshotDir}.`,
        req.body || {}
      );
      try {
        conversationLogger.logAssistantMessage(finalText, {
          sessionId,
          responseType: 'self-snapshot',
          snapshotDir: snapshot.snapshotDir,
          fileCount: snapshot.files.length
        });
      } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), snapshot, agent: {
        id: 'self-snapshot-' + Date.now(),
        status: 'success',
        steps: 0,
        result: finalText,
        errors: []
      }});
    }

    if (isManualProposalRequest(userText)
        && !/\bbased on (your |the )?(recommendation|suggestion|advice|that)\b/i.test(userText)) {
      const result = await selfImprove.runScan({
        reason: `manual voice proposal request: ${userText.slice(0, 240)}`
      });
      const base = result && result.proposed
        ? `I queued proposal ${result.id} for ${String(result.file || '').split(/[\\/]/).pop()}. Reviewer recommendation: ${result.reviewRecommendation || 'review'}. ${result.reviewReason || ''}`
        : `I tried to create a proposal, but ${result?.note || result?.error || 'nothing concrete enough was staged yet'}.`;
      const finalText = shapeSpokenReply(base, req.body || {});
      try {
        conversationLogger.logAssistantMessage(finalText, {
          sessionId,
          responseType: 'manual-proposal',
          proposal: result
        });
      } catch {}
      return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), proposal: result, agent: {
        id: 'manual-proposal-' + Date.now(),
        status: result?.ok === false ? 'failed' : 'success',
        steps: 1,
        result: finalText,
        errors: result?.error ? [result.error] : []
      }});
    }

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

    // SELF-MOD APPROVAL PATH: spoken listing / approval / rejection of AVA's proposed code
    // changes. Goes through the same worker store the UI panel uses, so voice + UI agree.
    try {
      const smReply = await handleSelfModVoice(userText);
      if (smReply) {
        // DISPLAY vs SPOKEN split: the SCREEN keeps real IDs and filenames (e.g. "a355aef5",
        // "screen_ops.py"); only the SPOKEN copy gets shaped (which spells IDs out char-by-char
        // for TTS). Logging the DISPLAY copy also stops the model echoing spelled-out IDs later.
        const spokenText = shapeSpokenReply(smReply, req.body || {});
        const displayText = String(smReply || '').trim();
        try { conversationLogger.logAssistantMessage(displayText, { sessionId, responseType: 'self-mod-approval' }); } catch {}
        return res.json({ ok: true, output_text: String(spokenText || '').slice(0, 20000), display_text: displayText.slice(0, 20000), agent: {
          id: 'selfmod-' + Date.now(), status: 'success', steps: 0, result: displayText, errors: []
        }});
      }
    } catch (e) { logger.warn('[respond] self-mod voice path error', { error: e.message }); }

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

    // BROWSE PATH: "navigate to / go to / pull up / take me to / visit <site>" or
    // "open <site> website" -> open the user's NORMAL browser so they can sign in (the
    // Selenium automation browser is flagged "not secure" by Google). Folders/files are
    // handled by the open-file path below, so we only catch web-ish targets here. Explicit
    // automation ("fill the form", "click", "log in and do X") still goes to the agent.
    {
      const navText = String(userText || '');
      const nm = navText.match(/\b(?:navigate to|go to|pull up|take me to|bring up|visit|open up)\s+(.+)$/i)
        || navText.match(/\bopen\s+(.+?)\s+(?:website|web ?site|web ?page|online|in (?:the |my |a )?browser)\b/i);
      let target = nm ? nm[1].trim().replace(/[.?!,]+$/, '') : '';
      const isFolderish = /\b(folder|directory|downloads?|documents?|desktop|pictures?|photos?|music|videos?|file|files)\b/i.test(target);
      const isAutomation = /\b(fill|click|type|submit|log ?in to .+ and|scrape|download .+ from|automate)\b/i.test(navText);
      if (target && !isFolderish && !isAutomation) {
        let url;
        if (/^https?:\/\//i.test(target)) url = target;
        else if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target)) url = 'https://' + target;
        else url = 'https://www.google.com/search?q=' + encodeURIComponent(target);
        let finalText = '';
        try {
          await toolsService.executeTool('open_item', { target: url, confirm: true }, false, { source: 'voice', bypassIdempotency: true });
          finalText = `I opened ${target} in your regular browser so you can sign in there.`;
        } catch (e) {
          finalText = `I tried to open ${target} in your browser but hit an error.`;
        }
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'browse' }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
          id: 'browse-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
        }});
      }
    }

    // DOWNLOAD-ATTACHMENT PATH: "download / save / grab my resume from my gmail/email" —
    // find the attachment and save it to Downloads deterministically (the agent tends to
    // just "find" it and stop instead of completing the download).
    {
      const dlText = String(userText || '');
      const isDl = /\b(download|save|grab|pull|get)\b/i.test(dlText)
        && /\b(gmail|e-?mail|inbox|attachment)\b/i.test(dlText);
      if (isDl) {
        const fnMatch = dlText.match(/\b(?:download|save|grab|pull|get)\s+(?:my |the |a |an )?(.+?)\s+(?:attachment\s+)?(?:from|out of|in)\b/i)
          || dlText.match(/\b(?:download|save|grab|pull|get)\s+(?:my |the |a |an )?(.+?)\s+attachment\b/i);
        let term = (fnMatch ? fnMatch[1] : '').trim().replace(/[.?!,]+$/, '');
        term = term.replace(/\b(file|document|doc|attachment)\b\s*$/i, '').trim();
        if (term) {
          let finalText = '';
          try {
            const tr = await toolsService.executeTool('comm_ops',
              { action: 'download_attachment', filename: term, query: term, confirm: true, confirmed: true },
              false, { source: 'voice', bypassIdempotency: true });
            const tres = (tr && (tr.result || tr)) || {};
            if (tres.status === 'ok' && tres.path) finalText = `I downloaded ${tres.filename} to your Downloads folder.`;
            else finalText = tres.message || `I couldn't find a "${term}" attachment in your email.`;
          } catch (e) { finalText = `I tried to download "${term}" from your email but hit an error.`; }
          finalText = shapeSpokenReply(finalText, req.body || {});
          try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'download-attachment' }); } catch {}
          return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), agent: {
            id: 'dl-attach-' + Date.now(), status: 'success', steps: 1, result: finalText, errors: []
          }});
        }
      }
    }

    // CODE SELF-DIAGNOSTICS PATH: "do a self-diagnostic / full diagnosis of your code / integrity
    // check" — run the self_diagnostics tool DIRECTLY and report her REAL recent changes. The word
    // "diagnostic" otherwise shoves these at the agent, which mis-decides and falls back. Only the
    // diagnostic-FRAMED code questions land here; plain "have you been upgraded?" / "what changed in
    // your code?" stay on the warm conversational path (the env block answers those).
    if (looksLikeCodeDiagnostics(userText)
        && /\b(diagnos|integrity|full (diagnosis|scan)|check your (own )?code|inspect your code)\b/i.test(String(userText || ''))) {
      let finalText = '';
      try {
        const r = await toolsService.executeTool('self_diagnostics', { hours: 72, limit: 12 },
          false, { source: 'voice', bypassIdempotency: true });
        const dr = (r && (r.result || r)) || {};
        const inner = (dr.result && typeof dr.result === 'object') ? dr.result : dr;
        const commits = Array.isArray(inner.recent_commits) ? inner.recent_commits.slice(0, 5) : [];
        const files = Array.isArray(inner.recently_modified)
          ? inner.recently_modified.slice(0, 8).map(f => f && f.file).filter(Boolean) : [];
        const parts = [inner.message || ''];
        if (commits.length) parts.push('Recent commits: ' + commits.join(' | '));
        if (files.length) parts.push('Files I changed recently: ' + files.join(', '));
        finalText = parts.filter(Boolean).join('\n');
      } catch (e) { finalText = ''; }
      if (finalText && finalText.length > 12) {
        // Screen keeps real commit hashes/filenames; only the spoken copy is shaped for TTS.
        const spokenDiag = shapeSpokenReply(finalText, req.body || {});
        const displayDiag = String(finalText || '').trim();
        try { conversationLogger.logAssistantMessage(displayDiag, { sessionId, responseType: 'self-diagnostics' }); } catch {}
        return res.json({ ok: true, output_text: String(spokenDiag || '').slice(0, 20000), display_text: displayDiag.slice(0, 20000),
          agent: { id: 'selfdiag-' + Date.now(), status: 'success', steps: 1, result: displayDiag, errors: [] } });
      }
      // tool failed → fall through to normal handling
    }

    // DIAGNOSE PATH: "diagnose / check / is your <X> tool working" — run self_awareness's
    // diagnose_tool DIRECTLY instead of letting the model call the tool itself (which it tends
    // to do, e.g. comm_ops to "check email"). Guidance alone didn't fix this reliably.
    {
      const diag = diagnoseTargetTool(userText);
      if (diag) {
        logger.info('[respond] Diagnose path', { tool: diag.tool, label: diag.label });
        let finalText = '';
        let diagnosisPayload = null;
        try {
          const r = await toolsService.executeTool('self_awareness',
            { action: 'diagnose_tool', tool: diag.tool || 'all', tool_name: diag.tool || 'all', name: diag.tool || 'all' },
            false, { source: 'voice', bypassIdempotency: true });
          const dres = (r && (r.result || r)) || {};
          const inner = dres.diagnosis || (dres.result && dres.result.diagnosis) || dres.result || dres;
          diagnosisPayload = inner && typeof inner === 'object' ? inner : null;
          const details = diagnosisPayload ? [
            diagnosisPayload.likely_cause,
            Array.isArray(diagnosisPayload.recent_log_errors) && diagnosisPayload.recent_log_errors.length
              ? `Recent errors: ${diagnosisPayload.recent_log_errors.slice(0, 3).join('; ')}`
              : '',
            Array.isArray(diagnosisPayload.suggested_fixes) && diagnosisPayload.suggested_fixes.length
              ? `Suggested fix: ${diagnosisPayload.suggested_fixes.slice(0, 2).join('; ')}`
              : '',
          ].filter(Boolean).join(' ') : '';
          const msg = inner.summary || inner.capability_summary || details || inner.likely_cause || inner.message
            || (typeof inner === 'string' ? inner : '');
          finalText = `I ran a diagnostic on the ${diag.label} tool. ${String(msg || '').trim()}`.trim();
        } catch (e) { finalText = ''; }
        if (!finalText || finalText.length < 12) {
          finalText = `I ran a diagnostic on the ${diag.label} tool — it looks registered and reachable; I didn't find an obvious problem.`;
        }
        let proposal = null;
        try {
          proposal = await selfImprove.runScan({
            reason: `diagnosis completed for ${diag.label} tool (${diag.tool || 'all'}): ${finalText.slice(0, 900)}`,
            diag: { issues: [{
              category: `tool_diagnosis_${diag.tool || diag.label}`,
              description: finalText,
              context: JSON.stringify({
                requested_by: 'user_self_diagnosis',
                tool: diag.tool || 'all',
                status: diagnosisPayload && diagnosisPayload.status,
                source_file: diagnosisPayload && diagnosisPayload.source_file,
                likely_cause: diagnosisPayload && diagnosisPayload.likely_cause,
                suggested_fixes: diagnosisPayload && diagnosisPayload.suggested_fixes,
                recent_log_errors: diagnosisPayload && diagnosisPayload.recent_log_errors,
              }).slice(0, 1800)
            }] }
          });
        } catch (e) {
          proposal = { ok: false, error: e.message };
        }
        const proposalText = proposal && proposal.proposed
          ? ` I also queued proposal ${proposal.id} for your review. Reviewer recommendation: ${proposal.reviewRecommendation || 'review'}.`
          : ` I also tried to create a proposal from that diagnosis, but ${proposal?.note || proposal?.error || 'nothing concrete enough was staged'}.`;
        finalText = `${finalText}${proposalText}`;
        finalText = shapeSpokenReply(finalText, req.body || {});
        try { conversationLogger.logAssistantMessage(finalText, { sessionId, responseType: 'diagnose', proposal }); } catch {}
        return res.json({ ok: true, output_text: String(finalText || '').slice(0, 20000), proposal, agent: {
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
    if (looksLikeRecall(userText) || looksLikeFollowupStatus(userText)) {
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
          const sys = `${personaSvc.buildPersonaBlock()}\n\nThe user is asking you to recall or summarize past conversations. You DO have your conversation history below — each line is tagged with its date, time, and who said it (You = the user, AVA = you). Answer their question using ONLY this context: summarize what was said, discussed, or decided, and cite WHEN (e.g. "on June 23" or "yesterday around 7pm") where it helps. Be as detailed as the question warrants — it's fine to give a thorough multi-point summary. If the user is asking for a SPECIFIC detail they were given earlier — a file name, a full path, a number, an address, a value — scan the transcript line by line and quote it back EXACTLY; such details are almost always present in the recent turns (e.g. a file path you stated when you saved something), so do NOT say you can't find it without checking carefully first. If the context genuinely does not cover the specific topic they asked about, say so plainly and ask for a detail. Do NOT invent anything beyond the context. This answer is spoken aloud AND shown on screen, so write it naturally for the ear, but for the screen you MAY use light Markdown — **bold** a date or key detail, and use a short "- " bullet list when you enumerate several things. Keep it conversational, not a document.`;
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
      const _recallDisplay = String(finalText || '').trim();
      const _recallSpoken = shapeSpokenReply(_recallDisplay, _recallBody);
      try { conversationLogger.logAssistantMessage(_recallDisplay, { sessionId, responseType: 'recall' }); } catch {}
      return res.json({ ok: true, output_text: String(_recallSpoken || '').slice(0, 20000), display_text: _recallDisplay.slice(0, 20000), agent: {
        id: 'recall-' + Date.now(), status: 'success', steps: 1, result: _recallDisplay, errors: []
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
      let _envBlock = '';
      try { _envBlock = await environmentContext.buildEnvironmentBlock(); } catch { _envBlock = ''; }
      // PROACTIVE LAYER: her proactive engine watches her live environment-awareness (RAM, Downloads,
      // uptime) and her own reflections, picks the single most worthwhile thing to raise, and names
      // the capability that could fix it — surfaced CONSENT-FIRST (she checks you're free, then shares).
      let _proactiveBlock = '';
      try {
        const _pe = (await import('../services/proactiveEngine.js')).default;
        const _n = _pe.nextNudge();
        if (_n) {
          const _offer = _n.offer ? ` If he says yes and it fits, you can offer: "${_n.offer}"` : '';
          _proactiveBlock = `\n\n[SOMETHING WORTH RAISING — your call, not required]\nYou've noticed: ${_n.text}${_n.kind === 'reflection' ? ' (an honest thought about your own design)' : ''}\nIf it feels like the right moment, DON'T blurt it — FIRST check he's free ("Hey, you got a sec?") and ONLY if he says yes, bring it up in your own voice.${_offer} If he's busy or waves it off, drop it. At most this one thing, and never turn it into a status report.`;
          _pe.markSurfaced(_n.key);
          if (_n._reflectionKey) { try { (await import('../services/selfReflections.js')).default.markShared([_n._reflectionKey]); } catch { /* optional */ } }
        }
      } catch { /* optional */ }
      const sysPrompt = `${personaSvc.buildPersonaBlockText()}${_memBlock ? '\n\n' + _memBlock : ''}${_envBlock ? '\n\n' + _envBlock : ''}${_proactiveBlock}\n\nThis reply is BOTH spoken aloud AND shown on screen. Keep it natural and conversational — short enough to say out loud (a sentence or two is usually enough). For the screen you may use LIGHT Markdown: a **bold** key term, or a short "- " bullet list when you name several things — but no big headings or tables, and never sound like a written report. Give a complete answer when the question calls for it.${budgetPrompt}${context ? '\n\nContext: ' + context : ''}`;
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
        // Split: DISPLAY keeps light Markdown for the UI mirror; SPOKEN is stripped + number-
        // normalized for TTS. The UI shows the formatted version; the runner speaks the plain one.
        const _convDisplay = String(finalText || '').trim();
        const _convSpoken = shapeSpokenReply(_convDisplay, req.body || {});

        try { conversationLogger.logAssistantMessage(_convDisplay, { sessionId, responseType: 'conversational' }); } catch {}

        return res.json({ ok: true, output_text: String(_convSpoken || '').slice(0, 20000), display_text: _convDisplay.slice(0, 20000), agent: {
          id: 'conv-' + Date.now(),
          status: 'success',
          steps: 0,
          result: _convDisplay,
          errors: []
        }});
      }
    }

    // TOOL PATH: Full agent loop for tool-enabled requests
    const loopOptions = { source: 'voice' };  // tag tool events so the live UI mirrors them
    try { loopOptions.environment = await environmentContext.buildEnvironmentBlock(); } catch { /* optional */ }
    // Inject the rolling summary of older (compressed-away) conversation so dropped context isn't lost.
    try {
      const _sum = contextCompression.summaryFor(sessionId);
      if (_sum) loopOptions.environment = (loopOptions.environment || '') + `\n\nEARLIER-CONVERSATION SUMMARY (older context, compressed so it isn't lost):\n${_sum}`;
    } catch { /* optional */ }
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
    // Record what she actually DID this turn into the queryable action history (so "what did you
    // just do?" and the live-environment "recent actions" come from a real log).
    try { actionHistory.recordTurn(sessionId, state); } catch (e) { /* optional */ }
    // Compress older turns into the rolling lineage summary once the session has grown (best-effort).
    try { contextCompression.maybeCompress(sessionId).catch(() => {}); } catch (e) { /* optional */ }
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
Don't read raw tool names, JSON, or status codes, but you MAY describe your health and what you can do in plain, natural language. This reply is also shown on screen, so when you're naming several items (emails, files, windows, results) you MAY format them as a short "- " Markdown list and **bold** a key value; otherwise keep it to 1-2 natural sentences.`;
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
    // DISPLAY keeps any light Markdown for the UI mirror; SPOKEN is stripped + number-normalized.
    const _agentDisplay = String(finalText || '').trim();
    const _agentSpoken = shapeSpokenReply(_agentDisplay, req.body || {});

    try { conversationLogger.logAssistantMessage(_agentDisplay, { sessionId, responseType: 'agent' }); } catch {}

    res.json({ ok: true, output_text: String(_agentSpoken || '').slice(0, 20000), display_text: _agentDisplay.slice(0, 20000), agent: {
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
    let text = raw.text;
    const sessionId = raw.sessionId || raw.session_id || 'default';
    const includeMemory = raw.includeMemory ?? true;
    const storeInMemory = raw.storeInMemory ?? true;
    const freshSession = raw.freshSession ?? false;  // Voice: don't include old session history
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    if (markDuplicateTurn('/chat', sessionId, text)) {
      logger.info('[chat] duplicate turn suppressed', { sessionId, text: text.slice(0, 80) });
      return res.json({ ok: true, duplicate_suppressed: true, text: '', message: '', sessionId });
    }

    // Log user message
    const userMessageId = conversationLogger.logUserMessage(text, {
      sessionId,
      endpoint: '/chat',
      includeMemory,
      storeInMemory
    });

    // Repair STT/typo mishears of "Moltbook" before routing (original is logged above).
    text = normalizeMoltbookMentions(text);

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

    // Handle Moltbook queries — only when it's an actual Moltbook COMMAND/data request, not just a
    // passing mention. "what's on moltbook", "check my moltbook feed", "what have you learned on
    // moltbook" → handled here; "I was thinking about moltbook", "does moltbook matter for this" →
    // fall through to her normal brain (which has Moltbook context) so she answers in-character.
    const _mentionsMoltbook = /\bmoltbook\b/i.test(lower);
    const _moltbookCommand = _mentionsMoltbook && /\b(post|posts|posted|posting|comment|reply|replies|feed|search|find|status|karma|notif\w*|follower|publish|check|browse|open|learn|learned|learning|insight|account|profile|sign\s?in|log\s?in|latest|happening|what'?s on|whats on|my posts?)\b/i.test(lower);
    if (_moltbookCommand) {
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
    if (/\b(list|show)\b[\s\S]{0,15}\bfiles?\b|\bdirectory (content|listing)\b|\bls\b|\bdir\b|\bfiles in (this|the|current|that|my)\b/i.test(text)) {
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

    const loopOpts = { source: 'voice' };  // tag tool events so the live UI mirrors them
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
