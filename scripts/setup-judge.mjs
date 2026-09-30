import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import manifest from '../tools/evaluation/model.json' with { type: 'json' };
import { loadLocalEnvironment } from './lib/environment.mjs';
import { getSupportModelConfig } from '../lib/support-model-config.mjs';

loadLocalEnvironment();
const config = getSupportModelConfig({
  SUPPORT_MODEL_PROVIDER: process.env.JUDGE_PROVIDER || 'local',
});
if (config.provider === 'openrouter') {
  console.info(
    'OpenRouter judge selected; Python environment prepared, no model download needed.',
  );
} else {
  const destination = resolve(manifest.path);
  const partial = `${destination}.partial`;
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination)) {
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.file}`;
    const result = spawnSync(
      'curl',
      [
        '--fail',
        '--location',
        '--retry',
        '2',
        '--continue-at',
        '-',
        '--output',
        partial,
        url,
      ],
      { stdio: 'inherit' },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        'Judge download failed; rerun setup to resume the partial download.',
      );
  }
  const path = existsSync(destination) ? destination : partial;
  // Resuming cannot repair a full-size bad file, so name the file to remove.
  const rejected = (reason) =>
    new Error(`${reason} Delete ${path} and rerun npm run setup:judge.`);
  if (statSync(path).size !== manifest.bytes)
    throw rejected('Judge file size does not match the pinned model.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.sha256)
    throw rejected('Judge checksum mismatch; the file has not been accepted.');
  if (path === partial) renameSync(partial, destination);
  console.info(`Verified local judge: ${destination}`);
}
