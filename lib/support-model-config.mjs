import defaults from './openrouter-config.json' with { type: 'json' };

export const OPENROUTER_MODEL = defaults.model;
export const OPENROUTER_CHAT_URL =
  'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
// Bound prompt size and cost rather than filling the hosted context window.
export const SUPPORT_MODEL_CONTEXT_TOKENS = 8192;
export const SUPPORT_MODEL_MAX_REPLY_TOKENS = 600;

/**
 * @typedef {{ OPENROUTER_API_KEY?: string,
 * OPENROUTER_SUPPORT_MODEL?: string }} SupportModelEnvironment
 */

/** @param {SupportModelEnvironment} [variables] */
export function getSupportModelConfig(variables = {}) {
  return {
    provider: 'openrouter',
    model: variables.OPENROUTER_SUPPORT_MODEL?.trim() || OPENROUTER_MODEL,
    url: OPENROUTER_CHAT_URL,
    apiKey: variables.OPENROUTER_API_KEY?.trim() || '',
    contextTokens: SUPPORT_MODEL_CONTEXT_TOKENS,
  };
}

export const OPENROUTER_ROUTING = defaults.provider;

/** @param {ReturnType<typeof getSupportModelConfig>} config */
export function supportModelHeaders(config) {
  if (!config.apiKey)
    throw new Error('Fill in OPENROUTER_API_KEY in .env before starting.');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'X-OpenRouter-Title': 'SABLE COV-E',
  };
}
