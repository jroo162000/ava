const META_KEYS = new Set(['ok', 'status', 'message', 'error', 'code', 'request_id', 'requestId']);
const SENSITIVE_KEY = /(password|passwd|token|secret|api.?key|authorization|cookie|credential|base64|binary|raw.?audio|pcm|buffer)/i;

function innerResult(result) {
  if (result && typeof result === 'object' && result.result !== undefined) return result.result;
  return result;
}

function safeEvidenceValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}...[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeEvidenceValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : safeEvidenceValue(item, depth + 1),
  ]));
}

export function toolResultMessage(result) {
  const inner = innerResult(result);
  const candidates = [
    inner?.message,
    result?.message,
    typeof inner === 'string' ? inner : '',
  ];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

export function toolResultEvidence(result, limit = 6000) {
  const inner = innerResult(result);
  if (inner == null) return '';
  if (typeof inner === 'string') return inner.trim().slice(0, limit);
  if (Array.isArray(inner)) {
    try { return JSON.stringify(inner, null, 2).slice(0, limit); } catch { return ''; }
  }
  if (typeof inner !== 'object') return String(inner).slice(0, limit);

  if (Array.isArray(inner.results)) {
    return inner.results.map((item, index) => {
      if (!item || typeof item !== 'object') return `(${index + 1}) ${String(item)}`;
      const label = item.title || item.name || '';
      const detail = item.snippet || item.text || item.content || item.summary || '';
      const link = item.url || item.href || '';
      return `(${index + 1}) ${label}${label && detail ? ' - ' : ''}${detail}${link ? ` [${link}]` : ''}`;
    }).join('\n').slice(0, limit);
  }
  if (Array.isArray(inner.matches)) {
    return inner.matches.map((item, index) => `(${index + 1}) ${item?.text || item?.snippet || String(item)}`).join('\n').slice(0, limit);
  }

  const text = inner.text || inner.content || inner.abstract || '';
  if (typeof text === 'string' && text.trim()) return text.trim().slice(0, limit);
  const useful = Object.fromEntries(Object.entries(inner).filter(([key, value]) => !META_KEYS.has(key) && value !== undefined));
  if (!Object.keys(useful).length) return '';
  try { return JSON.stringify(safeEvidenceValue(useful), null, 2).slice(0, limit); } catch { return ''; }
}

export function hasStructuredToolEvidence(result) {
  const inner = innerResult(result);
  if (!inner || typeof inner !== 'object') return false;
  if (Array.isArray(inner)) return inner.length > 0;
  return Object.keys(inner).some(key => !META_KEYS.has(key) && inner[key] !== undefined);
}

export function fallbackToolAnswer(tool, result) {
  const message = toolResultMessage(result);
  if (message) return message;
  const evidence = toolResultEvidence(result, 1200).replace(/\s+/g, ' ').trim();
  if (evidence) return `I completed ${tool}. Here is what it returned: ${evidence}`;
  return `I completed ${tool}, but it did not return any details to report.`;
}

export async function answerFromSuccessfulTool({ tool, result, synthesize }) {
  const message = toolResultMessage(result);
  const shouldSynthesize = !message || hasStructuredToolEvidence(result);
  if (shouldSynthesize && typeof synthesize === 'function') {
    try {
      const answer = String(await synthesize() || '').trim();
      if (answer) return answer;
    } catch { /* deterministic fallback below */ }
  }
  return message || fallbackToolAnswer(tool, result);
}

export default {
  answerFromSuccessfulTool,
  fallbackToolAnswer,
  hasStructuredToolEvidence,
  toolResultEvidence,
  toolResultMessage,
};
