import { expect, onTestFinished } from 'vitest';

type InventoryBalance = {
  item_number: string;
  location_id: string;
  on_hand_quantity: number;
  reserved_quantity: number;
  quarantined_quantity: number;
  inbound_quantity: number;
  expected_restock_date: string | null;
  updated_at: string;
};

export async function createCheckoutFixture(
  database: D1Database,
  customerPoNumber: string,
  itemNumbers: readonly [string, ...string[]],
) {
  const placeholders = itemNumbers.map(() => '?').join(', ');
  const inventory = () =>
    database
      .prepare(`SELECT * FROM inventory_balances
        WHERE item_number IN (${placeholders}) ORDER BY item_number, location_id`)
      .bind(...itemNumbers)
      .all<InventoryBalance>();
  const stockTotals = () =>
    database
      .prepare(`SELECT item_number, SUM(on_hand_quantity) AS on_hand,
        SUM(reserved_quantity) AS reserved,
        SUM(on_hand_quantity - reserved_quantity - quarantined_quantity) AS available
        FROM inventory_balances WHERE item_number IN (${placeholders})
        GROUP BY item_number ORDER BY item_number`)
      .bind(...itemNumbers)
      .all();
  const ordersForPO = () =>
    database
      .prepare('SELECT * FROM orders WHERE customer_po_number = ?')
      .bind(customerPoNumber)
      .all();

  // Never register cleanup for an existing order, even in the disposable DB.
  expect((await ordersForPO()).results).toEqual([]);
  const beforeInventory = (await inventory()).results;
  onTestFinished(async () => {
    await database.batch([
      // Cascades remove this test order's lines, charge, and confirmation event.
      database
        .prepare('DELETE FROM orders WHERE customer_po_number = ?')
        .bind(customerPoNumber),
      ...beforeInventory.map((row) =>
        database
          .prepare(`UPDATE inventory_balances SET on_hand_quantity = ?,
            reserved_quantity = ?, quarantined_quantity = ?, inbound_quantity = ?,
            expected_restock_date = ?, updated_at = ?
            WHERE item_number = ? AND location_id = ?`)
          .bind(
            row.on_hand_quantity,
            row.reserved_quantity,
            row.quarantined_quantity,
            row.inbound_quantity,
            row.expected_restock_date,
            row.updated_at,
            row.item_number,
            row.location_id,
          ),
      ),
    ]);
    expect((await ordersForPO()).results).toEqual([]);
    expect((await inventory()).results).toEqual(beforeInventory);
  });

  return { inventory, stockTotals, ordersForPO, beforeInventory };
}
