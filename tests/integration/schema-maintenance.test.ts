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
    WHEN NEW.key = 'schema_version' AND NEW.value = '14'
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
