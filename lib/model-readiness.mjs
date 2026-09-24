export const SUPPORT_MODEL_ALIAS = 'customer-support-local';
export const SUPPORT_MODEL_STATUS_URL = 'http://127.0.0.1:8017/v1/models';
// Shared by the launcher (--ctx-size) and request budgeting in the app.
export const SUPPORT_MODEL_CONTEXT_TOKENS = 4096;
export const SUPPORT_MODEL_MAX_REPLY_TOKENS = 600;

// This checks advertised model identity, not weights or inference quality.
/** @param {AbortSignal} signal */
export async function isSupportModelReady(signal) {
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
