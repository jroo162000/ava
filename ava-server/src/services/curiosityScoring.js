// Simple relevance scoring helpers for curiosity tasks
// Intentionally minimal; replace with a better model if desired

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

export function computeRelevanceScore(text = '', query = '') {
  if (!text || !query) return 0.5; // neutral
  return jaccardSim(text, query); // 0..1
}

export default { tokenize, jaccardSim, computeRelevanceScore };

