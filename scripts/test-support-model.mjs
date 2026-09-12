import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  localModelIsReady,
  modelLaunch,
  waitForModel,
} from './local-model.mjs';
import { createProcessScope, exitStatus } from './process-scope.mjs';

const scope = createProcessScope();
const logPath = resolve('reports/server-logs/llama-test-server.log');
let logFile;
let testExitCode;
let ownedModel;
let releasingModel = false;

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
        'Silent model tests cannot retain model evaluation evidence',
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
  if (!(await localModelIsReady(scope.signal))) {
    scope.signal.throwIfAborted();
    const launch = modelLaunch();
    if (!existsSync(launch.path))
      throw new Error(`Missing model file: ${launch.path}`);
    mkdirSync(dirname(logPath), { recursive: true });
    logFile = openSync(logPath, 'a');
    const model = scope.start(launch.executable, launch.args, {
      stdio: ['ignore', logFile, logFile],
    });
    ownedModel = model;
    void model.exited.then((result) => {
      if (scope.stopping || releasingModel) return;
      console.error(
        result.error
          ? `Could not start llama-server: ${result.error.message}`
          : `llama-server stopped unexpectedly. See ${logPath}`,
      );
      return scope.stop(exitStatus(result) || 1);
    });
    await waitForModel(localModelIsReady, scope.signal);
  }
  scope.signal.throwIfAborted();
  const { code, transcriptPath } = await runVitest();
  testExitCode = code;
  if (!scope.stopping) {
    // Release only our own chatbot model before loading the larger judge.
    if (ownedModel) {
      releasingModel = true;
      await ownedModel.stop();
      await ownedModel.closed;
    }
    const { listSamplingScenarios, getSamplingScenario } =
      await import('./sampling-results.mjs');
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(transcriptPath, 'utf8');
    const hasSamples = listSamplingScenarios().some(
      (scenario) =>
        getSamplingScenario(scenario).parseTranscript(text) !== null,
    );
    if (hasSamples) {
      const judge = scope.start(
        process.execPath,
        ['scripts/test-support-judge.mjs', '--transcript', transcriptPath],
        { stdio: 'inherit' },
      );
      const result = await judge.exited;
      await judge.closed;
      await scope.stop(code || exitStatus(result));
    } else await scope.stop(code);
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
