import { expect, it } from 'vitest';

import { buildSeedRecords } from '@/db/seed';

it('preserves the seed version v7 sequence used by 75-statement resume checkpoints', async () => {
  // Captured from the pre-refactor SQL/parameter sequence. Changing record data
  // or order requires an intentional seed/checkpoint protocol decision.
  const records = buildSeedRecords();
  expect(records).toHaveLength(6850);
  const sequence = records.map(({ table, values }) => [
    table,
    Object.values(values),
  ]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(sequence)),
  );
  expect(
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  ).toBe('5fd4c69844e18f41b48cfddfe64a0b69e5dda686888aee7ee9f4e9231ba400dd');
});
