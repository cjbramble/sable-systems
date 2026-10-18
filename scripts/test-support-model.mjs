// @ts-check
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createProcessScope, exitStatus } from './lib/process-scope.mjs';
import { loadLocalEnvironment } from './lib/environment.mjs';
import { createLineFramer } from './lib/line-framer.mjs';
import { parseModelTestArgs, shellQuote } from './lib/model-test-args.mjs';
import {
  getSupportModelConfig,
  supportModelHeaders,
} from '../lib/support-model-config.mjs';

const scope = createProcessScope();
let testExitCode;

/** @param {string[]} args */
async function runVitest(args) {
  const vitestEntrypoint = resolve('node_modules/vitest/vitest.mjs');
  const transcriptPath = resolve(
    'reports/model-runs',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`,
  );
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const transcript = openSync(transcriptPath, 'wx');
  console.info(`Model test transcript: ${transcriptPath}`);
  /** @type {(() => void)[]} */
  const detach = [];
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
    /** @type {[import('node:stream').Readable | null, NodeJS.WriteStream][]} */
    const streams = [
      [test.child.stdout, process.stdout],
      [test.child.stderr, process.stderr],
    ];
    for (const [source, destination] of streams) {
      if (!source) throw new Error('Vitest output pipe was not created');
      // Frame each stream by line so stderr cannot split a stdout sample record.
      const lines = createLineFramer((data) => writeSync(transcript, data));
      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        lines.push(chunk);
        destination.write(chunk);
      };
      source.on('data', onData);
      detach.push(() => {
        source.off('data', onData);
        source.destroy();
        lines.flush();
      });
    }
    /** @param {Error} error */
    const onError = (error) => {
      writeSync(transcript, `Could not start Vitest: ${error.message}\n`);
      console.error(error);
    };
    test.child.once('error', onError);
    detach.push(() => test.child.off('error', onError));
    const result = await test.exited;
    if (result.signal || result.error) void scope.stop(exitStatus(result));
    await test.stop();
    // Wait for streams to close so the transcript retains the final verdict.
    await test.closed;
    return { code: exitStatus(result), transcriptPath };
  } finally {
    // Stop writing before the descriptor closes or another file reuses it.
    for (const stopWriting of detach) stopWriting();
    closeSync(transcript);
  }
}

try {
  loadLocalEnvironment();
  const config = getSupportModelConfig(process.env);
  supportModelHeaders(config);
  console.info(
    `Live tests use OpenRouter ${config.model}; API requests are billed.`,
  );
  const { vitestArgs, judge: runJudge } = parseModelTestArgs(
    process.argv.slice(2),
  );
  scope.signal.throwIfAborted();
  const { code, transcriptPath } = await runVitest(vitestArgs);
  testExitCode = code;
  if (!scope.stopping && !runJudge) {
    console.info(
      `Skipped the billed judge (--no-judge). To judge later: npm run test:judge -- --transcript ${shellQuote(transcriptPath)}`,
    );
    await scope.stop(code);
  } else if (!scope.stopping) {
    const { listSamplingScenarios, getSamplingScenario } =
      await import('../tools/evaluation/sampling-results.mjs');
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
  scope.dispose();
  process.exitCode = scope.exitCode;
}
