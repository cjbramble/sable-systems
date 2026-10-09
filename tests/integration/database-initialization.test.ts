import { describe, expect, vi } from 'vitest';

import { schemaStatements, SCHEMA_VERSION, SEED_VERSION } from '@/db/schema';
import {
  deleteSupportIncident,
  getSupportIncidentState,
  saveSupportExchange,
} from '@/db/incidents';
import { buildSeedStatements } from '@/db/seed';
import { placeChargeAccountOrder } from '@/db/shop';
import { checkoutCommand } from '../fixtures/checkout';
import { loadActiveUserFixture } from '../fixtures/users';
import { historicalSchemaStatements } from '../fixtures/historical-schema';
import { calderPikeUser } from '../fixtures/users';
import {
  addUserRecords,
  databaseSnapshot,
  seedHistoricalDatabase,
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
  test.for(['recover', 'unrelated failure', 'retry failure'] as const)(
    'handles concurrent revision migrations without hiding errors: %s',
    async (scenario, { initialization }) => {
      const { database, getDatabase, restart } = initialization;
      await seedHistoricalDatabase(database, '12');
      await addUserRecords(database);
      await database
        .prepare(
          "INSERT INTO metadata VALUES ('support_incidents_seed_version', '1')",
        )
        .run();
      const before = await databaseSnapshot(database);
      // Separate module caches model two cold Workers sharing the same D1 DB.
      const secondWorker = await restart();
      expect(secondWorker).not.toBe(getDatabase);
      const revisionStatements = new WeakSet<D1PreparedStatement>();
      const schemaStatements = new WeakSet<D1PreparedStatement>();
      const prepare = database.prepare.bind(database);
      const prepareSpy = vi
        .spyOn(database, 'prepare')
        .mockImplementation((sql) => {
          const statement = prepare(sql);
          if (
            /^ALTER TABLE support_(incidents|messages)\s+ADD COLUMN revision/.test(
              sql,
            )
          )
            revisionStatements.add(statement);
          if (sql.startsWith('CREATE TABLE IF NOT EXISTS support_incidents'))
            schemaStatements.add(statement);
          return statement;
        });
      const bothPlanned = Promise.withResolvers<void>();
      const winnerCommitted = Promise.withResolvers<void>();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        bothPlanned.resolve();
        winnerCommitted.resolve();
      }, 2_000);
      let schemaAttempts = 0;
      let revisionAttempts = 0;
      const injected = new Error(`Injected ${scenario}`);
      const duplicateErrors: unknown[] = [];
      const batch = database.batch.bind(database);
      const batchSpy = vi
        .spyOn(database, 'batch')
        .mockImplementation(async (statements) => {
          if (!statements.some((statement) => schemaStatements.has(statement)))
            return batch(statements);
          schemaAttempts += 1;
          if (
            !statements.some((statement) => revisionStatements.has(statement))
          ) {
            if (scenario === 'retry failure') throw injected;
            return batch(statements);
          }
          if (++revisionAttempts === 1) {
            await bothPlanned.promise;
            try {
              return await batch(statements);
            } finally {
              winnerCommitted.resolve();
            }
          }
          bothPlanned.resolve();
          await winnerCommitted.promise;
          if (scenario === 'unrelated failure') throw injected;
          try {
            return await batch(statements);
          } catch (error) {
            duplicateErrors.push(error);
            throw error;
          }
        });
      const first = getDatabase();
      const second = secondWorker();
      const settled = Promise.allSettled(
        [first, second].map((attempt) => attempt.then(() => undefined)),
      );
      try {
        expect(first).not.toBe(second);
        const outcomes = await settled;
        expect(timedOut).toBe(false);
        expect(revisionAttempts).toBe(2);
        expect(
          outcomes.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(scenario === 'recover' ? 2 : 1);
        expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual(
          scenario === 'recover'
            ? []
            : [{ status: 'rejected', reason: injected }],
        );
        expect(schemaAttempts).toBe(scenario === 'unrelated failure' ? 2 : 3);
        if (scenario !== 'unrelated failure') {
          expect(duplicateErrors).toHaveLength(1);
          expect(duplicateErrors[0]).toBeInstanceOf(Error);
          expect((duplicateErrors[0] as Error).message).toContain(
            'duplicate column name: revision',
          );
        }
        const after = await databaseSnapshot(database);
        for (const [table, rows] of Object.entries(before.tables))
          if (table !== 'metadata')
            expect(after.tables[table], table).toEqual(
              ['support_incidents', 'support_messages'].includes(table)
                ? rows.map((row) => ({ ...(row as object), revision: 0 }))
                : rows,
            );
        expect(after.tables.metadata).toContainEqual({
          key: 'schema_version',
          value: SCHEMA_VERSION,
        });
      } finally {
        bothPlanned.resolve();
        winnerCommitted.resolve();
        await settled;
        clearTimeout(timer);
        batchSpy.mockRestore();
        prepareSpy.mockRestore();
      }
      const upgraded = await databaseSnapshot(database);
      await (
        await restart()
      )();
      expect(await databaseSnapshot(database)).toEqual(upgraded);
    },
  );

  test('adds conversation revisions atomically to schema 12 and preserves historical replies across restart', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await seedHistoricalDatabase(database, '12');
    await addUserRecords(database);
    await database
      .prepare(`INSERT INTO support_messages
      (message_id, incident_id, sequence_number, role, content, created_at)
      VALUES ('AST-INIT-MESSAGE', 'INIT-INCIDENT', 2, 'assistant',
        'Keep this reply', '2026-09-11T12:00:00Z')`)
      .run();
    await database
      .prepare(
        "INSERT INTO metadata VALUES ('support_incidents_seed_version', '1')",
      )
      .run();
    const before = await databaseSnapshot(database);
    await database
      .prepare(`CREATE TRIGGER fail_revision_upgrade BEFORE UPDATE ON metadata
      WHEN NEW.key = 'schema_version' AND NEW.value = '13'
      BEGIN SELECT RAISE(ABORT, 'revision upgrade interrupted'); END`)
      .run();
    try {
      await expectStartupFailure(getDatabase(), /revision upgrade interrupted/);
      expect((await databaseSnapshot(database)).tables).toEqual(before.tables);
      for (const table of ['support_incidents', 'support_messages'])
        expect(
          (
            await database
              .prepare(`PRAGMA table_info(${table})`)
              .all<{ name: string }>()
          ).results.some(({ name }) => name === 'revision'),
        ).toBe(false);
    } finally {
      await database.prepare('DROP TRIGGER fail_revision_upgrade').run();
    }
    await getDatabase();
    const migrated = await databaseSnapshot(database);
    for (const table of ['support_incidents', 'support_messages']) {
      expect(before.tables[table].length).toBeGreaterThan(0);
      expect(migrated.tables[table]).toEqual(
        before.tables[table].map((row) => ({
          ...(row as object),
          revision: 0,
        })),
      );
    }
    const receipt = await saveSupportExchange(
      database,
      calderPikeUser,
      'INIT-INCIDENT',
      'MSG-MIGRATED-REVISION',
      'A new question.',
      'A new answer.',
      0,
    );
    expect(receipt.revision).toBe(1);
    const saved = await databaseSnapshot(database);
    await (
      await restart()
    )();
    expect(
      await saveSupportExchange(
        database,
        calderPikeUser,
        'INIT-INCIDENT',
        'MSG-MIGRATED-REVISION',
        'A new question.',
        'A different generated answer.',
        0,
      ),
    ).toEqual(receipt);
    expect(
      await saveSupportExchange(
        database,
        calderPikeUser,
        'INIT-INCIDENT',
        'INIT-MESSAGE',
        'Keep this message',
        'Do not replace history',
        0,
      ),
    ).toMatchObject({ message: 'Keep this reply', revision: 0 });
    expect(await databaseSnapshot(database)).toEqual(saved);
  });

  test('adds durable checkout commands atomically to schema 11 and replays after restart', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await seedHistoricalDatabase(database, '11');
    await database
      .prepare(
        "INSERT INTO metadata VALUES ('support_incidents_seed_version', '1')",
      )
      .run();
    const before = await databaseSnapshot(database);
    await database
      .prepare(`CREATE TRIGGER fail_checkout_upgrade BEFORE UPDATE ON metadata
      WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
      BEGIN SELECT RAISE(ABORT, 'checkout upgrade interrupted'); END`)
      .run();
    try {
      await expectStartupFailure(getDatabase(), /checkout upgrade interrupted/);
      expect(
        await database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'checkout_commands'",
          )
          .first(),
      ).toBeNull();
      expect((await databaseSnapshot(database)).tables).toEqual(before.tables);
    } finally {
      await database.prepare('DROP TRIGGER fail_checkout_upgrade').run();
    }
    await getDatabase();
    const after = await databaseSnapshot(database);
    for (const [table, rows] of Object.entries(before.tables))
      if (table !== 'metadata')
        expect(after.tables[table], table).toEqual(
          ['support_incidents', 'support_messages'].includes(table)
            ? rows.map((row) => ({ ...(row as object), revision: 0 }))
            : rows,
        );
    expect(after.tables.checkout_commands).toEqual([]);
    const input = checkoutCommand('RECOVERY-MIGRATION');
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const receipt = await placeChargeAccountOrder(database, input, user);
    const rejected = checkoutCommand('RECOVERY-MIGRATION-REJECTED', {
      items: [{ ...input.items[0], expectedUnitPriceCents: 68001 }],
    });
    await expect(
      placeChargeAccountOrder(database, rejected, user),
    ).rejects.toMatchObject({ status: 409, code: 'price_changed' });
    const saved = await databaseSnapshot(database);
    await (
      await restart()
    )();
    expect(await placeChargeAccountOrder(database, input, user)).toEqual(
      receipt,
    );
    await expect(
      placeChargeAccountOrder(database, rejected, user),
    ).rejects.toMatchObject({ status: 409, code: 'price_changed' });
    expect(await databaseSnapshot(database)).toEqual(saved);
  });

  test('refuses a prior-schema initialization checkpoint without modifying it', async ({
    initialization,
  }) => {
    const { database, getDatabase } = initialization;
    await database.batch([
      ...historicalSchemaStatements('9').map((sql) => database.prepare(sql)),
      database.prepare('INSERT INTO metadata VALUES (?, ?)').bind(
        'initialization_progress',
        JSON.stringify({
          version: `9/${SEED_VERSION}/75/1`,
          nextStatement: 0,
        }),
      ),
    ]);
    const before = await databaseSnapshot(database);
    await expectStartupFailure(getDatabase(), /unsupported database/i);
    expect(await databaseSnapshot(database)).toEqual(before);
  });
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

  test.for(['6', '7', '8', '9', '10', '11', '12'] as const)(
    'upgrades historical schema %s without reseeding or losing records',
    async (version, { initialization }) => {
      const { database, getDatabase, restart } = initialization;
      await seedHistoricalDatabase(database, version);
      if (Number(version) >= 8) {
        await addUserRecords(database);
        await database
          .prepare(
            "INSERT INTO metadata VALUES ('support_incidents_seed_version', '1')",
          )
          .run();
      }
      await database
        .prepare(
          "UPDATE orders SET customer_po_number = 'HISTORICAL-PO' WHERE order_id = 'SBL-2026-000417'",
        )
        .run();
      const before = await databaseSnapshot(database);
      await getDatabase();
      const after = await databaseSnapshot(database);
      for (const [table, rows] of Object.entries(before.tables)) {
        if (table !== 'metadata')
          expect(after.tables[table], table).toEqual(
            ['support_incidents', 'support_messages'].includes(table)
              ? rows.map((row) => ({ ...(row as object), revision: 0 }))
              : rows,
          );
      }
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
      for (const [child, parent, key] of [
        ['shipment_items', 'shipments', 'shipment_id'],
        ['return_items', 'returns', 'return_id'],
      ]) {
        const { results } = await database
          .prepare(`PRAGMA foreign_key_list(${child})`)
          .all();
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ table: parent, from: key, to: key }),
            expect.objectContaining({
              table: parent,
              from: 'order_id',
              to: 'order_id',
            }),
          ]),
        );
      }
      expect(
        (await database.prepare('PRAGMA foreign_key_check').all()).results,
      ).toEqual([]);
      await (
        await restart()
      )();
      expect(await databaseSnapshot(database)).toEqual(after);
    },
  );

  test('schema 10 upgrades atomically and keeps deleted seed history deleted after restart', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await seedHistoricalDatabase(database, '10');
    const before = await databaseSnapshot(database);
    await database
      .prepare(`CREATE TRIGGER fail_schema_upgrade BEFORE UPDATE ON metadata
      WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
      BEGIN SELECT RAISE(ABORT, 'upgrade interrupted'); END`)
      .run();
    try {
      await expectStartupFailure(getDatabase(), /upgrade interrupted/);
      expect(
        await database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'support_incident_deletions'",
          )
          .first(),
      ).toBeNull();
      expect((await databaseSnapshot(database)).tables).toEqual(before.tables);
    } finally {
      await database.prepare('DROP TRIGGER fail_schema_upgrade').run();
    }
    await getDatabase();
    const incidentId = 'INC-USR-CPD-001-01';
    await deleteSupportIncident(database, calderPikeUser, incidentId);
    const deleted = await databaseSnapshot(database);
    await (
      await restart()
    )();
    expect(await databaseSnapshot(database)).toEqual(deleted);
    expect(
      await getSupportIncidentState(database, calderPikeUser, incidentId),
    ).toBe('deleted');
    expect(
      await database
        .prepare('SELECT 1 FROM support_messages WHERE incident_id = ?')
        .bind(incidentId)
        .first(),
    ).toBeNull();
  });

  test('adds request quotas when upgrading schema 8 and preserves all existing records', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await getDatabase();
    await addUserRecords(database);
    await database.batch([
      database.prepare('DROP TABLE request_limits'),
      database.prepare(
        "UPDATE metadata SET value = '8' WHERE key = 'schema_version'",
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
    expect(after.tables.request_limits).toEqual([]);
    expect(after.tables.metadata).toContainEqual({
      key: 'schema_version',
      value: SCHEMA_VERSION,
    });
  });

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
