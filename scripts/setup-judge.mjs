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
import manifest from './judge/model.json' with { type: 'json' };

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
if (statSync(path).size !== manifest.bytes)
  throw new Error('Judge file size does not match the pinned model.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
if (hash.digest('hex') !== manifest.sha256)
  throw new Error('Judge checksum mismatch; the file has not been accepted.');
if (path === partial) renameSync(partial, destination);
console.info(`Verified local judge: ${destination}`);
