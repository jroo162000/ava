// POST /respond — the voice pipeline's main turn handler, plus the intent-detection helpers
// used only by it. Extracted verbatim from routes/api.js (Tier 2 split) — logic unchanged.
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import toolsService from '../services/tools.js';
import llmService from '../services/llm.js';
import conversationLogger from '../services/conversationLogger.js';
import turnGuard from '../services/turnGuard.js';
import artifactMemory from '../services/artifactMemory.js';
import artifactBus from '../services/artifactBus.js';
import presenter from '../services/presenter.js';
import personaSvc from '../services/persona.js';
import environmentContext from '../services/environmentContext.js';
import actionHistory from '../services/actionHistory.js';
import curatedMemory from '../services/curatedMemory.js';
import conversationHistory from '../services/conversationHistory.js';
import contextCompression from '../services/contextCompression.js';
import memoryReviewer from '../services/memoryReviewer.js';
import selfImprove from '../services/selfImprove.js';
import { shapeSpokenReply, normalizeSpokenReplyBudget, normalizeMoltbookMentions, isStepStatusMessage } from '../services/speech.js';
import { isSelfSnapshotRequest, isManualProposalRequest, createSelfSnapshot, handleSelfModVoice } from '../services/selfModVoice.js';
import { emitVoiceEvent } from '../services/voiceBus.js';  // Tier 2 #15: assistant.delta to the UI
import { markDuplicateTurn, buildSelfStatus } from './api.js';

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
    // Live machine-state nouns (#20b): the 2026-07-02 escalation eval showed the model
    // confidently INVENTING these when left to the conversational path (fake volume levels,
    // fake drive stats, fake recycle-bin counts). Still general tool-routing, not phrase→response.
    /\b(clipboard|recycle bin|trash|wi-?fi|network connection|connected to (the )?(internet|network)|volume|muted?|(c|d|hard|my) drive|storage (space|left)|windows? (do i have )?open|open windows|foreground|which (app|program|window)|what('?s| is) playing|(song|music|audio) (is )?playing|processes (are )?running)\b/.test(t) ||
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

// True when the turn is a general WORLD-KNOWLEDGE / explanation question (explain photosynthesis,
// how does an engine work, what is X, who was Y) with NO dependence on the user's own machine,
// data, or self. Log-review fix (2026-07-02): "explain step by step how photosynthesis works"
// was routed to the AGENT LOOP (voice defaults run_tools=true for non-chit-chat), where the
// decision model occasionally hallucinated a refusal ("conflicts with system instructions").
// Such questions belong on the conversational path, where she just answers (and can still emit
// NEED_TOOLS if it turns out real data/tools ARE needed). Deliberately conservative: anything a
// tool/recall/self-description handler already catches is excluded by the callers' ordering, and
// "my/your <machine-noun>" is excluded here so live-data questions still reach the tools.
function looksLikeKnowledgeQuestion(text = '') {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  const educational = /\b(explain|how (do|does|did|can|would|is|are)|what (is|are|was|were|causes?|happens?|does)|what'?s the (difference|meaning|point|history)|why (is|are|does|do|did|would)|define|describe (the|how|why|what)|tell me about|give me (an? )?(overview|summary|rundown) (of|on)|who (was|is|were|are)|when (did|was|were)|where (is|are|was)|difference between|meaning of)\b/;
  if (!educational.test(t)) return false;
  // Exclude anything tied to the user's OWN machine / data / self (those need tools or the
  // self-intro path). looksLikeToolRequest/isSelfDescriptionRequest run before this at the
  // call site, but guard here too so the routing intent is self-contained.
  if (/\b(my|your)\b[\s\S]{0,24}\b(calendar|email|inbox|file|files|folder|screen|camera|memory|memories|ram|cpu|disk|drive|clipboard|window|windows|download|system|volume|network|wi-?fi|conversation|code|setting|process)\b/.test(t)) return false;
  if (/\bwhat can you do\b|\b(your|you have) (capabilit|tool|feature|function)/.test(t)) return false;
  return true;
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

const router = express.Router();

// Tier 2 #10/#11: text-reply LLM calls stream their tokens out through req._streamDelta when
// the request came in via POST /respond/stream (which sets that hook). Blocking /respond calls
// never set the hook, so this is a pass-through to llmService.chat there. If streaming fails
// BEFORE any token was emitted we quietly fall back to the blocking call; a mid-stream partial
// is returned as-is (it has already been spoken).
async function _chatMaybeStream(req, messages, options = {}) {
  if (typeof req._streamDelta === 'function') {
    try {
      const r = await llmService.streamText({
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        temperature: options.temperature,
        maxTokens: options.max_tokens || options.maxTokens || 1000,
      }, req._streamDelta);
      if (String(r.content || '').trim()) return r;
    } catch (e) {
      logger.warn('[respond/stream] streamText failed; falling back to blocking chat', { error: e.message });
    }
  }
  return llmService.chat(messages, options);
}

// Realtime compatibility: route text/messages to Agent Loop with memory/tools
router.post('/respond', respondHandler);

async function respondHandler(req, res) {
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
    // Clean task-switch (#205): claim this turn. If a newer turn for this session begins while the
    // slow (agent / conversational) paths below are still working, they'll see they're superseded
    // at their emit point and drop the stale reply instead of speaking over the newer one.
    const _turn = turnGuard.begin(sessionId);
    // Visual artifact panel (#225): did the user explicitly ask to SEE something? If so we force a
    // visual; otherwise the visualizer decides on its own whether a diagram/table/summary would help.
    const _wantsVisual = /\b(show me (a |the )?(diagram|chart|mermaid|table|visual|map)|diagram (this|that|it)|put (that|this|it) (on|up) (the )?(panel|board|screen)|visuali[sz]e|draw (me )?(a )?(diagram|chart)|make (me )?(a )?(diagram|chart|table)|on the (panel|board))\b/i.test(userText);

    // Repair STT mishears of "Moltbook" before any intent routing / agent reasoning (original
    // text is already logged above).
    userText = normalizeMoltbookMentions(userText);

    // Tier 1 #6: the deterministic regex "fast paths" below (camera-see, browse, download-
    // attachment, diagnose, open/append/read/find file, remember, recall) are OFF by default —
    // tool selection is now the model's own native function calling in the agent loop, which
    // sees every tool's full schema. Set AVA_FAST_PATHS=1 to re-enable the old hardwired routes.
    const FAST_PATHS = process.env.AVA_FAST_PATHS === '1';

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
    if (FAST_PATHS && looksLikeCameraSee(userText) && !diagnoseTargetTool(userText)) {
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
      if (FAST_PATHS && target && !isFolderish && !isAutomation) {
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
      const isDl = FAST_PATHS && /\b(download|save|grab|pull|get)\b/i.test(dlText)
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
    if (FAST_PATHS && looksLikeCodeDiagnostics(userText)
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
      const diag = FAST_PATHS ? diagnoseTargetTool(userText) : null;
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
      const openHint = FAST_PATHS ? openFileTarget(userText) : null;
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
      const ap = FAST_PATHS ? appendTarget(userText) : null;
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
      const rt = FAST_PATHS ? readFileTarget(userText) : null;
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
      const ff = FAST_PATHS ? findFilesTarget(userText) : null;
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
    // COMMITMENT: "remind me to X" / "hold me to X" -> track it for proactive follow-up.
    {
      const _cm = String(userText || '').match(/^\s*(?:ava[\s,!.]*)?(?:please\s+)?(?:remind me to|hold me to|i need to remember to|add (?:a )?(?:commitment|task)(?:\s+to)?|track (?:a )?commitment(?:\s+to)?)\s*[:,\-]?\s*(.+)$/i);
      if (FAST_PATHS && _cm && (_cm[1] || '').trim().length > 2 && !looksLikeRecall(userText)) {
        try { (await import('../services/commitments.js')).default.add(_cm[1].trim(), { who: 'user' }); } catch { /* optional */ }
        const _t = shapeSpokenReply("Got it — I'm tracking that, and I'll keep you honest on it.", req.body || {});
        try { conversationLogger.logAssistantMessage(_t, { sessionId, responseType: 'commitment' }); } catch { /* optional */ }
        return res.json({ ok: true, output_text: String(_t || '').slice(0, 20000), agent: { id: 'commit-' + Date.now(), status: 'success', steps: 1, result: _t, errors: [] } });
      }
    }
    if (FAST_PATHS && /\b(remember that|save (my|this|that)|note that i|make a note that|keep in mind that|store (this|that))\b/.test(userText.toLowerCase()) && !looksLikeRecall(userText)) {
      logger.info('[respond] Remember path (memory_system save)', { text: userText.slice(0, 60) });
      let ok = false;
      try {
        await toolsService.executeTool('memory_system', { action: 'save', operation: 'save', content: userText, text: userText, value: userText }, false, { source: 'voice', bypassIdempotency: true });
        try {
          const _note = userText.replace(/^\s*(?:ava[\s,!.]*)?(?:please\s+)?(?:remember|save|note|make a note|keep in mind|store)\b\s*(?:that|this|my)?\b[:,\-\s]*/i, '').trim();
          (await import('../services/groundTruth.js')).default.fileThat(_note || userText);
        } catch { /* ground-truth mirror optional */ }
        ok = true;
      } catch (e) { ok = false; }
      let finalText = ok ? "Got it — I'll remember that, and I've filed it in our ground truth." : "I tried to save that, but ran into an issue.";
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
    if (FAST_PATHS && (looksLikeRecall(userText) || looksLikeFollowupStatus(userText))) {
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
          const r = await _chatMaybeStream(req, [{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.3, max_tokens: 1400 });
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
    // Log-review fix (2026-07-02): a general WORLD-KNOWLEDGE question ("explain photosynthesis")
    // also takes this path EVEN WHEN run_tools is allowed — voice defaults run_tools=true for
    // anything non-chit-chat, which shoved knowledge questions into the agent loop where the
    // decision model sometimes falsely refused. It's still gated by !looksLikeToolRequest, so a
    // live-data question never lands here, and the path can still emit NEED_TOOLS to escalate.
    const _knowledgeQ = looksLikeKnowledgeQuestion(userText);
    if ((run_tools === false || _knowledgeQ) && !looksLikeToolRequest(userText) && !looksLikeRecall(userText)) {
      logger.info('[respond] Conversational path (no tools)', { text: userText.slice(0, 60), knowledge: _knowledgeQ });
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
      // FINANCE GROUNDING (RAG): for finance/bookkeeping/tax questions, retrieve from the KB and inject
      // the top cited passages so she answers from real sources, not just the model's memory.
      let _financeBlock = '';
      try {
        if (/\b(tax|taxes|taxable|bookkeep|accounting|depreciat|deduction|deduct|invoice|payroll|gaap|ledger|journal entry|balance sheet|income statement|cash flow|irs|w-2|1099|schedule c|schedule se|capital gains|withholding|amortiz|expense|revenue|audit|estimated tax|self-employment|filing status|standard deduction|sales tax)\b/i.test(userText)) {
          const _fk = (await import('../services/financeKnowledge.js')).default;
          const _hits = (await _fk.search(userText, 5)).filter(h => (h.score || 0) > 0.2);
          if (_hits.length) {
            _financeBlock = `\n\n[FINANCE KNOWLEDGE BASE — retrieved for this question; ground your answer in these, cite the source + jurisdiction, and flag year-specific figures; use finance_ops for any math]\n`
              + _hits.map(h => `- (${h.source || 'source'}${h.jurisdiction ? ', ' + h.jurisdiction : ''}) ${String(h.text || '').replace(/\s+/g, ' ').slice(0, 420)}`).join('\n');
          }
        }
      } catch { /* optional */ }
      // GROUND TRUTH + OPEN COMMITMENTS: settled context + accountability she carries each session.
      let _gtBlock = '';
      try { _gtBlock = (await import('../services/groundTruth.js')).default.block(); } catch { /* optional */ }
      let _commitBlock = '';
      try { _commitBlock = (await import('../services/commitments.js')).default.block(); } catch { /* optional */ }
      let _evoBlock = '';
      try { _evoBlock = (await import('../services/evolutionLog.js')).default.block(); } catch { /* optional */ }
      let _panelBlock = '';
      try { _panelBlock = artifactBus.block(); } catch { /* optional */ }
      const sysPrompt = `${personaSvc.buildPersonaBlockText()}${_gtBlock ? '\n\n' + _gtBlock : ''}${_commitBlock ? '\n\n' + _commitBlock : ''}${_evoBlock ? '\n\n' + _evoBlock : ''}${_panelBlock ? '\n\n' + _panelBlock : ''}${_memBlock ? '\n\n' + _memBlock : ''}${_envBlock ? '\n\n' + _envBlock : ''}${_proactiveBlock}${_financeBlock}\n\nThis reply is BOTH spoken aloud AND shown on screen. Keep it natural and conversational — short enough to say out loud (a sentence or two is usually enough). For the screen you may use LIGHT Markdown: a **bold** key term, or a short "- " bullet list when you name several things — but no big headings or tables, and never sound like a written report. Give a complete answer when the question calls for it.${budgetPrompt}${context ? '\n\nContext: ' + context : ''}`;
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
      // QUICK-CAPTURE: "Ava, file that / remember this / remember: X" -> persist to ground-truth + memory.
      try {
        const _u = String(userText || '').trim();
        let _toFile = null, _m;
        if ((_m = _u.match(/^(?:ava[\s,!.]*)?(?:please\s+)?(?:file|save|note|jot(?:\s+down)?|log|remember)\s+(?:that|this|it|down)\b\s*[:.\-–]?\s*(.*)$/i))) {
          _toFile = (_m[1] || '').trim();
          if (_toFile.length < 4) { const _last = [...priorMessages].reverse().find(x => x.content && x.content.length > 12); _toFile = _last ? _last.content : ''; }
        } else if ((_m = _u.match(/^(?:ava[\s,!.]*)?(?:please\s+)?(?:remember|file|save|note)\s*[:\-–]\s*(.+)$/i))) {
          _toFile = (_m[1] || '').trim();
        }
        if (_toFile) {
          try { (await import('../services/groundTruth.js')).default.fileThat(_toFile); } catch { /* optional */ }
          try { const _mem = (await import('../services/memory.js')).default; await _mem.store({ text: _toFile.slice(0, 500), type: 'fact', priority: 4, source: 'user', tags: ['filed', 'user', 'ground-truth'] }); } catch { /* optional */ }
          const _msg = "Filed it — I'll treat that as settled from here on.";
          try { conversationLogger.logAssistantMessage(_msg, { sessionId, responseType: 'quick-capture' }); } catch { /* optional */ }
          return res.json({ ok: true, output_text: _msg, display_text: _msg, agent: { id: 'conv-' + Date.now(), status: 'success', steps: 0, result: _msg, errors: [] } });
        }
      } catch (e) { /* capture optional */ }
      // Natural routing: let the model itself decide if real tools / live data are
      // needed, instead of a brittle keyword gate. In this chat-only mode she must
      // NEVER promise or fake an action — if it needs doing or looking up, she emits
      // a sentinel and we escalate to the agent loop.
      const routingPrompt = `\n\nIMPORTANT: In this mode you can ONLY talk right now — you cannot directly run a tool this turn. If the user asks you to DO something (send/reply to an email, create/update/delete a calendar event, open/read/edit files, control the computer, send a message), OR asks about their CURRENT external data (their real calendar, inbox/emails, files, system status), OR asks you to RECALL or SEARCH something from PAST conversations that is NOT already in the recent turns shown above, do NOT guess, fake, promise, or say you can't — respond with EXACTLY this token and nothing else: NEED_TOOLS. That escalates to your tools, including memory_search over your saved memory and your FULL conversation history.

MACHINE-STATE RULE (absolute): if the question is about the CURRENT state of this computer or anything that changes moment to moment — clipboard contents, open windows, which app is in front, drives/storage, network/wifi, volume or mute, what's playing, processes, devices, the recycle bin, and anything similar — you may answer ONLY from data explicitly present in the context above (e.g. the live environment block). If the specific value is not literally there, emit NEED_TOOLS. NEVER invent a plausible reading. Saying "Let me check" and then stating a made-up number IS lying to the user; you have real tools — use them via NEED_TOOLS instead.\n\nYOU DO HAVE MEMORY. Facts about the user and your own notes are in the system prompt above, the recent turns are included as prior messages, and you can search your entire conversation history with memory_search. So NEVER tell the user you can't remember, don't have memory, or can't access past conversations — that is false. If asked whether you can access past conversations, the answer is YES. If a recall question can be answered from the recent turns above, answer it directly; otherwise emit NEED_TOOLS so you can search.`;
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
      const llmResult = await _chatMaybeStream(req, [
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

        if (!turnGuard.isCurrent(sessionId, _turn)) {
          return res.json({ ok: true, superseded: true, output_text: '', display_text: '', agent: { id: 'superseded-' + Date.now(), status: 'superseded', steps: 0, result: '', errors: [] } });
        }
        // Fire-and-forget: the director presents real visuals (news/photos/video/diagrams) if they help. Never blocks the reply.
        try { presenter.present(userText, _convDisplay, { force: _wantsVisual, sessionId }).catch(() => {}); } catch { /* optional */ }
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
        const sum = await _chatMaybeStream(req, [{ role: 'system', content: sumSys }, { role: 'user', content: sumUsr }], { temperature: 0.2, max_tokens: 2000 });
        const t = (sum.text || sum.content || '').trim();
        if (t) finalText = t;
      } catch (e) { /* fall back to whatever finalText we had */ }
    }

    // HONESTY GUARD: if NO tool actually ran this turn, never let a chatty "I'll do it" / "done" /
    // "let me get that" / "I'm working on it" pass as if she's actually doing something. Widened
    // 2026-07-02 (Jelani: "sometimes she says 'I'm working on it' or 'let me get that' and doesn't
    // actually do anything"): the promise set now includes progress/filler phrases, the request
    // set includes lookup/retrieval verbs, and a "bare/no-substance" gate keeps it from ever
    // clobbering a real answer that happens to contain "I'll" mid-sentence.
    if (!_ground && !_waiting) {
      const actiony = /\b(send|reply|email|e-?mail|text|message|create|add|schedule|set\s+(up|a|an)|book|delete|remove|cancel|update|change|move|rename|open|write|post|turn\s+(on|off)|check|find|look(\s*up)?|get|pull|grab|fetch|search|read|list|show|see|bring up|take a look)\b/i.test(userText);
      const promiseOrDone = /\b(sent|replied|created|added|scheduled|booked|deleted|removed|updated|changed|opened|posted|done|i'?ll|i will|i'?ve|i have|on it|working on it|just a (sec|second|moment|minute)|give me a (sec|second|moment|minute)|hang on|one (sec|second|moment)|let me (get|grab|check|look|pull|find|see|fetch|take a look|look into|bring)|getting (that|it)|pulling (that|it)|looking into (that|it)|i'?m (on|getting|pulling|looking|working))\b/i.test(String(finalText || ''));
      // "bare" = there's no actual answer/data — a short reply with no numbers, no "here's/found",
      // no list. A substantive reply (even if it opens with "I'll") is NOT clobbered.
      const hasSubstance = /[0-9]|\bhere('?s| is| are)\b|\bfound\b|\bshows?\b|\bthere (is|are)\b|:\s*\S|\n\s*[-*]/i.test(String(finalText || ''));
      const bare = !finalText || (String(finalText).trim().length < 160 && !hasSubstance);
      if (actiony && promiseOrDone && bare) {
        finalText = "I wasn't actually able to do that just now — nothing ran on my end, so I won't pretend I'm on it. Want me to try again, or give me a bit more detail?";
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

    if (!turnGuard.isCurrent(sessionId, _turn)) {
      return res.json({ ok: true, superseded: true, output_text: '', display_text: '', agent: { id: 'superseded-' + Date.now(), status: 'superseded', steps: 0, result: '', errors: [] } });
    }
    try { presenter.present(userText, _agentDisplay, { force: _wantsVisual, sessionId }).catch(() => {}); } catch { /* optional */ }
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
}

// Tier 1 #6: deleted the unused bridge caller (callBridgeTool) and the inline regex
// "simple tools" dispatcher (tryHandleSimpleTools) — it was DEAD CODE (never invoked),
// and tool selection is now the model's own native function calling (agentLoop).

// ---- POST /respond/stream (Tier 2 #10/#11) ----
// SSE wrapper around the SAME /respond handler (zero behavioral fork): the handler runs
// unchanged against a captured response object, and any text-reply LLM call inside it streams
// its tokens out through req._streamDelta. This route assembles those raw tokens into complete
// sentences, shapes each one for TTS (shapeSpokenReply), and emits them as they finish — so the
// voice runner starts speaking ~1 sentence into the reply instead of after the whole thing.
//
// Events:
//   event: sentence  data: {"text": "<TTS-shaped sentence>"}
//   event: done      data: {<full /respond JSON payload>, streamed_sentences: N, http_status: 200}
//
// Paths that can't stream (fast paths, tool loop internals) simply never call the hook; their
// reply arrives whole in the `done` event, identical to blocking /respond. The conversational
// path's NEED_TOOLS escalation sentinel is swallowed here so it is never spoken.
router.post('/respond/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch { /* ignore */ } }

  const send = (event, obj) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  };

  const SENTINEL = 'NEED_TOOLS';
  let buf = '';
  let sentencesSent = 0;

  // NEED_TOOLS is a reserved control token (the conversational path emits it to escalate to the
  // agent/recall path) and must NEVER be spoken. It leaked because the old code only stripped it
  // when it led the buffer and only checked ONCE: in practice the model appends it to the END of
  // a multi-sentence conversational reply ("…Let me search. NEED_TOOLS"), the escalated grounding
  // stream then continues the SAME buffer ("I found…") → "NEED_TOOLSI found…" is spoken. So we
  // scrub EVERY occurrence, wherever it sits, on every delta and again per sentence — position-
  // and count-independent. It only matches the exact reserved form (all-caps, underscore), so
  // natural phrases like "I need tools" are untouched.
  const scrub = (s) => String(s || '').split(SENTINEL).join('');

  const emitSentence = (part) => {
    const raw = scrub(part).replace(/\s+/g, ' ').trim();
    if (!raw) return;
    let spoken = '';
    try { spoken = shapeSpokenReply(raw, req.body || {}); } catch { spoken = raw; }
    if (spoken) {
      sentencesSent++;
      send('sentence', { text: spoken });
    }
  };

  // Pull complete sentences off the front of the buffer. A sentence ends at .!?… (+ closing
  // quote/paren) followed by whitespace, or at a newline; require >=12 chars so fragments like
  // "Dr." or list numbers don't fire alone. force=true flushes whatever remains.
  const flushSentences = (force = false) => {
    for (;;) {
      const m = buf.match(/^([\s\S]{12,}?[.!?…][)"'’”]*)\s+([\s\S]*)$/);
      if (m) { emitSentence(m[1]); buf = m[2]; continue; }
      const nl = buf.indexOf('\n');
      if (nl >= 12) { emitSentence(buf.slice(0, nl)); buf = buf.slice(nl + 1); continue; }
      break;
    }
    if (force && buf.trim()) { emitSentence(buf); buf = ''; }
  };

  req._streamDelta = (piece) => {
    buf += String(piece || '');
    buf = scrub(buf);   // remove the sentinel wherever it lands, before anything can be flushed
    // Tier 2 #15 / #11 UI leg: mirror the scrubbed delta so the reply types into the web client
    // live. assistant.final still closes the bubble.
    const cleanPiece = scrub(piece);
    if (cleanPiece) { try { emitVoiceEvent('assistant.delta', { text: cleanPiece }, 'stream'); } catch { /* ui push is best-effort */ } }
    flushSentences(false);
  };

  // Captured response: the handler only ever uses res.json / res.status(...).json.
  const captured = {
    _status: 200,
    _payload: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._payload = payload; return this; },
  };

  try {
    await respondHandler(req, captured);
  } catch (e) {
    logger.error('[respond/stream] handler failed', { error: e.message });
    captured._status = 500;
    captured._payload = captured._payload || { ok: false, error: e.message };
  }

  // If the handler's final spoken text matches what we streamed, flush any tail still in the
  // buffer; the runner speaks streamed sentences and only falls back to done.output_text when
  // nothing was streamed.
  flushSentences(true);
  const payload = captured._payload || { ok: false, error: 'no response produced' };
  send('done', { ...payload, streamed_sentences: sentencesSent, http_status: captured._status });
  try { res.end(); } catch { /* ignore */ }
});

export default router;
