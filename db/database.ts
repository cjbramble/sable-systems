import { env } from 'cloudflare:workers';

import {
  ACCOUNT_CHARGES_INDEX_SQL,
  ACCOUNT_CHARGES_TABLE_SQL,
  METADATA_TABLE_SQL,
  SESSIONS_TABLE_SQL,
  USER_CREDENTIALS_TABLE_SQL,
  USERS_TABLE_SQL,
  schemaStatements,
  SCHEMA_VERSION,
  SEED_VERSION,
} from './schema';
import { buildSeedStatements } from './seed';

const BATCH_SIZE = 75;
const INITIALIZATION_KEY = 'initialization_progress';
// Change this protocol if batch boundaries or the seed statement order change.
const INITIALIZATION_VERSION = `${SCHEMA_VERSION}/${SEED_VERSION}/${BATCH_SIZE}/1`;
const SUPPORTED_SCHEMA_VERSIONS = new Set(['6', '7', SCHEMA_VERSION]);
let initialization: Promise<D1Database> | null = null;

export function getDatabase(): Promise<D1Database> {
  initialization ??= initializeDatabase().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

async function initializeDatabase() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('The DB binding is not configured.');

  const seedStatements = buildSeedStatements();
  const state = await inspectDatabase(db, seedStatements.length);
  if (state.kind === 'empty') {
    // Claim only an empty database, atomically, before any schema/seed work.
    await db.batch([
      db.prepare(METADATA_TABLE_SQL),
      db
        .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
        .bind(
          INITIALIZATION_KEY,
          JSON.stringify({ version: INITIALIZATION_VERSION, nextStatement: 0 }),
        ),
    ]);
  }

  await migrateDistributorTable(db);
  await migrateChargeAccountTable(db);
  await migrateDistributorUsers(db);
  await migrateAuthTables(db);
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
  if (state.kind === 'ready') {
    await seedSupportIncidents(db);
    if (state.schemaVersion !== SCHEMA_VERSION) {
      await db
        .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .bind('schema_version', SCHEMA_VERSION)
        .run();
      await db.prepare('PRAGMA optimize').run();
    }
    return db;
  }

  const nextStatement = state.kind === 'pending' ? state.nextStatement : 0;
  for (
    let index = nextStatement;
    index < seedStatements.length;
    index += BATCH_SIZE
  ) {
    const batch = seedStatements
      .slice(index, index + BATCH_SIZE)
      .map((statement) => db.prepare(statement.sql).bind(...statement.params));
    // D1 batches commit atomically: progress never advances past a failed batch.
    await db.batch([
      ...batch,
      progressStatement(
        db,
        Math.min(index + BATCH_SIZE, seedStatements.length),
      ),
    ]);
  }
  await seedSupportIncidents(db);
  await db.batch([
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind('schema_version', SCHEMA_VERSION),
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind('seed_version', SEED_VERSION),
    db.prepare('DELETE FROM metadata WHERE key = ?').bind(INITIALIZATION_KEY),
  ]);
  await db.prepare('PRAGMA optimize').run();
  return db;
}

type DatabaseState =
  | { kind: 'empty' }
  | { kind: 'pending'; nextStatement: number }
  | { kind: 'ready'; schemaVersion: string };

function unsupportedDatabase(): never {
  throw new Error(
    'Unsupported database state. Startup made no changes. Preserve the database and review its version metadata before applying an explicit migration or reset.',
  );
}

function progressStatement(db: D1Database, nextStatement: number) {
  return db
    .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(
      INITIALIZATION_KEY,
      JSON.stringify({ version: INITIALIZATION_VERSION, nextStatement }),
    );
}

async function inspectDatabase(
  db: D1Database,
  seedLength: number,
): Promise<DatabaseState> {
  const tables = await db
    .prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`)
    .all<{ name: string }>();
  const metadata = tables.results.some(({ name }) => name === 'metadata')
    ? (
        await db
          .prepare('SELECT key, value FROM metadata')
          .all<{ key: string; value: string }>()
      ).results
    : [];
  const markers = new Map(metadata.map(({ key, value }) => [key, value]));
  const seedVersion = markers.get('seed_version');
  const schemaVersion = markers.get('schema_version');
  const incidentVersion = markers.get('support_incidents_seed_version');
  const progress = markers.get(INITIALIZATION_KEY);
  if (incidentVersion !== undefined && incidentVersion !== '1')
    unsupportedDatabase();

  if (progress !== undefined) {
    if (seedVersion !== undefined || schemaVersion !== undefined)
      unsupportedDatabase();
    let parsed: unknown;
    try {
      parsed = JSON.parse(progress);
    } catch {
      unsupportedDatabase();
    }
    if (typeof parsed !== 'object' || parsed === null) unsupportedDatabase();
    const { version, nextStatement } = parsed as Record<string, unknown>;
    if (
      version !== INITIALIZATION_VERSION ||
      typeof nextStatement !== 'number' ||
      !Number.isInteger(nextStatement) ||
      nextStatement < 0 ||
      nextStatement > seedLength ||
      (incidentVersion === '1' && nextStatement !== seedLength) ||
      (nextStatement !== seedLength && nextStatement % BATCH_SIZE !== 0)
    )
      unsupportedDatabase();
    return { kind: 'pending', nextStatement };
  }

  if (seedVersion !== undefined || schemaVersion !== undefined) {
    if (
      seedVersion !== SEED_VERSION ||
      schemaVersion === undefined ||
      !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)
    )
      unsupportedDatabase();
    return { kind: 'ready', schemaVersion };
  }

  // Schema-only local databases are safe to seed; unmarked records are not.
  const knownTables = new Set(
    schemaStatements.flatMap((sql) => {
      const match = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql);
      return match ? [match[1]] : [];
    }),
  );
  for (const { name } of tables.results) {
    if (!knownTables.has(name)) unsupportedDatabase();
    if (await db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).first())
      unsupportedDatabase();
  }
  return { kind: 'empty' };
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
