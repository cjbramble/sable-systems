export const SUPPORT_MODEL_ALIAS = 'customer-support-local';
export const SUPPORT_MODEL_STATUS_URL = 'http://127.0.0.1:8017/v1/models';

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
