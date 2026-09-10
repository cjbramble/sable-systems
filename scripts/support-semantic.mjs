import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSamplingTranscript,
  validateSemanticReport,
  combinedSamplingPassed,
} from './semantic-results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function evaluateSemanticTranscript(transcriptPath, outputPath) {
  const transcript = transcriptPath
    ? readFileSync(transcriptPath, 'utf8')
    : null;
  const batch =
    transcript === null ? null : parseSamplingTranscript(transcript);
  if (transcript !== null && batch === null) return null; // A filtered fixed-seed test.
  const samples = (batch?.samples ?? []).filter(
    (sample) => typeof sample.answer === 'string' && sample.answer.trim(),
  );
  const python = resolve(
    root,
    'scripts/semantic/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const result = spawnSync(
    python,
    [resolve(root, 'scripts/semantic/evaluate.py')],
    {
      input: JSON.stringify({ samples }),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Local Sentence Transformers evaluation failed. Run npm run setup:semantic. ${result.error?.message ?? result.stderr}`,
    );
  const semantic = validateSemanticReport(JSON.parse(result.stdout), samples);
  const report = {
    ...semantic,
    sourceTranscript: transcriptPath ? resolve(transcriptPath) : null,
    sourceSha256:
      transcript === null
        ? null
        : createHash('sha256').update(transcript).digest('hex'),
    request: batch?.request ?? null,
    factualVerdicts:
      batch?.samples.map(({ sample, passed, failure }) => ({
        sample,
        passed,
        failure,
      })) ?? [],
    unscored:
      batch?.samples
        .filter((sample) => !samples.includes(sample))
        .map(({ sample, failure }) => ({
          sample,
          reason: 'No model answer to embed',
          failure,
        })) ?? [],
    factualSamplesPassed:
      batch === null ? null : combinedSamplingPassed(batch.samples),
  };
  const destination =
    outputPath ??
    resolve(
      root,
      'reports/model-runs',
      `semantic-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
    );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.info(`Sentence Transformers report: ${destination}`);
  console.info(
    `Semantic calibration: ${report.calibration.status}; scores are advisory, factual checks remain mandatory.`,
  );
  for (const sample of report.samples)
    console.info(
      `Semantic sample ${sample.sample}: cosine=${sample.score.toFixed(4)}, chunks=${sample.chunks}`,
    );
  return report;
}
