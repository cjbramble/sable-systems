import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const defaultModelPath = resolve(
  'models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
);
const modelPath = resolve(
  process.env.CUSTOMER_SUPPORT_MODEL_PATH || defaultModelPath,
);
const llamaExecutable = process.env.LLAMA_SERVER || 'llama-server';
const host = '127.0.0.1';
const modelPort = 8017;
const webPort = 8016;
const logPath = resolve('reports/server-logs/llama-server.log');

if (!existsSync(modelPath)) {
  console.error(`Missing model file: ${modelPath}`);
  process.exit(1);
}

mkdirSync(dirname(logPath), { recursive: true });
const logFile = openSync(logPath, 'a');
const children = new Set();
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, options);
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForModel(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${modelPort}/v1/models`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The model is still loading.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(
    `llama-server was not ready within ${timeoutMs / 1000} seconds`,
  );
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  try {
    closeSync(logFile);
  } catch {
    // The descriptor may already have been closed during an early startup failure.
  }
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 3_000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`Starting the private Qwen support model on ${host}:${modelPort}…`);
const model = start(
  llamaExecutable,
  [
    '--model',
    modelPath,
    '--host',
    host,
    '--port',
    String(modelPort),
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

model.once('error', (error) => {
  console.error(`Could not start llama-server: ${error.message}`);
  shutdown(1);
});
model.once('exit', (code) => {
  if (!shuttingDown) {
    console.error(`llama-server stopped unexpectedly. See ${logPath}`);
    shutdown(code || 1);
  }
});

try {
  await waitForModel();
  console.log(
    `Local model ready. Starting COV-E at http://${host}:${webPort}…`,
  );
  const web = start('npm', ['run', 'dev:web'], { stdio: 'inherit' });
  web.once('error', (error) => {
    console.error(`Could not start the web app: ${error.message}`);
    shutdown(1);
  });
  web.once('exit', (code) => shutdown(code || 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
