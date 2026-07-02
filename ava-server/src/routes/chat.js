// POST /chat — the typed-chat endpoint (conversational-first, NEED_TOOLS escalation to the
// agent loop). Extracted verbatim from routes/api.js (Tier 2 split) — logic unchanged.
import express from 'express';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import llmService from '../services/llm.js';
import conversationLogger from '../services/conversationLogger.js';
import environmentContext from '../services/environmentContext.js';
import artifactMemory from '../services/artifactMemory.js';
import actionHistory from '../services/actionHistory.js';
import { normalizeMoltbookMentions } from '../services/speech.js';
import { markDuplicateTurn } from './api.js';

function sanitizeChatText(t){
  try {
    let s = String(t||'')
    // Remove any file:/// temp references and internal temp names
    s = s.replace(/file:\/\/[\w\-_.:%/]+/gi, '[link removed]')
    s = s.replace(/ava_tmp_[A-Za-z0-9]+\.html/gi, '[temp removed]')
    return s
  } catch { return t }
}

const router = express.Router();

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

    const startTime = Date.now();



    // Tier 1 #6/#8: the typed-chat regex dispatcher (~500 lines of hardwired phrase→action
    // mappings for recall/filegen/time/date/moltbook/creative/file ops/web automation/file
    // search) is GONE. /chat now works like /respond's conversational path: her normal brain
    // answers directly, and when the request needs real tools or live data she emits the
    // NEED_TOOLS sentinel and escalates to the agent loop, where the model selects tools
    // NATIVELY (full schemas via function calling).
    const chatRouting = 'IMPORTANT: In this mode you can ONLY talk right now — you cannot directly run a tool this turn. If the user asks you to DO something (create/read/open files or documents, send messages or email, calendar changes, control the computer, browse or automate the web, post to or check Moltbook), OR asks about their CURRENT external data (their real calendar, inbox/emails, files, system status, the Moltbook feed), OR asks you to RECALL or SEARCH something from PAST conversations that is NOT already visible in the recent turns, do NOT guess, fake, promise, or say you can\'t — respond with EXACTLY this token and nothing else: NEED_TOOLS. That escalates to your real tools (including memory_search over your saved memory and full conversation history).';

    const result = await llmService.chatCompletion(sessionId, text, {
      includeMemory,
      storeInMemory,
      freshSession,
      extraSystem: chatRouting
    });

    let responseText = String(result.content || '').trim();
    let usage = result.usage;

    if (/\bNEED_TOOLS\b/i.test(responseText)) {
      logger.info('[chat] escalating to agent loop', { text: text.slice(0, 60) });
      const loopOptions = { source: 'chat' };
      try { loopOptions.environment = await environmentContext.buildEnvironmentBlock(); } catch { /* optional */ }
      try {
        const recent = conversationLogger.getRecentHistoryAcrossDays(12) || [];
        loopOptions.recentHistory = recent.slice(0, -1).slice(-8);
        loopOptions.recentArtifacts = artifactMemory.recent(6);
      } catch { /* context optional */ }
      const state = await (await import('../services/agentLoop.js')).default.runAgentLoop(text, loopOptions);
      try { artifactMemory.recordFromHistory(sessionId, state.history); } catch { /* optional */ }
      try { actionHistory.recordTurn(sessionId, state); } catch { /* optional */ }
      responseText = String(state.final_result || '').trim();
      if (String(state.status || '') === 'waiting_user' && state.last_action?.question) {
        responseText = state.last_action.question;
      }
      if (!responseText) responseText = "I tried to do that, but couldn't complete it.";
      usage = undefined;
    }

    responseText = sanitizeChatText(responseText);
    const responseTime = Date.now() - startTime;

    // Log assistant response
    conversationLogger.logAssistantMessage(responseText, {
      sessionId,
      responseTime,
      userMessageId,
      tokens: usage,
      model: result.model || config.REALTIME_MODEL
    });

    res.json({
      ok: true,
      text: responseText,
      sessionId,
      usage
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

// Tier 1 #8: deleted dead routeMessage/handleDirectResponse (never called).

export default router;
