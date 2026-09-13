import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  isSupportModelReady,
  SUPPORT_MODEL_ALIAS,
} from '../../lib/model-readiness.mjs';

export async function localModelIsReady(signal) {
  try {
    return await isSupportModelReady(
      AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    );
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

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
      SUPPORT_MODEL_ALIAS,
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
