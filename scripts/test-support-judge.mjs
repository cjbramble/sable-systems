// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import defaults from '../lib/openrouter-config.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  listSamplingScenarios,
  getSamplingScenario,
} from '../tools/evaluation/sampling-results.mjs';
import { createProcessScope, exitStatus } from './lib/process-scope.mjs';
import { loadLocalEnvironment } from './lib/environment.mjs';
import {
  getSupportModelConfig,
  supportModelHeaders,
} from '../lib/support-model-config.mjs';

const scope = createProcessScope();
try {
  loadLocalEnvironment();
  const { values } = parseArgs({
    options: {
      transcript: { type: 'string' },
      category: { type: 'string', multiple: true },
      list: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '1' },
    },
    allowPositionals: false,
  });
  if (values.transcript && (values.category || values.list))
    throw new Error(
      '--transcript cannot be combined with --category or --list.',
    );
  if (!/^1$/.test(values.concurrency))
    throw new Error('Choose --concurrency 1; DeepEval runs are serial.');
  const config = values.list
    ? null
    : getSupportModelConfig({
        ...process.env,
        OPENROUTER_SUPPORT_MODEL: defaults.judgeModel,
      });
  if (config) supportModelHeaders(config);
  /** @type {{mode: string, categories: string[], list: boolean, concurrency: number,
   * batches: Record<string, NonNullable<ReturnType<ReturnType<typeof getSamplingScenario>['parseTranscript']>>>,
   * sourceTranscript?: string, sourceSha256?: string}} */
  const payload = {
    mode: values.transcript ? 'transcript' : 'collection',
    categories: values.category || [],
    list: values.list,
    concurrency: Number(values.concurrency),
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
  const python = resolve(
    'tools/evaluation/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const reportPath = resolve(
    'reports/judge-runs',
    `${payload.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
  );
  if (config)
    console.info(`Judging with ${config.provider}; report: ${reportPath}`);
  const evaluation = scope.start(
    python,
    ['tools/evaluation/evaluate_support.py', '--output', reportPath],
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
  if (!evaluation.child.stdin)
    throw new Error('Judge input pipe was not created');
  evaluation.child.stdin.on('error', (error) => {
    if (!('code' in error) || error.code !== 'EPIPE') console.error(error);
  });
  evaluation.child.stdin.end(JSON.stringify(payload));
  const result = await evaluation.exited;
  await evaluation.closed;
  if (result.error) {
    if (result.error.code === 'ENOENT')
      console.error(
        'The judge interpreter is unavailable. Run npm run setup:judge to prepare it.',
      );
    console.error(result.error);
  }
  await scope.stop(exitStatus(result));
} catch (error) {
  if (!scope.stopping) console.error(error);
  await scope.stop(1);
} finally {
  await scope.stop();
  scope.dispose();
  process.exitCode = scope.exitCode;
}
