import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const modelPath = resolve(
  process.env.CUSTOMER_SUPPORT_MODEL_PATH ||
    'models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
);
const llamaExecutable = process.env.LLAMA_SERVER || 'llama-server';
const modelUrl = 'http://127.0.0.1:8017/v1/models';
const logPath = resolve('reports/server-logs/llama-test-server.log');
let ownedModel = null;
let logFile = null;
let stopping = false;

async function activeModelIsReady() {
  try {
    const response = await fetch(modelUrl, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return (
      Array.isArray(payload?.data) &&
      payload.data.some((model) => model?.id === 'customer-support-local')
    );
  } catch {
    return false;
  }
}

async function waitForModel(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ownedModel?.exitCode !== null)
      throw new Error(`llama-server exited with code ${ownedModel?.exitCode}.`);
    if (await activeModelIsReady()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(
    `llama-server was not ready within ${timeoutMs / 1000} seconds.`,
  );
}

function stopOwnedModel() {
  if (stopping) return;
  stopping = true;
  if (ownedModel && ownedModel.exitCode === null) ownedModel.kill('SIGTERM');
  if (logFile !== null) closeSync(logFile);
}

async function runVitest() {
  const vitestEntrypoint = resolve('node_modules/vitest/vitest.mjs');
  const test = spawn(process.execPath, [vitestEntrypoint, 'run'], {
    env: { ...process.env, SUPPORT_MODEL_TEST: '1' },
    stdio: 'inherit',
  });
  return new Promise((resolveExit) => {
    test.once('exit', (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
    test.once('error', () => resolveExit(1));
  });
}

if (!(await activeModelIsReady())) {
  if (!existsSync(modelPath))
    throw new Error(`Missing model file: ${modelPath}`);
  mkdirSync(dirname(logPath), { recursive: true });
  logFile = openSync(logPath, 'a');
  ownedModel = spawn(
    llamaExecutable,
    [
      '--model',
      modelPath,
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
    { stdio: ['ignore', logFile, logFile] },
  );
  ownedModel.once('error', (error) => {
    console.error(`Could not start llama-server: ${error.message}`);
  });
  await waitForModel();
}

process.once('SIGINT', () => {
  stopOwnedModel();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopOwnedModel();
  process.exit(143);
});

try {
  process.exitCode = await runVitest();
} finally {
  stopOwnedModel();
}
