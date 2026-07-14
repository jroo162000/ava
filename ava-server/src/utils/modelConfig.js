// Single source of truth for provider order and model selection. Environment
// values are read at call time so AVA can change models without code edits.
const FALLBACKS = Object.freeze({
  claude: 'claude-haiku-4-5-20251001',
  openai: ['gpt-5.1', 'gpt-4o-mini'],
  gemini: 'gemini-pro-latest',
  deepseek: 'deepseek-chat',
  grok: 'grok-4',
  groq: 'llama-3.3-70b-versatile',
});

// Proposal review is deliberately independent from AVa's everyday response models.
// Try each provider's strongest current model first, then its strongest broadly
// available fallback if the account has not received the newest model yet.
const REVIEW_FALLBACKS = Object.freeze({
  claude: Object.freeze(['claude-fable-5', 'claude-opus-4-8']),
  openai: Object.freeze(['gpt-5.6-sol', 'gpt-5.5']),
  gemini: Object.freeze(['gemini-3.1-pro-preview', 'gemini-3.5-flash']),
  deepseek: Object.freeze(['deepseek-v4-pro', 'deepseek-v4-flash']),
  grok: Object.freeze(['grok-4.5', 'grok-4.3']),
  groq: Object.freeze(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']),
});

const DEFAULT_PROVIDER_ORDER = Object.freeze(['claude', 'openai', 'gemini', 'deepseek', 'grok', 'groq', 'local']);

function values(...items) {
  return [...new Set(items.flatMap(item => String(item || '').split(',')).map(item => item.trim()).filter(Boolean))];
}

export function providerOrder() {
  const configured = values(process.env.AVA_PROVIDER_ORDER);
  const requested = configured.length ? configured : DEFAULT_PROVIDER_ORDER;
  // AVA_PROVIDER_ORDER may reorder cloud vendors, but the local model remains the
  // final safety net. This keeps a stale/mistyped override from silently making the
  // constrained local model AVa's primary brain.
  return [...requested.filter(provider => provider !== 'local'), 'local'];
}

export function canonicalModels() {
  const env = process.env;
  const openai = values(env.AVA_SM_OPENAI, env.AVA_SM_OPENAI_FALLBACK, env.AVA_OPENAI_MODEL, env.CHAT_MODEL);
  return {
    claude: values(env.AVA_SM_CLAUDE, env.AVA_CLAUDE_MODEL)[0] || FALLBACKS.claude,
    openai: openai.length ? openai : FALLBACKS.openai,
    gemini: values(env.AVA_SM_GEMINI, env.AVA_GEMINI_MODEL)[0] || FALLBACKS.gemini,
    deepseek: values(env.AVA_SM_DEEPSEEK, env.AVA_DEEPSEEK_MODEL)[0] || FALLBACKS.deepseek,
    grok: values(env.AVA_SM_GROK, env.AVA_GROK_MODEL)[0] || FALLBACKS.grok,
    groq: values(env.AVA_SM_GROQ, env.AVA_GROQ_MODEL)[0] || FALLBACKS.groq,
  };
}

// Leaving this unset deliberately lets the healthy provider chain choose the
// decision model. Set AVA_DECISION_MODEL only when a verified model must be pinned.
export function decisionModel() {
  return String(process.env.AVA_DECISION_MODEL || '').trim() || undefined;
}

export function modelFor(provider) {
  const models = canonicalModels();
  const selected = models[provider];
  return Array.isArray(selected) ? selected[0] : selected;
}

export function proposalReviewerModels() {
  const env = process.env;
  return {
    claude: values(env.AVA_REVIEW_CLAUDE).length ? values(env.AVA_REVIEW_CLAUDE) : [...REVIEW_FALLBACKS.claude],
    openai: values(env.AVA_REVIEW_OPENAI).length ? values(env.AVA_REVIEW_OPENAI) : [...REVIEW_FALLBACKS.openai],
    gemini: values(env.AVA_REVIEW_GEMINI).length ? values(env.AVA_REVIEW_GEMINI) : [...REVIEW_FALLBACKS.gemini],
    deepseek: values(env.AVA_REVIEW_DEEPSEEK).length ? values(env.AVA_REVIEW_DEEPSEEK) : [...REVIEW_FALLBACKS.deepseek],
    grok: values(env.AVA_REVIEW_GROK).length ? values(env.AVA_REVIEW_GROK) : [...REVIEW_FALLBACKS.grok],
    groq: values(env.AVA_REVIEW_GROQ).length ? values(env.AVA_REVIEW_GROQ) : [...REVIEW_FALLBACKS.groq],
  };
}

export default { canonicalModels, decisionModel, modelFor, proposalReviewerModels, providerOrder };
