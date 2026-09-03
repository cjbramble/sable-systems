import { env } from 'cloudflare:workers';

import {
  ACCOUNT_CHARGES_INDEX_SQL,
  ACCOUNT_CHARGES_TABLE_SQL,
  SESSIONS_TABLE_SQL,
  USER_CREDENTIALS_TABLE_SQL,
  USERS_TABLE_SQL,
  schemaStatements,
  SCHEMA_VERSION,
  SEED_VERSION,
  seedCleanupStatements,
} from './schema';
import { buildSeedStatements } from './seed';

const BATCH_SIZE = 75;
let initialization: Promise<D1Database> | null = null;

export function getDatabase(): Promise<D1Database> {
  initialization ??= initializeDatabase();
  return initialization;
}

async function initializeDatabase() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('The DB binding is not configured.');

  await migrateDistributorTable(db);
  await migrateChargeAccountTable(db);
  await migrateDistributorUsers(db);
  await migrateAuthTables(db);
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
  const currentSeed = await db
    .prepare("SELECT value FROM metadata WHERE key = 'seed_version'")
    .first<{ value: string }>();
  const currentSchema = await db
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .first<{ value: string }>();
  if (currentSeed?.value === SEED_VERSION) {
    await seedSupportIncidents(db);
    if (currentSchema?.value !== SCHEMA_VERSION) {
      await db
        .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .bind('schema_version', SCHEMA_VERSION)
        .run();
      await db.prepare('PRAGMA optimize').run();
    }
    return db;
  }

  await db.batch(seedCleanupStatements.map((sql) => db.prepare(sql)));
  const seedStatements = buildSeedStatements();
  for (let index = 0; index < seedStatements.length; index += BATCH_SIZE) {
    const batch = seedStatements
      .slice(index, index + BATCH_SIZE)
      .map((statement) => db.prepare(statement.sql).bind(...statement.params));
    await db.batch(batch);
  }
  await seedSupportIncidents(db);
  await db.batch([
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind('schema_version', SCHEMA_VERSION),
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind('seed_version', SEED_VERSION),
  ]);
  await db.prepare('PRAGMA optimize').run();
  return db;
}

async function seedSupportIncidents(db: D1Database) {
  const markerKey = 'support_incidents_seed_version';
  const marker = await db
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .bind(markerKey)
    .first<{ value: string }>();
  if (marker?.value === '1') return;

  const users = await db.prepare('SELECT user_id FROM users').all<{
    user_id: string;
  }>();
  if (users.results.length === 0) return;

  const templates = [
    {
      suffix: '01',
      title: 'Priority shipment trace',
      timestamp: '2026-09-03T08:42:00Z',
      customer: 'Trace the priority shipment on our latest release.',
      assistant:
        'The latest priority release is allocated and queued for carrier handoff. I can provide the order-level milestones if you share the order number.',
    },
    {
      suffix: '02',
      title: 'Nerveline allocation',
      timestamp: '2026-08-29T15:18:00Z',
      customer: 'Check Nerveline hub availability for our account.',
      assistant:
        'I can check current Nerveline allocation, inbound quantities, and lead times against your authorized account.',
    },
    {
      suffix: '03',
      title: '2030 contract releases',
      timestamp: '2026-08-24T11:06:00Z',
      customer: 'Show our scheduled contract releases for 2030.',
      assistant:
        'Your 2030 releases can be reviewed by requested ship date, allocation state, or customer purchase order.',
    },
  ];
  const statements: D1PreparedStatement[] = [];
  for (const user of users.results) {
    for (const template of templates) {
      const incidentId = `INC-${user.user_id}-${template.suffix}`;
      statements.push(
        db
          .prepare(`INSERT OR IGNORE INTO support_incidents (
            incident_id, user_id, title, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)`)
          .bind(
            incidentId,
            user.user_id,
            template.title,
            template.timestamp,
            template.timestamp,
          ),
        db
          .prepare(`INSERT OR IGNORE INTO support_messages (
            message_id, incident_id, sequence_number, role, content, created_at
          ) VALUES (?, ?, 1, 'user', ?, ?)`)
          .bind(
            `MSG-${user.user_id}-${template.suffix}-01`,
            incidentId,
            template.customer,
            template.timestamp,
          ),
        db
          .prepare(`INSERT OR IGNORE INTO support_messages (
            message_id, incident_id, sequence_number, role, content, created_at
          ) VALUES (?, ?, 2, 'assistant', ?, ?)`)
          .bind(
            `MSG-${user.user_id}-${template.suffix}-02`,
            incidentId,
            template.assistant,
            template.timestamp,
          ),
      );
    }
  }
  statements.push(
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind(markerKey, '1'),
  );
  await db.batch(statements);
}

async function migrateDistributorTable(db: D1Database) {
  const legacyTable = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'wholesalers'",
    )
    .first<{ name: string }>();
  const distributorTable = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'distributors'",
    )
    .first<{ name: string }>();
  if (legacyTable && !distributorTable) {
    await db.prepare('PRAGMA foreign_keys = ON').run();
    await db.prepare('ALTER TABLE wholesalers RENAME TO distributors').run();
  }
}

async function migrateChargeAccountTable(db: D1Database) {
  const legacyTable = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'simulated_payments'",
    )
    .first<{ name: string }>();
  if (!legacyTable) return;

  await db.batch([
    db.prepare(ACCOUNT_CHARGES_TABLE_SQL),
    db.prepare(`INSERT OR IGNORE INTO account_charges (
      charge_id, order_id, charge_method, status, amount_cents, currency,
      authorization_code, authorized_at
    ) SELECT payment_id, order_id, 'charge_account', status, amount_cents,
      currency, authorization_code, authorized_at FROM simulated_payments`),
    db.prepare('DROP INDEX IF EXISTS idx_payments_order'),
    db.prepare('DROP TABLE simulated_payments'),
    db.prepare(ACCOUNT_CHARGES_INDEX_SQL),
  ]);
}

async function migrateDistributorUsers(db: D1Database) {
  await db.prepare(USERS_TABLE_SQL).run();
  const columns = await db
    .prepare('PRAGMA table_info(orders)')
    .all<{ name: string }>();
  if (
    columns.results.length > 0 &&
    !columns.results.some((column) => column.name === 'placed_by_user_id')
  ) {
    await db
      .prepare(
        'ALTER TABLE orders ADD COLUMN placed_by_user_id TEXT REFERENCES users(user_id)',
      )
      .run();
  }
}

async function migrateAuthTables(db: D1Database) {
  await db.batch([
    db.prepare(USER_CREDENTIALS_TABLE_SQL),
    db.prepare(SESSIONS_TABLE_SQL),
  ]);
}
