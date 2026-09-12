import { env } from 'cloudflare:workers';
import { expect, onTestFinished, test as base, vi } from 'vitest';

const dropOrder = [
  'support_messages',
  'support_incidents',
  'sessions',
  'account_charges',
  'simulated_payments',
  'return_items',
  'returns',
  'shipment_items',
  'shipments',
  'order_events',
  'order_items',
  'orders',
  'inventory_balances',
  'fulfillment_locations',
  'products',
  'user_credentials',
  'users',
  'distributors',
  'wholesalers',
  'metadata',
];

// The Workers test runtime owns this disposable DB. Never use persisted local data.
export const test = base.extend('initialization', async () => {
  const database = (env as unknown as { INITIALIZATION_DB: D1Database })
    .INITIALIZATION_DB;
  const tables = await database
    .prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`)
    .all();
  expect(
    tables.results,
    'Initialization tests require a fresh disposable DB',
  ).toEqual([]);

  // A dedicated test binding keeps lifecycle failures away from other suites' data.
  vi.doMock('cloudflare:workers', () => ({ env: { DB: database } }));
  onTestFinished(async () => {
    vi.doUnmock('cloudflare:workers');
    vi.resetModules();
    const ownedTables = await database
      .prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`)
      .all<{ name: string }>();
    await database.batch([
      database.prepare('PRAGMA defer_foreign_keys = ON'),
      ...ownedTables.results
        .sort((a, b) => dropOrder.indexOf(a.name) - dropOrder.indexOf(b.name))
        .map(({ name }) =>
          database.prepare(`DROP TABLE "${name.replaceAll('"', '""')}"`),
        ),
      database.prepare('PRAGMA defer_foreign_keys = OFF'),
    ]);
  });

  async function restart() {
    vi.resetModules();
    return (await import('@/db/database')).getDatabase;
  }

  return { database, restart, getDatabase: await restart() };
});

export async function databaseSnapshot(database: D1Database) {
  const objects = await database
    .prepare(`SELECT type, name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name`)
    .all<{ type: string; name: string; sql: string }>();
  const tables: Record<string, unknown[]> = {};
  for (const object of objects.results.filter(({ type }) => type === 'table')) {
    const name = object.name.replaceAll('"', '""');
    const rows = await database.prepare(`SELECT * FROM "${name}"`).all();
    tables[object.name] = rows.results.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return { objects: objects.results, tables };
}

export async function addUserRecords(
  database: D1Database,
  sourceOrder = 'SBL-2026-000417',
) {
  await database.batch([
    database
      .prepare(`INSERT INTO orders (
        order_id, customer_id, placed_by_user_id, customer_po_number, created_on,
        requested_ship_date, status, currency, order_total_cents, shipping_region
      ) SELECT 'INIT-USER-ORDER', customer_id,
      placed_by_user_id, 'INIT-USER-PO', created_on, requested_ship_date, status,
      currency, order_total_cents, shipping_region FROM orders WHERE order_id = ?`)
      .bind(sourceOrder),
    database
      .prepare(`INSERT INTO order_items SELECT 'INIT-USER-ORDER', line_number,
      item_number, product_name_snapshot, unit_price_cents, ordered_quantity,
      allocated_quantity, shipped_quantity, cancelled_quantity
      FROM order_items WHERE order_id = ?`)
      .bind(sourceOrder),
    database.prepare(`INSERT INTO sessions VALUES ('init-session', 'init-token',
      'USR-CPD-001', '2026-09-11T12:00:00Z', '2026-09-11T12:00:00Z',
      '2026-09-12T12:00:00Z', NULL, 'initialization test')`),
    database.prepare(`INSERT INTO support_incidents VALUES ('INIT-INCIDENT',
      'USR-CPD-001', 'Keep this history', '2026-09-11T12:00:00Z', '2026-09-11T12:00:00Z')`),
    database.prepare(`INSERT INTO support_messages VALUES ('INIT-MESSAGE',
      'INIT-INCIDENT', 1, 'user', 'Keep this message', '2026-09-11T12:00:00Z')`),
    database.prepare(
      "DELETE FROM support_incidents WHERE incident_id = 'INC-USR-CPD-001-01'",
    ),
    database.prepare(
      "UPDATE inventory_balances SET on_hand_quantity = on_hand_quantity + 8 WHERE item_number = 'SBL-RPC-12'",
    ),
  ]);
}
