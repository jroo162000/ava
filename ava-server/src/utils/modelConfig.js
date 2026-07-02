// modelConfig — single source of truth for model selection (Tier 1 #8).
// Read at CALL time (not module load) so env overrides apply live.
export function canonicalModels() {
  const env = process.env;
  return {
    claude: env.AVA_SM_CLAUDE || 'claude-opus-4-8',
    openai: [...new Set([env.AVA_SM_OPENAI || 'gpt-5.5', env.AVA_SM_OPENAI_FALLBACK || 'gpt-5.1'])],
    gemini: env.AVA_SM_GEMINI || 'gemini-pro-latest',
    deepseek: env.AVA_SM_DEEPSEEK || 'deepseek-chat',
    grok: env.AVA_SM_GROK || 'grok-4',
  };
}

// The model preferred for agent-loop decisions (tool selection).
export function decisionModel() {
  return process.env.AVA_DECISION_MODEL || 'gpt-5.1';
}

export default { canonicalModels, decisionModel };
