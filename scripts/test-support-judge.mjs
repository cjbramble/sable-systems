import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import manifest from './judge/model.json' with { type: 'json' };
import {
  listSamplingScenarios,
  getSamplingScenario,
} from './sampling-results.mjs';
import { waitForModel } from './local-model.mjs';
import { createProcessScope, exitStatus } from './process-scope.mjs';

const scope = createProcessScope();
let logFile;
try {
  const { values } = parseArgs({
    options: {
      transcript: { type: 'string' },
      holdout: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.transcript && values.holdout)
    throw new Error('Choose either --transcript or --holdout.');
  const payload = {
    mode: values.transcript ? 'transcript' : 'validation',
    validationSet: values.holdout ? 'holdout' : 'all',
    batches: {},
  };
  if (values.transcript) {
    const text = readFileSync(values.transcript, 'utf8');
    payload.sourceTranscript = resolve(values.transcript);
    payload.sourceSha256 = createHash('sha256').update(text).digest('hex');
    for (const scenario of listSamplingScenarios()) {
      const batch = getSamplingScenario(scenario).parseTranscript(text);
      if (batch) payload.batches[scenario] = batch;
    }
    if (!Object.keys(payload.batches).length)
      throw new Error('Transcript contains no sampling scenarios to judge.');
  }
  // Reuse the registered model port, never replace or stop an external server.
  await new Promise((resolveProbe, reject) => {
    const probe = createServer();
    probe.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              'Port 8017 is occupied. Stop the app/model first; the judge runs separately to limit memory use.',
            )
          : error,
      ),
    );
    probe.listen(8017, '127.0.0.1', () => probe.close(resolveProbe));
  });
  const modelPath = resolve(manifest.path);
  if (statSync(modelPath).size !== manifest.bytes)
    throw new Error('Judge file size mismatch. Run npm run setup:judge.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(modelPath)) {
    scope.signal.throwIfAborted();
    hash.update(chunk);
  }
  if (hash.digest('hex') !== manifest.sha256)
    throw new Error('Judge checksum mismatch.');
  const python = resolve(
    'scripts/judge/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const logPath = resolve('reports/server-logs/llama-judge-server.log');
  mkdirSync(dirname(logPath), { recursive: true });
  logFile = openSync(logPath, 'a');
  const server = scope.start(
    process.env.LLAMA_SERVER || 'llama-server',
    [
      '--model',
      modelPath,
      '--alias',
      manifest.alias,
      '--host',
      '127.0.0.1',
      '--port',
      '8017',
      '--ctx-size',
      '8192',
      '--parallel',
      '1',
      '--n-gpu-layers',
      '99',
      '--jinja',
      '--chat-template-kwargs',
      '{"enable_thinking":false}',
      '--offline',
    ],
    { stdio: ['ignore', logFile, logFile] },
  );
  void server.exited.then((result) => {
    if (!scope.stopping) {
      console.error(`Judge server exited unexpectedly; see ${logPath}`);
      void scope.stop(exitStatus(result) || 1);
    }
  });
  await waitForModel(async (signal) => {
    try {
      const response = await fetch('http://127.0.0.1:8017/v1/models', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body.data?.some((model) => model.id === manifest.alias) === true;
    } catch {
      return false;
    }
  }, scope.signal);
  const reportPath = resolve(
    'reports/judge-runs',
    `${payload.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
  );
  console.info(`Judging locally; report: ${reportPath}`);
  const evaluation = scope.start(
    python,
    ['scripts/judge/evaluate.py', '--output', reportPath],
    {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        DEEPEVAL_TELEMETRY_OPT_OUT: '1',
        DEEPEVAL_DISABLE_DOTENV: '1',
        DEEPEVAL_FILE_SYSTEM: 'READ_ONLY',
      },
    },
  );
  evaluation.child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error);
  });
  evaluation.child.stdin.end(JSON.stringify(payload));
  const result = await evaluation.exited;
  await evaluation.closed;
  await scope.stop(exitStatus(result));
} catch (error) {
  if (!scope.stopping) console.error(error);
  await scope.stop(1);
} finally {
  await scope.stop();
  if (logFile !== undefined) closeSync(logFile);
  scope.dispose();
  process.exitCode = scope.exitCode;
}
