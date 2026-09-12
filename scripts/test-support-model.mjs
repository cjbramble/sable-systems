import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { evaluateModelRunSemantics } from './support-semantic-runs.mjs';
import { modelLaunch, modelUrl, waitForModel } from './local-model.mjs';
import { createProcessScope, exitStatus } from './process-scope.mjs';

const scope = createProcessScope();
const logPath = resolve('reports/server-logs/llama-test-server.log');
let logFile;
let testExitCode;

async function activeModelIsReady(signal) {
  try {
    const response = await fetch(modelUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return (
      Array.isArray(payload?.data) &&
      payload.data.some((model) => model?.id === 'customer-support-local')
    );
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function runVitest() {
  const vitestEntrypoint = resolve('node_modules/vitest/vitest.mjs');
  // Console records are the worker-to-host evidence channel. Do not let a
  // silent/custom reporter turn an executed sampling test into a skipped score.
  const suppliedArgs = process.argv.slice(2);
  const args = [];
  for (let index = 0; index < suppliedArgs.length; index++) {
    const arg = suppliedArgs[index];
    if (arg === '--reporter' || arg.startsWith('--reporter=')) {
      const reporter =
        arg === '--reporter'
          ? suppliedArgs[++index]
          : arg.slice('--reporter='.length);
      if (reporter !== 'verbose')
        throw new Error('Model transcript capture requires --reporter=verbose');
    } else if (arg === '--silent' || arg.startsWith('--silent=')) {
      throw new Error(
        'Silent model tests cannot retain semantic evaluation evidence',
      );
    } else args.push(arg);
  }
  const transcriptPath = resolve(
    'reports/model-runs',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`,
  );
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const transcript = openSync(transcriptPath, 'wx');
  console.info(`Model test transcript: ${transcriptPath}`);
  try {
    const test = scope.start(
      process.execPath,
      [
        vitestEntrypoint,
        'run',
        ...args,
        '--reporter=verbose',
        '--silent=false',
      ],
      {
        env: { ...process.env, SUPPORT_MODEL_TEST: '1' },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    for (const [source, destination] of [
      [test.child.stdout, process.stdout],
      [test.child.stderr, process.stderr],
    ]) {
      source.on('data', (chunk) => {
        writeSync(transcript, chunk);
        destination.write(chunk);
      });
    }
    test.child.once('error', (error) => {
      writeSync(transcript, `Could not start Vitest: ${error.message}\n`);
      console.error(error);
    });
    const result = await test.exited;
    if (result.signal || result.error) void scope.stop(exitStatus(result));
    await test.stop();
    // Wait for streams to close so the transcript retains the final verdict.
    await test.closed;
    return { code: exitStatus(result), transcriptPath };
  } finally {
    closeSync(transcript);
  }
}

try {
  if (!(await activeModelIsReady(scope.signal))) {
    scope.signal.throwIfAborted();
    const launch = modelLaunch();
    if (!existsSync(launch.path))
      throw new Error(`Missing model file: ${launch.path}`);
    mkdirSync(dirname(logPath), { recursive: true });
    logFile = openSync(logPath, 'a');
    const model = scope.start(launch.executable, launch.args, {
      stdio: ['ignore', logFile, logFile],
    });
    void model.exited.then((result) => {
      if (scope.stopping) return;
      console.error(
        result.error
          ? `Could not start llama-server: ${result.error.message}`
          : `llama-server stopped unexpectedly. See ${logPath}`,
      );
      return scope.stop(exitStatus(result) || 1);
    });
    await waitForModel(activeModelIsReady, scope.signal);
  }
  scope.signal.throwIfAborted();
  const { code, transcriptPath } = await runVitest();
  testExitCode = code;
  if (!scope.stopping) {
    const outcome = evaluateModelRunSemantics(transcriptPath, code);
    for (const { scenario, error } of outcome.errors)
      console.error(`Semantic evaluation failed (${scenario}):`, error);
    await scope.stop(outcome.exitCode);
  }
} catch (error) {
  if (!scope.stopping) {
    console.error(error);
    await scope.stop(testExitCode || 1);
  }
} finally {
  await scope.stop();
  if (logFile !== undefined) closeSync(logFile);
  scope.dispose();
  process.exitCode = scope.exitCode;
}
