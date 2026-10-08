import { describe, expect } from 'vitest';
import { buildAuthorizedContext } from '@/db/support';
import { SCHEMA_VERSION } from '@/db/schema';
import { calderPikeUser } from '../fixtures/users';
import { historicalSchemaStatements } from '../fixtures/historical-schema';
import {
  databaseSnapshot,
  seedHistoricalDatabase,
  test,
} from '../fixtures/database-initialization';

const sourceOrder = 'SBL-2022-000118';
const otherOrders = [
  { account: 'same', order: 'SBL-2026-000417' },
  { account: 'different', order: 'SBL-2021-500000' },
];
const relations = [
  {
    parent: 'shipments',
    child: 'shipment_items',
    key: 'shipment_id',
    parentSql: `INSERT INTO shipments VALUES (?, ?, 'preparing', 'Test carrier', ?, NULL, NULL, NULL)`,
    lineSql: 'INSERT INTO shipment_items VALUES (?, ?, 1, 1)',
  },
  {
    parent: 'returns',
    child: 'return_items',
    key: 'return_id',
    parentSql: `INSERT INTO returns VALUES (?, ?, 'requested', ?, '2026-10-08', NULL, NULL)`,
    lineSql: "INSERT INTO return_items VALUES (?, ?, 1, 1, 'restock')",
  },
] as const;

