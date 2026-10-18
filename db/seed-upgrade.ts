import { buildSeedRecords } from './seed';
import type { SeedRecord, SeedStatement } from './seed-records';
import { SEED_VERSION } from './schema';

// Seed versions whose rows can be rewritten in place to the current seed,
// without a reset. v7 databases seeded before 2026-09-12 also carry older
// shipment timelines under the same version; the rewrite corrects those too.
export const UPGRADABLE_SEED_VERSIONS: ReadonlySet<string> = new Set([
  'sable-distribution-2026-09-02-v7',
]);

const BATCH_STATEMENTS = 75;

// Only these seed tables changed. Each row is matched by primary key, so
// checkout orders (random order IDs, UUID event IDs) are never touched.
const UPSERT_KEYS: Partial<Record<SeedRecord['table'], string[]>> = {
  order_items: ['order_id', 'line_number'],
  order_events: ['event_id'],
  shipments: ['shipment_id'],
};

function upsert(record: SeedRecord, keys: string[]): SeedStatement {
  const columns = Object.keys(record.values);
  const updates = columns
    .filter((column) => !keys.includes(column))
    .map((column) => `${column} = excluded.${column}`);
  return {
    sql: `INSERT INTO ${record.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
      ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
    params: Object.values(record.values),
  };
}

// One group per seed order. A group always runs in a single batch, so its
// shipment lines are replaced atomically; every statement is idempotent, so
// an interrupted or concurrent upgrade can simply run again.
export function seedUpgradeGroups(): SeedStatement[][] {
  const groups = new Map<string, SeedStatement[]>();
  const shipmentItems = new Map<string, SeedStatement[]>();
  for (const record of buildSeedRecords()) {
    if (record.table === 'orders') groups.set(record.values.order_id, []);
    const keys = UPSERT_KEYS[record.table];
    if (keys && 'order_id' in record.values)
      groups.get(record.values.order_id)?.push(upsert(record, keys));
    if (record.table === 'shipment_items') {
      const insert: SeedStatement = {
        sql: `INSERT INTO shipment_items (${Object.keys(record.values).join(', ')})
          VALUES (${Object.keys(record.values)
            .map(() => '?')
            .join(', ')})`,
        params: Object.values(record.values),
      };
      const lines = shipmentItems.get(record.values.order_id) ?? [];
      lines.push(insert);
      shipmentItems.set(record.values.order_id, lines);
    }
  }
  return [...groups].map(([orderId, statements]) => [
    ...statements,
    {
      sql: 'DELETE FROM shipment_items WHERE order_id = ?',
      params: [orderId],
    },
    ...(shipmentItems.get(orderId) ?? []),
  ]);
}

export async function upgradeSeed(db: D1Database) {
  let batch: SeedStatement[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await db.batch(
      batch.map((statement) =>
        db.prepare(statement.sql).bind(...statement.params),
      ),
    );
    batch = [];
  };
  for (const group of seedUpgradeGroups()) {
    if (batch.length + group.length > BATCH_STATEMENTS) await flush();
    batch.push(...group);
  }
  await flush();
  await db
    .prepare(`INSERT INTO metadata (key, value) VALUES ('seed_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(SEED_VERSION)
    .run();
}
