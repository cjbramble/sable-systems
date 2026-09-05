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

  it('rejects a duplicate distributor customer PO without changing the existing order', async () => {
    const database = await getDatabase();
    const duplicateOrderId = 'SBL-2026-999998';
    const original = await database
      .prepare('SELECT * FROM orders WHERE order_id = ?')
      .bind('SBL-2026-000417')
      .first<Record<string, string | number>>();
    expect(original).toMatchObject({
      order_id: 'SBL-2026-000417',
      customer_id: 'WHS-0427',
      customer_po_number: 'CPD-PO-260417',
    });

    const findDuplicateOrder = () =>
      database
        .prepare('SELECT order_id FROM orders WHERE order_id = ?')
        .bind(duplicateOrderId)
        .first<{ order_id: string }>();
    expect(await findDuplicateOrder()).toBeNull();

    try {
      await expect(
        database
          .prepare(`INSERT INTO orders (
            order_id, customer_id, placed_by_user_id, customer_po_number,
            created_on, requested_ship_date, status, currency,
            order_total_cents, shipping_region
          ) SELECT ?, customer_id, placed_by_user_id, customer_po_number,
            created_on, requested_ship_date, status, currency,
            order_total_cents, shipping_region
          FROM orders WHERE order_id = ?`)
          .bind(duplicateOrderId, 'SBL-2026-000417')
          .run(),
      ).rejects.toThrow(
        /UNIQUE constraint failed: orders\.customer_id, orders\.customer_po_number/,
      );

      expect(await findDuplicateOrder()).toBeNull();
      const matchingOrders = await database
        .prepare(
          'SELECT * FROM orders WHERE customer_id = ? AND customer_po_number = ?',
        )
        .bind('WHS-0427', 'CPD-PO-260417')
        .all<Record<string, string | number>>();
      expect(matchingOrders.results).toEqual([original]);
    } finally {
      // Keep the test database clean even if uniqueness enforcement regresses.
      await database
        .prepare('DELETE FROM orders WHERE order_id = ?')
        .bind(duplicateOrderId)
        .run();
    }
  });
});
