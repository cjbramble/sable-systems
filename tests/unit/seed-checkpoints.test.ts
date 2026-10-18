import { expect, it } from 'vitest';

import { buildSeedRecords } from '@/db/seed';

it('preserves the seed version v8 sequence used by 75-statement resume checkpoints', async () => {
  // Changing record data, column names, or order requires an intentional seed
  // version decision, plus an in-place upgrade for the previous version.
  const records = buildSeedRecords();
  expect(records).toHaveLength(6645);
  const sequence = records.map(({ table, values }) => [
    table,
    Object.entries(values),
  ]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(sequence)),
  );
  expect(
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  ).toBe('21d5dfaf690216f544fc8c77e28d7f1f5a2efc1885dfc156fbd19abfcc125818');
});
