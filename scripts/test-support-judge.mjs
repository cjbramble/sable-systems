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
  const config = getSupportModelConfig({
    ...process.env,
    OPENROUTER_SUPPORT_MODEL:
      process.env.OPENROUTER_JUDGE_MODEL?.trim() || defaults.judgeModel,
  });
  supportModelHeaders(config);
  const { values } = parseArgs({
    options: {
      transcript: { type: 'string' },
      suite: { type: 'string', default: 'legacy' },
      holdout: { type: 'boolean', default: false },
      'claims-pilot': { type: 'boolean', default: false },
      'direct-claim-pilot': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (
    [
      values.transcript,
      values.holdout,
      values['claims-pilot'],
      values['direct-claim-pilot'],
    ].filter(Boolean).length > 1
  )
    throw new Error(
      'Choose only one of --transcript, --holdout, --claims-pilot, or --direct-claim-pilot.',
    );
  if (
    !['legacy', 'coverage', 'benchmark', 'claims', 'extraction'].includes(
      values.suite,
    )
  )
    throw new Error(
      'Choose --suite legacy, coverage, benchmark, claims, or extraction.',
    );
  if (
    values.suite !== 'legacy' &&
    [
      values.transcript,
      values.holdout,
      values['claims-pilot'],
      values['direct-claim-pilot'],
    ].some(Boolean)
  )
    throw new Error(
      'Expanded suites cannot be combined with transcript, holdout, or pilot modes.',
    );
  const payload = {
    suite: values.suite,
    mode: values['direct-claim-pilot']
      ? 'direct-claim-pilot'
      : values['claims-pilot']
        ? 'claims-pilot'
        : values.transcript
          ? 'transcript'
          : 'validation',
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
  const python = resolve(
    'tools/evaluation/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const reportPath = resolve(
    'reports/judge-runs',
    `${payload.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
  );
  console.info(`Judging with ${config.provider}; report: ${reportPath}`);
  const evaluation = scope.start(
    python,
    ['tools/evaluation/evaluate.py', '--output', reportPath],
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
  scope.dispose();
  process.exitCode = scope.exitCode;
}
