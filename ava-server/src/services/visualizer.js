// visualizer.js -- decides whether a small visual would help the user follow AVA's answer, and if
// so produces it and pushes it to the artifact panel. This is the "pop up a visual reference while
// she explains" behavior: it runs fire-and-forget AFTER the spoken reply is sent, so it never adds
// latency to the conversation. On an explicit request ("show me a diagram") it's forced to produce one.
import llmService from './llm.js';
import artifactBus from './artifactBus.js';
import logger from '../utils/logger.js';

const SYS = `You decide whether a small VISUAL would help a user follow an assistant's spoken answer, and if so you produce it.
Return ONLY JSON, one of these shapes:
{"type":"none"} - when no visual would meaningfully help (small talk, a one-line answer, an action confirmation).
{"type":"mermaid","title":"...","content":"<valid mermaid>"} - for processes, flows, relationships, hierarchies, timelines, or step comparisons.
{"type":"table","title":"...","content":"<github-flavored markdown table>"} - for comparisons across a few attributes or structured lists.
{"type":"markdown","title":"...","content":"<short markdown>"} - for a compact structured recap (a few headers/bullets) of an explanation.
Rules: keep it SMALL and CORRECT. Mermaid MUST be valid and start with a diagram type (e.g. "flowchart TD" or "sequenceDiagram"); use short node labels and NO parentheses/quotes inside labels. Never invent facts beyond the answer. Prefer {"type":"none"} unless a visual clearly aids understanding.`;

export async function maybeVisualize(userText, replyText, { force = false, sessionId = '' } = {}) {
  try {
    const reply = String(replyText || '').trim();
    if (!force && reply.length < 220) return null; // skip short / chit-chat unless explicitly asked
    const usr = `User asked:\n${String(userText || '').slice(0, 800)}\n\nAssistant answered:\n${reply.slice(0, 2500)}\n\n${force ? 'The user EXPLICITLY asked to SEE a visual/diagram/panel, so you MUST return a mermaid, table, or markdown artifact (never "none").' : 'Decide if a visual would genuinely help.'}`;
    const r = await llmService.chat(
      [{ role: 'system', content: SYS }, { role: 'user', content: usr }],
      { temperature: 0.2, max_tokens: 700 }
    );
    const raw = String(r.text || r.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let spec;
    try { spec = JSON.parse(m[0]); } catch { return null; }
    if (!spec || !spec.type || spec.type === 'none') return null;
    if (!['mermaid', 'table', 'markdown', 'note', 'text'].includes(spec.type)) return null;
    if (!String(spec.content || '').trim()) return null;
    return artifactBus.push({ type: spec.type, title: spec.title || '', content: spec.content, meta: { auto: !force, sessionId } });
  } catch (e) { logger.warn('[visualizer] failed', { error: e.message }); return null; }
}

export default { maybeVisualize };
