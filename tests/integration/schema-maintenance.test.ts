import { expect } from 'vitest';

import { SCHEMA_VERSION } from '@/db/schema';
import { historicalSchemaStatements } from '../fixtures/historical-schema';
import {
  addUserRecords,
  databaseSnapshot,
  seedHistoricalDatabase,
  test,
} from '../fixtures/database-initialization';

test('removes unused session activity metadata atomically and preserves every other session value', async ({
  initialization,
}) => {
  const { database, getDatabase, restart } = initialization;
  await seedHistoricalDatabase(database, '13');
  await addUserRecords(database);
  const before = await databaseSnapshot(database);
  await database
    .prepare(`CREATE TRIGGER fail_session_upgrade BEFORE UPDATE ON metadata
    WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
    BEGIN SELECT RAISE(ABORT, 'session upgrade interrupted'); END`)
    .run();
  try {
    await expect(getDatabase().then(() => undefined)).rejects.toThrow(
      /session upgrade interrupted/,
    );
    expect((await databaseSnapshot(database)).tables).toEqual(before.tables);
  } finally {
    await database.prepare('DROP TRIGGER fail_session_upgrade').run();
  }
  await getDatabase();
  expect(
    (
      await database
        .prepare('PRAGMA table_info(sessions)')
        .all<{ name: string }>()
    ).results.map(({ name }) => name),
  ).not.toContain('last_seen_at');
  const expected = before.tables.sessions.map((row) => {
    const { last_seen_at: _unused, ...session } = row as Record<
      string,
      unknown
    >;
    return session;
  });
  expect(
    (await database.prepare('SELECT * FROM sessions').all()).results,
  ).toEqual(expected);
  expect(
    await database
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .first(),
  ).toEqual({ value: SCHEMA_VERSION });
  const after = await databaseSnapshot(database);
  await (
    await restart()
  )();
  expect(await databaseSnapshot(database)).toEqual(after);
});

const RETIRED_INDEXES = [
  'idx_account_charges_order',
  'idx_inventory_item',
  'idx_orders_customer_open',
];

async function indexNames(database: D1Database) {
  const { results } = await database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map(({ name }) => name);
}

test('replaces schema 14 indexes atomically and keeps every record', async ({
  initialization,
}) => {
  const { database, getDatabase, restart } = initialization;
  await seedHistoricalDatabase(database, '14');
  await addUserRecords(database);
  await database
    .prepare(
      "INSERT INTO metadata VALUES ('support_incidents_seed_version', '1')",
    )
    .run();
  const before = await databaseSnapshot(database);
  expect(await indexNames(database)).toEqual(
    expect.arrayContaining(RETIRED_INDEXES),
  );
  await database
    .prepare(`CREATE TRIGGER fail_index_upgrade BEFORE UPDATE ON metadata
    WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
    BEGIN SELECT RAISE(ABORT, 'index upgrade interrupted'); END`)
    .run();
  try {
    await expect(getDatabase().then(() => undefined)).rejects.toThrow(
      /index upgrade interrupted/,
    );
    const interrupted = await databaseSnapshot(database);
    expect(interrupted.tables).toEqual(before.tables);
    expect(
      interrupted.objects.filter(({ name }) => name !== 'fail_index_upgrade'),
    ).toEqual(before.objects);
  } finally {
    await database.prepare('DROP TRIGGER fail_index_upgrade').run();
  }
  await getDatabase();
  const indexes = await indexNames(database);
  expect(indexes).toContain('idx_returns_order');
  for (const retired of RETIRED_INDEXES) expect(indexes).not.toContain(retired);
  const after = await databaseSnapshot(database);
  for (const [table, rows] of Object.entries(before.tables))
    if (
      ![
        'metadata',
        'order_events',
        'order_items',
        'shipments',
        'shipment_items',
      ].includes(table)
    )
      expect(after.tables[table], table).toEqual(rows);
  expect(after.tables.metadata).toContainEqual({
    key: 'schema_version',
    value: SCHEMA_VERSION,
  });
  await (
    await restart()
  )();
  expect(await databaseSnapshot(database)).toEqual(after);
});

test.for(['wholesalers', 'simulated_payments', 'missing order attribution'])(
  'rejects unsupported mixed schema %s before writes',
  async (legacy, { initialization }) => {
    const { database, getDatabase } = initialization;
    await seedHistoricalDatabase(database, '6');
    if (legacy === 'missing order attribution') {
      await database
        .prepare(
          'ALTER TABLE orders RENAME COLUMN placed_by_user_id TO legacy_user_id',
        )
        .run();
    } else {
      await database.prepare(`CREATE TABLE ${legacy} (note TEXT)`).run();
      await database
        .prepare(`INSERT INTO ${legacy} VALUES ('Preserve this legacy data')`)
        .run();
    }
    const before = await databaseSnapshot(database);
    await expect(getDatabase().then(() => undefined)).rejects.toThrow(
      /unsupported database/i,
    );
    expect(await databaseSnapshot(database)).toEqual(before);
  },
);

test.for(['6', '13'] as const)(
  'initializes an empty schema %s layout with current session columns',
  async (version, { initialization }) => {
    const { database, getDatabase } = initialization;
    await database.batch(
      historicalSchemaStatements(version).map((sql) => database.prepare(sql)),
    );
    await getDatabase();
    expect(
      (
        await database
          .prepare('PRAGMA table_info(sessions)')
          .all<{ name: string }>()
      ).results.map(({ name }) => name),
    ).not.toContain('last_seen_at');
    expect(
      await database.prepare('SELECT COUNT(*) AS count FROM orders').first(),
    ).toEqual({ count: 720 });
    expect(
      await database
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .first(),
    ).toEqual({ value: SCHEMA_VERSION });
    expect(
      (await database.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
  },
);
