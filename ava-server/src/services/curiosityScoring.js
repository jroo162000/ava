// Simple relevance scoring helpers for curiosity tasks
// Augmented with execution-history context for per-agent decay-based bonus

export function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function jaccardSim(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  const inter = [...ta].filter(x => tb.has(x)).length;
  const uni = new Set([...ta, ...tb]).size;
  return uni === 0 ? 0 : inter / uni;
}

// Stores per-agent execution results: agentId -> [{success:bool, timestamp:ms}]
const executionHistory = new Map();

// Records an execution outcome for a given agent for later scoring influence
/**
 * @param {string} agentId
 * @param {boolean} success
 */
export function recordExecution(agentId, success) {
  if (!agentId) return;
  if (!executionHistory.has(agentId)) {
    executionHistory.set(agentId, []);
  }
  const entries = executionHistory.get(agentId);
  // Keep last 20 entries for scoring
  entries.push({ success, timestamp: Date.now() });
  if (entries.length > 20) entries.shift();
}

// Clears execution history for a given agent (useful for reset or testing)
export function clearHistory(agentId) {
  if (agentId) {
    executionHistory.delete(agentId);
  } else {
    executionHistory.clear();
  }
}

// Get the decay-based modifier from execution history: reward recent successes, penalize consecutive failures
function _getHistoryModifier(agentId) {
  if (!agentId || !executionHistory.has(agentId)) return 0;
  const entries = executionHistory.get(agentId);
  // Apply time-based decay: recent 60s = full weight, older entries fade linearly
  const now = Date.now();
  const DECAY_MS = 60_000;
  let weightedSuccess = 0;
  let totalWeight = 0;
  for (const e of entries) {
    const age = now - e.timestamp;
    const weight = age <= DECAY_MS ? (1 - age / DECAY_MS) : 0;
    if (weight <= 0) continue;
    weightedSuccess += (e.success ? 1 : 0) * weight;
    totalWeight += weight;
  }
  // Count consecutive failures at the tail (most recent entries, up to last 5)
  let consecutiveFailures = 0;
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 5; i--) {
    if (!entries[i].success) consecutiveFailures++;
    else break;
  }
  // Decay penalty: -0.15 per consecutive failure beyond 3
  const failPenalty = consecutiveFailures > 3 ? (consecutiveFailures - 3) * -0.15 : 0;
  // Boost if most recent weighted success ratio is high (>80%)
  let successRatio = totalWeight > 0 ? weightedSuccess / totalWeight : 0.5;
  const boostBonus = successRatio > 0.8 ? 0.2 : 0;
  return failPenalty + boostBonus;
}

export function computeRelevanceScore(text = '', query = '', agentId = '') {
  if (!text || !query) return 0.5; // neutral
  const base = jaccardSim(text, query); // 0..1
  const modifier = _getHistoryModifier(agentId); // -0.6 .. +0.2
  const result = Math.max(0, Math.min(1, base + modifier));
  return result;
}

export default { tokenize, jaccardSim, computeRelevanceScore, recordExecution, clearHistory };

