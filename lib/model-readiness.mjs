import {
  getSupportModelConfig,
  OPENROUTER_KEY_URL,
  supportModelHeaders,
} from './support-model-config.mjs';

// Check credentials and gateway reachability without a billed generation.
// A valid key does not guarantee credits, endpoint capacity or answer quality.
/**
 * @param {AbortSignal} signal
 * @param {ReturnType<typeof getSupportModelConfig>} [config]
 */
export async function isSupportModelReady(
  signal,
  config = getSupportModelConfig(),
) {
  if (!config.apiKey) return false;
  const response = await fetch(OPENROUTER_KEY_URL, {
    redirect: 'manual',
    headers: supportModelHeaders(config),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const payload = await response.json();
  return Boolean(
    payload?.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data),
  );
}
