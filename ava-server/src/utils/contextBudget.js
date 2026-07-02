// contextBudget — real context-window budgeting (Tier 1 #7).
//
// Every LLM call flows through llm.js createCompletion, so this is the single choke point:
// estimate tokens (~4 chars/token heuristic — no tokenizer dependency, works offline) and
// trim with PRIORITIES before anything hits a provider:
//   1. the system prompt is kept (truncated in the middle only as a last resort)
//   2. the LAST user message is always kept whole-ish (it is the actual request)
//   3. remaining messages are kept newest-first until the budget is spent
//   4. any single oversized message is middle-truncated (head + tail preserved — tool
//      results carry their conclusion at the tail, instructions at the head)
//
// Budget defaults to AVA_CONTEXT_BUDGET_TOKENS (else 20000) so the WHOLE fallback chain —
// including the local 7B model — fits, minus the completion reservation.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(s) {
  return Math.ceil(String(s || '').length / CHARS_PER_TOKEN);
}

function middleTruncate(text, maxTokens) {
  const t = String(text || '');
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (t.length <= maxChars) return t;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${t.slice(0, head)}\n…[trimmed ${t.length - maxChars} chars for context budget]…\n${t.slice(t.length - tail)}`;
}

/**
 * Fit { system, messages } into the context budget.
 * @returns {{ system, messages, trimmed: boolean, tokens: number }}
 */
export function fit({ system, messages, completionTokens = 1000, budgetTokens }) {
  const budget = budgetTokens
    || parseInt(process.env.AVA_CONTEXT_BUDGET_TOKENS || '', 10)
    || 20000;
  const msgs = Array.isArray(messages) ? messages.filter(m => m && typeof m.content === 'string') : [];
  const available = Math.max(2000, budget - completionTokens);

  let sys = system == null ? system : String(system);
  let sysTokens = estimateTokens(sys || '');
  const before = sysTokens + msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (before <= available) return { system: sys, messages: msgs, trimmed: false, tokens: before };

  // 1. Cap the system prompt at 60% of the window (middle-truncate — keep identity/rules
  //    at the head and the freshest context blocks at the tail).
  const sysCap = Math.floor(available * 0.6);
  if (sysTokens > sysCap) { sys = middleTruncate(sys, sysCap); sysTokens = estimateTokens(sys); }

  let remaining = available - sysTokens;

  // 2. The last user message is the actual request — reserve it first (cap at half the rest).
  const kept = new Array(msgs.length).fill(null);
  const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user');
  if (lastUserIdx >= 0) {
    const capped = middleTruncate(msgs[lastUserIdx].content, Math.max(500, Math.floor(remaining / 2)));
    kept[lastUserIdx] = { ...msgs[lastUserIdx], content: capped };
    remaining -= estimateTokens(capped);
  }

  // 3. Everything else newest-first; per-message cap so one giant tool dump can't eat it all.
  const perMsgCap = Math.max(400, Math.floor(available / 8));
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (i === lastUserIdx || remaining <= 0) continue;
    const content = middleTruncate(msgs[i].content, perMsgCap);
    const cost = estimateTokens(content);
    if (cost <= remaining) { kept[i] = { ...msgs[i], content }; remaining -= cost; }
  }

  const out = kept.filter(Boolean);
  const tokens = sysTokens + out.reduce((s, m) => s + estimateTokens(m.content), 0);
  return { system: sys, messages: out, trimmed: true, tokens };
}

export default { estimateTokens, fit };
