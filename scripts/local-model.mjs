import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const modelUrl = 'http://127.0.0.1:8017/v1/models';

export function modelLaunch() {
  const path = resolve(
    process.env.CUSTOMER_SUPPORT_MODEL_PATH ||
      'models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  );
  return {
    path,
    executable: process.env.LLAMA_SERVER || 'llama-server',
    args: [
      '--model',
      path,
      '--host',
      '127.0.0.1',
      '--port',
      '8017',
      '--ctx-size',
      '4096',
      '--n-gpu-layers',
      '99',
      '--jinja',
      '--alias',
      'customer-support-local',
    ],
  };
}

export async function waitForModel(checkReady, signal, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let ready;
    try {
      ready = await Promise.race([checkReady(signal), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (ready) {
      signal.throwIfAborted();
      return;
    }
    await delay(500, undefined, { signal });
  }
  throw new Error(
    `llama-server was not ready within ${timeoutMs / 1000} seconds.`,
  );
}
