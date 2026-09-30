import {
  getSupportModelConfig,
  supportModelHeaders,
} from './support-model-config.mjs';

export const SUPPORT_MODEL_ALIAS = 'customer-support-local';
export const SUPPORT_MODEL_STATUS_URL = 'http://127.0.0.1:8017/v1/models';
// Shared by the launcher (--ctx-size) and request budgeting in the app.
export const SUPPORT_MODEL_CONTEXT_TOKENS = 4096;
export const SUPPORT_MODEL_MAX_REPLY_TOKENS = 600;

// Local readiness checks advertised model identity; hosted readiness checks
// credentials and reachability. Neither checks inference quality.
/**
 * @param {AbortSignal} signal
 * @param {ReturnType<typeof getSupportModelConfig>} [config]
 */
export async function isSupportModelReady(
  signal,
  config = getSupportModelConfig(),
) {
  if (config.provider === 'openrouter') {
    if (!config.apiKey) return false;
    // No generation or charge: checks credentials and gateway reachability.
    // A valid key does not guarantee credits, endpoint capacity or answer quality.
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: supportModelHeaders(config),
      signal,
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Boolean(
      payload?.data &&
      typeof payload.data === 'object' &&
      !Array.isArray(payload.data),
    );
  }
  const response = await fetch(SUPPORT_MODEL_STATUS_URL, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) return false;
  const payload = await response.json();
  return (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray(payload.data) &&
    payload.data.some((model) => model?.id === SUPPORT_MODEL_ALIAS)
  );
}