describe('parent/order line integrity', () => {
  const cases = ['fresh', 'upgraded', 'legacy-empty'].flatMap((setup) =>
    relations.flatMap((relation) =>
      otherOrders.map((other) => ({ setup, ...relation, ...other })),
    ),
  );

  test.for(cases)(
    '$setup $child rejects mismatched orders in the $account account',
    async (
      { setup, parent, child, key, parentSql, lineSql, order },
      { initialization },
    ) => {
      const { database, getDatabase } = initialization;
      if (setup === 'upgraded') await seedHistoricalDatabase(database, '9');
      if (setup === 'legacy-empty')
        await database.batch(
          historicalSchemaStatements('9').map((sql) => database.prepare(sql)),
        );
      await getDatabase();
      await database.batch([
        database.prepare(parentSql).bind('PRIMARY', sourceOrder, 'PRIMARY'),
        database.prepare(parentSql).bind('OTHER', order, 'OTHER'),
        database.prepare(lineSql).bind('PRIMARY', sourceOrder),
      ]);
      const original = await database
        .prepare(`SELECT * FROM ${child} WHERE ${key} = 'PRIMARY'`)
        .first();
      const rejected = [
        database.prepare(lineSql).bind('PRIMARY', order),
        database
          .prepare(`UPDATE ${child} SET order_id = ? WHERE ${key} = 'PRIMARY'`)
          .bind(order),
        database.prepare(
          `UPDATE ${child} SET ${key} = 'OTHER' WHERE ${key} = 'PRIMARY'`,
        ),
        database
          .prepare(`UPDATE ${parent} SET order_id = ? WHERE ${key} = 'PRIMARY'`)
          .bind(order),
        database.prepare(
          `UPDATE ${child} SET line_number = 999999 WHERE ${key} = 'PRIMARY'`,
        ),
      ];
      for (const statement of rejected) {
        await expect(statement.run()).rejects.toThrow(
          /FOREIGN KEY constraint failed/,
        );
        expect(
          await database
            .prepare(`SELECT * FROM ${child} WHERE ${key} = 'PRIMARY'`)
            .first(),
        ).toEqual(original);
        expect(
          await database
            .prepare(`SELECT order_id FROM ${parent} WHERE ${key} = 'PRIMARY'`)
            .first(),
        ).toEqual({ order_id: sourceOrder });
      }

      // Moving a line to a matching parent/order pair remains valid.
      await database
        .prepare(
          `UPDATE ${child} SET ${key} = 'OTHER', order_id = ? WHERE ${key} = 'PRIMARY'`,
        )
        .bind(order)
        .run();
      expect(
        await database
          .prepare(`SELECT order_id FROM ${child} WHERE ${key} = 'OTHER'`)
          .first(),
      ).toEqual({ order_id: order });
      // A parent with no lines can still change its order.
      await database
        .prepare(`UPDATE ${parent} SET order_id = ? WHERE ${key} = 'PRIMARY'`)
        .bind(order)
        .run();
      await database
        .prepare(`DELETE FROM ${parent} WHERE ${key} = 'OTHER'`)
        .run();
      expect(
        (
          await database
            .prepare(
              `SELECT * FROM ${child} WHERE ${key} IN ('PRIMARY', 'OTHER')`,
            )
            .all()
        ).results,
      ).toEqual([]);
      expect(
        (await database.prepare('PRAGMA foreign_key_check').all()).results,
      ).toEqual([]);
    },
  );

  const corruptCases = ['6', '9'].flatMap((version) =>
    relations.flatMap((relation) =>
      otherOrders.map((other) => ({
        version: version as '6' | '9',
        ...relation,
        ...other,
      })),
    ),
  );
  test.for(corruptCases)(
    'refuses v$version $child corruption in the $account account before any writes',
    async ({ version, parentSql, lineSql, order }, { initialization }) => {
      const { database, getDatabase } = initialization;
      await seedHistoricalDatabase(database, version);
      await database.batch([
        database.prepare(parentSql).bind('CORRUPT', sourceOrder, 'CORRUPT'),
        database.prepare(lineSql).bind('CORRUPT', order),
      ]);
      // Separate legacy FKs accept this invalid combination.
      expect(
        (await database.prepare('PRAGMA foreign_key_check').all()).results,
      ).toEqual([]);
      const before = await databaseSnapshot(database);
      await expect(getDatabase().then(() => undefined)).rejects.toThrow(
        /parent.*order|order.*parent/i,
      );
      expect(await databaseSnapshot(database)).toEqual(before);
    },
  );

  test('rolls back a failed v9 migration and retries without losing line data', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await seedHistoricalDatabase(database, '9');
    await database
      .prepare(`CREATE TRIGGER fail_migration BEFORE INSERT ON metadata
      WHEN NEW.key = 'schema_version' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`)
      .run();
    const before = await databaseSnapshot(database);
    await expect(getDatabase().then(() => undefined)).rejects.toThrow(
      /injected migration failure/,
    );
    expect(await databaseSnapshot(database)).toEqual(before);
    await database.prepare('DROP TRIGGER fail_migration').run();
    await (
      await restart()
    )();
    const after = await databaseSnapshot(database);
    expect(after.tables.shipment_items).toEqual(before.tables.shipment_items);
    expect(after.tables.return_items).toEqual(before.tables.return_items);
    expect(after.tables.metadata).toContainEqual({
      key: 'schema_version',
      value: SCHEMA_VERSION,
    });
    expect(
      (await database.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
  });

  test('retries schema-only migration after the initialization claim was committed', async ({
    initialization,
  }) => {
    const { database, getDatabase, restart } = initialization;
    await database.batch([
      ...historicalSchemaStatements('9').map((sql) => database.prepare(sql)),
      // An incompatible index forces the composite FK installation to fail.
      database.prepare(
        'CREATE INDEX idx_shipments_parent_order ON shipments(shipment_id)',
      ),
    ]);
    await expect(getDatabase().then(() => undefined)).rejects.toThrow(
      /foreign key mismatch/i,
    );
    expect(
      await database
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .first(),
    ).toBeNull();
    expect(
      await database
        .prepare(
          "SELECT value FROM metadata WHERE key = 'initialization_progress'",
        )
        .first(),
    ).not.toBeNull();
    await database.prepare('DROP INDEX idx_shipments_parent_order').run();
    await (
      await restart()
    )();
    await database
      .prepare(relations[0].parentSql)
      .bind('RETRIED', sourceOrder, 'RETRIED')
      .run();
    await expect(
      database
        .prepare(relations[0].lineSql)
        .bind('RETRIED', otherOrders[0].order)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(
      await database
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .first(),
    ).toEqual({ value: SCHEMA_VERSION });
    expect(
      (await database.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
  });

  test.for(otherOrders)(
    'withholds legacy return lines from another order in the $account account',
    async ({ order }, { initialization }) => {
      const { database } = initialization;
      await seedHistoricalDatabase(database, '9');
      await database.batch([
        database
          .prepare(`INSERT INTO order_items SELECT order_id, 9999, item_number,
          'UNRELATED-ORDER-SNAPSHOT', unit_price_cents, ordered_quantity,
          allocated_quantity, shipped_quantity, cancelled_quantity
          FROM order_items WHERE order_id = ? AND line_number = 1`)
          .bind(order),
        database
          .prepare(
            `INSERT INTO returns VALUES ('RTN-2099-123456', ?, 'requested', 'test', '2026-10-08', NULL, NULL)`,
          )
          .bind(sourceOrder),
        database
          .prepare(
            `INSERT INTO return_items VALUES ('RTN-2099-123456', ?, 1, 1, 'restock')`,
          )
          .bind(sourceOrder),
        database
          .prepare(
            `INSERT INTO return_items VALUES ('RTN-2099-123456', ?, 9999, 1, 'restock')`,
          )
          .bind(order),
      ]);
      const context = await buildAuthorizedContext(
        database,
        [{ role: 'user', content: 'Show return RTN-2099-123456.' }],
        calderPikeUser,
      );
      expect(context).toContain('Dermal Maintenance Kit A9');
      expect(context).not.toContain('UNRELATED-ORDER-SNAPSHOT');
      expect(context).not.toContain(order);
    },
  );
});
