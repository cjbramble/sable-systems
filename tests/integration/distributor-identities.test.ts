import { expect, it } from 'vitest';
import { getDatabase } from '@/db/database';
import { distributorIdentities } from '../fixtures/users';

it('keeps test-owned distributor identities aligned with raw seed rows', async () => {
  const database = await getDatabase();
  const actual = await database
    .prepare(
      'SELECT customer_id, display_name, legal_name FROM distributors ORDER BY customer_id',
    )
    .all();
  expect(actual.results).toEqual(
    Object.entries(distributorIdentities).map(([id, identity]) => ({
      customer_id: id,
      display_name: identity.displayName,
      legal_name: identity.legalName,
    })),
  );
});
