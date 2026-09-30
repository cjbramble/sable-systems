export const OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const OPENROUTER_CHAT_URL =
  'https://openrouter.ai/api/v1/chat/completions';

/**
 * @typedef {{ SUPPORT_MODEL_PROVIDER?: string, OPENROUTER_API_KEY?: string,
 * OPENROUTER_SUPPORT_MODEL?: string }} SupportModelEnvironment
 */

/** @param {SupportModelEnvironment} [variables] */
export function getSupportModelConfig(variables = {}) {
  const provider = variables.SUPPORT_MODEL_PROVIDER?.trim() || 'local';
  if (provider !== 'local' && provider !== 'openrouter')
    throw new Error('SUPPORT_MODEL_PROVIDER must be local or openrouter.');
  return {
    provider,
    model:
      provider === 'local'
        ? 'customer-support-local'
        : variables.OPENROUTER_SUPPORT_MODEL?.trim() || OPENROUTER_MODEL,
    url:
      provider === 'local'
        ? 'http://127.0.0.1:8017/v1/chat/completions'
        : OPENROUTER_CHAT_URL,
    apiKey: variables.OPENROUTER_API_KEY?.trim() || '',
    // Bound prompt size and cost rather than filling the hosted context window.
    contextTokens: provider === 'local' ? 4096 : 8192,
  };
}

export const OPENROUTER_ROUTING = {
  only: ['deepinfra/fp8'],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: 'deny',
  zdr: true,
};

/** @param {ReturnType<typeof getSupportModelConfig>} config */
export function supportModelHeaders(config) {
  if (config.provider === 'openrouter' && !config.apiKey)
    throw new Error('Fill in OPENROUTER_API_KEY in .env before starting.');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(config.provider === 'openrouter'
      ? {
          Authorization: `Bearer ${config.apiKey}`,
          'X-OpenRouter-Title': 'SABLE COV-E',
        }
      : {}),
  };
}
