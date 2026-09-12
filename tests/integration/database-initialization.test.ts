import { describe, expect } from 'vitest';

import { schemaStatements, SCHEMA_VERSION, SEED_VERSION } from '@/db/schema';
import { buildSeedStatements } from '@/db/seed';
import {
  addUserRecords,
  databaseSnapshot,
  test,
} from '../fixtures/database-initialization';

async function expectStartupFailure(
  attempt: Promise<D1Database>,
  message: RegExp,
) {
  // Avoid serializing a D1 RPC handle if a regression makes startup succeed.
  await expect(attempt.then(() => undefined)).rejects.toThrow(message);
}

describe('database initialization', () => {
  test('seeds once for concurrent callers and preserves current records after restart', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    const first = getDatabase();
    expect(getDatabase()).toBe(first);
    await first;
    expect(
      await database.prepare('SELECT COUNT(*) AS count FROM orders').first(),
    ).toEqual({ count: 720 });
    expect(
      await database.prepare('PRAGMA foreign_key_check').all(),
    ).toMatchObject({ results: [] });
    await addUserRecords(database);
    const before = await databaseSnapshot(database);
    await (
      await restart()
    )();
    expect(await databaseSnapshot(database)).toEqual(before);
  });

  test.for([
    ['seed_version', 'unrecognized-seed'],
    ['schema_version', '99'],
    ['schema_version', '5'],
    ['support_incidents_seed_version', '99'],
    ['seed_version', null],
    ['schema_version', null],
    ['initialization_progress', 'not-json'],
  ] as const)(
    'refuses unsupported or missing %s (%s) without modifying any rows or schema',
    async ([key, value], { initialization }) => {
      const { database, getDatabase, restart } = initialization;
      await getDatabase();
      await addUserRecords(database);
      if (value === null)
        await database
          .prepare('DELETE FROM metadata WHERE key = ?')
          .bind(key)
          .run();
      else
        await database
          .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .bind(key, value)
          .run();
      const before = await databaseSnapshot(database);
      await expectStartupFailure(
        (await restart())(),
        /database.*unsupported|unsupported.*database/i,
      );
      expect(await databaseSnapshot(database)).toEqual(before);
    },
  );

  test.for(['6', '7'])(
    'upgrades supported schema %s without reseeding',
    async (version, { initialization }) => {
      const { database, getDatabase, restart } = initialization;
      await getDatabase();
      await addUserRecords(database);
      await database
        .prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
        .bind(version)
        .run();
      const before = await databaseSnapshot(database);
      await (
        await restart()
      )();
      expect(
        await database
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .first(),
      ).toEqual({ value: SCHEMA_VERSION });
      expect(
        await database
          .prepare("SELECT value FROM metadata WHERE key = 'seed_version'")
          .first(),
      ).toEqual({ value: SEED_VERSION });
      await database
        .prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
        .bind(version)
        .run();
      expect(await databaseSnapshot(database)).toEqual(before);
    },
  );

  test('adds the missing schema-8 history tables to a supported legacy database', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await getDatabase();
    await addUserRecords(database);
    await database.batch([
      database.prepare('DROP TABLE support_messages'),
      database.prepare('DROP TABLE support_incidents'),
      database.prepare('DROP INDEX idx_orders_customer_created'),
      database.prepare(
        "DELETE FROM metadata WHERE key = 'support_incidents_seed_version'",
      ),
      database.prepare(
        "UPDATE metadata SET value = '6' WHERE key = 'schema_version'",
      ),
    ]);
    const before = await databaseSnapshot(database);
    await (
      await restart()
    )();
    const after = await databaseSnapshot(database);
    for (const [table, rows] of Object.entries(before.tables)) {
      if (table !== 'metadata')
        expect(after.tables[table], table).toEqual(rows);
    }
    expect(after.tables.support_incidents).toHaveLength(12);
    expect(after.tables.support_messages).toHaveLength(24);
    expect(
      after.objects.some(({ name }) => name === 'idx_orders_customer_created'),
    ).toBe(true);
  });

  test.for(['without metadata', 'with empty metadata'])(
    'refuses unmarked legacy records %s before compatibility writes',
    async (scenario, { initialization }) => {
      const { database, getDatabase } = initialization;
      if (scenario === 'with empty metadata')
        await database.prepare(schemaStatements[0]).run();
      await database
        .prepare(
          'CREATE TABLE wholesalers (customer_id TEXT PRIMARY KEY, note TEXT)',
        )
        .run();
      await database
        .prepare(
          "INSERT INTO wholesalers VALUES ('keep-account', 'Do not replace')",
        )
        .run();
      const before = await databaseSnapshot(database);
      await expectStartupFailure(getDatabase(), /unsupported database/i);
      expect(await databaseSnapshot(database)).toEqual(before);
    },
  );

  test.for([false, true])(
    'resumes a failed seed batch without replacing partial records (restart: %s)',
    async (restarted, { initialization }) => {
      const { database, getDatabase, restart } = initialization;
      await database.batch(
        schemaStatements.map((sql) => database.prepare(sql)),
      );
      const failure = buildSeedStatements().find(
        (statement, index) =>
          index > 200 && statement.sql.includes('INSERT INTO orders'),
      )!;
      await database
        .prepare(`CREATE TRIGGER injected_seed_failure BEFORE INSERT ON orders
      WHEN NEW.order_id = '${failure.params[0]}'
      BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END`)
        .run();

      const first = getDatabase();
      const second = getDatabase();
      expect(first).toBe(second);
      await expectStartupFailure(first, /injected seed failure/);
      const partial = await database
        .prepare('SELECT order_id FROM orders ORDER BY order_id')
        .all<{ order_id: string }>();
      expect(partial.results.length).toBeGreaterThan(0);
      expect(partial.results.length).toBeLessThan(720);
      expect(
        await database
          .prepare(
            "SELECT * FROM metadata WHERE key IN ('seed_version', 'schema_version')",
          )
          .all(),
      ).toMatchObject({ results: [] });
      const progress = await database
        .prepare(
          "SELECT value FROM metadata WHERE key = 'initialization_progress'",
        )
        .first<{ value: string }>();
      expect(JSON.parse(progress!.value).nextStatement).toBeGreaterThan(0);

      // A retry must neither delete unrelated records nor replay committed inserts.
      await addUserRecords(database, partial.results[0].order_id);
      await database.prepare('DROP TRIGGER injected_seed_failure').run();
      const before = await databaseSnapshot(database);
      const retry = restarted ? await restart() : getDatabase;
      const attempt = retry();
      expect(attempt).not.toBe(first);
      expect(retry()).toBe(attempt);
      await attempt;
      const after = await databaseSnapshot(database);
      for (const [table, rows] of Object.entries(before.tables)) {
        if (table !== 'metadata')
          expect(after.tables[table], table).toEqual(
            expect.arrayContaining(rows),
          );
      }
      expect(after.tables.orders).toHaveLength(721);
      expect(after.tables.metadata).toEqual(
        expect.arrayContaining([
          { key: 'schema_version', value: SCHEMA_VERSION },
          { key: 'seed_version', value: SEED_VERSION },
        ]),
      );
      expect(
        await database
          .prepare(
            "SELECT * FROM metadata WHERE key = 'initialization_progress'",
          )
          .first(),
      ).toBeNull();
      expect(
        await database.prepare('PRAGMA foreign_key_check').all(),
      ).toMatchObject({ results: [] });
    },
  );

  test('retries a failed completion marker without repeating seed or history inserts', async ({
    initialization,
  }) => {
    const { database, getDatabase } = initialization;
    await database.batch(schemaStatements.map((sql) => database.prepare(sql)));
    await database
      .prepare(`CREATE TRIGGER injected_completion_failure BEFORE INSERT ON metadata
      WHEN NEW.key = 'seed_version' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`)
      .run();
    await expectStartupFailure(getDatabase(), /injected completion failure/);
    expect(
      await database
        .prepare(
          "SELECT * FROM metadata WHERE key IN ('seed_version', 'schema_version')",
        )
        .all(),
    ).toMatchObject({ results: [] });
    await database.prepare('DROP TRIGGER injected_completion_failure').run();
    const checkpoint = await database
      .prepare(
        "SELECT value FROM metadata WHERE key = 'initialization_progress'",
      )
      .first<{ value: string }>();
    const progress = JSON.parse(checkpoint!.value);
    for (const damaged of [
      'not-json',
      JSON.stringify({ ...progress, version: 'unknown-initializer' }),
      JSON.stringify({ ...progress, nextStatement: -75 }),
      JSON.stringify({ ...progress, nextStatement: 1 }),
      JSON.stringify({ ...progress, nextStatement: 75 }),
      JSON.stringify({
        ...progress,
        nextStatement: progress.nextStatement + 75,
      }),
    ]) {
      await database
        .prepare(
          "UPDATE metadata SET value = ? WHERE key = 'initialization_progress'",
        )
        .bind(damaged)
        .run();
      const untouched = await databaseSnapshot(database);
      await expectStartupFailure(getDatabase(), /unsupported database/i);
      expect(await databaseSnapshot(database)).toEqual(untouched);
    }
    await database
      .prepare(
        "UPDATE metadata SET value = ? WHERE key = 'initialization_progress'",
      )
      .bind(checkpoint!.value)
      .run();
    const before = await databaseSnapshot(database);
    await getDatabase();
    const after = await databaseSnapshot(database);
    for (const [table, rows] of Object.entries(before.tables)) {
      if (table !== 'metadata')
        expect(after.tables[table], table).toEqual(rows);
    }
    expect(after.tables.orders).toHaveLength(720);
    expect(after.tables.support_messages).toHaveLength(24);
    expect(after.tables.metadata).toEqual([
      { key: 'as_of_date', value: '2026-09-02' },
      { key: 'schema_version', value: SCHEMA_VERSION },
      { key: 'seed_version', value: SEED_VERSION },
      { key: 'support_incidents_seed_version', value: '1' },
    ]);
  });
});
