import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';

describe('order data integrity', () => {
  it('has no duplicate customer PO numbers within a distributor', async () => {
    const database = await getDatabase();
    const count = await database
      .prepare('SELECT COUNT(*) AS total FROM orders')
      .first<{ total: number }>();
    expect(count?.total).toBeGreaterThan(0);

    const duplicates = await database
      .prepare(
        `SELECT customer_id, customer_po_number, COUNT(*) AS occurrences
         FROM orders
         GROUP BY customer_id, customer_po_number
         HAVING COUNT(*) > 1
         ORDER BY customer_id, customer_po_number`,
      )
      .all<{
        customer_id: string;
        customer_po_number: string;
        occurrences: number;
      }>();

    expect(
      duplicates.results,
      'Duplicate distributor/customer PO pairs',
    ).toEqual([]);
  });
});
