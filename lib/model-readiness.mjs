import {
  getSupportModelConfig,
  OPENROUTER_KEY_URL,
  supportModelHeaders,
} from './support-model-config.mjs';

// The support page polls every 10 seconds from each open tab; one isolate
// shares a result for this long so tabs do not each reach the provider.
export const MODEL_READINESS_CACHE_MS = 5_000;

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
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    // A proxy or captive portal can answer 200 with HTML: not ready, not a fault.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return Boolean(
    payload?.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data),
  );
}
