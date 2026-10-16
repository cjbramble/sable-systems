import { env } from 'cloudflare:workers';

import {
  METADATA_TABLE_SQL,
  schemaStatements,
  schemaTables,
  SCHEMA_VERSION,
  SEED_VERSION,
} from './schema';
import { buildSeedStatements, buildSupportSeedStatements } from './seed';
import {
  hasUnsupportedLegacyLayout,
  planSchemaUpgrades,
  schemaAlterationsCompleted,
} from './schema-upgrades';
import {
  auditOrderLineParents,
  hasLegacyOrderLineTables,
  orderLineMigrationStatements,
} from './order-line-migration';

const BATCH_SIZE = 75;
const INITIALIZATION_KEY = 'initialization_progress';
// Change this protocol if batch boundaries or the seed statement order change.
const INITIALIZATION_VERSION = `${SCHEMA_VERSION}/${SEED_VERSION}/${BATCH_SIZE}/1`;
const SUPPORTED_SCHEMA_VERSIONS = new Set([
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  SCHEMA_VERSION,
]);
let initialization: Promise<D1Database> | null = null;

export function getDatabase(): Promise<D1Database> {
  initialization ??= initializeDatabase().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

async function initializeDatabase(
  retrySchemaMigration = true,
): Promise<D1Database> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('The DB binding is not configured.');

  let cachedSeed: ReturnType<typeof buildSeedStatements> | undefined;
  const seed = () => (cachedSeed ??= buildSeedStatements());
  const state = await inspectDatabase(db, () => seed().length);
  const seedStatements = state.kind === 'ready' ? [] : seed();
  if (await hasUnsupportedLegacyLayout(db)) unsupportedDatabase();
  const upgrades = await planSchemaUpgrades(db);
  const upgradingSchema =
    state.kind === 'ready' && state.schemaVersion !== SCHEMA_VERSION;
  const needsOrderLineMigration =
    state.kind === 'ready'
      ? ['6', '7', '8', '9'].includes(state.schemaVersion)
      : await hasLegacyOrderLineTables(db);
  if (state.kind === 'ready' && needsOrderLineMigration)
    await auditOrderLineParents(db);
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

  const schemaBatch = schemaStatements.map((sql) => db.prepare(sql));
  if (needsOrderLineMigration)
    schemaBatch.push(
      ...orderLineMigrationStatements.map((sql) => db.prepare(sql)),
    );
  schemaBatch.push(...upgrades.statements.map((sql) => db.prepare(sql)));
  if (upgradingSchema)
    schemaBatch.push(
      db
        .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .bind('schema_version', SCHEMA_VERSION),
    );
  // Constraints, copied rows, and the upgrade marker commit together.
  try {
    await db.batch(schemaBatch);
  } catch (error) {
    // Another Worker may commit after our column inspection. Rebuild once from
    // fresh state only when it completed this migration; retain other failures.
    if (
      retrySchemaMigration &&
      upgradingSchema &&
      error instanceof Error &&
      ((upgrades.addsRevisions &&
        error.message.includes('duplicate column name: revision')) ||
        (upgrades.removesSessionActivity &&
          error.message.includes('no such column') &&
          error.message.includes('last_seen_at'))) &&
      (await schemaMigrationCompleted(db, () => seed().length))
    )
      return initializeDatabase(false);
    throw error;
  }
  if (state.kind === 'ready') {
    await seedSupportIncidents(db);
    if (upgradingSchema) await db.prepare('PRAGMA optimize').run();
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

async function schemaMigrationCompleted(
  db: D1Database,
  seedLength: () => number,
) {
  try {
    const state = await inspectDatabase(db, seedLength);
    if (state.kind !== 'ready' || state.schemaVersion !== SCHEMA_VERSION)
      return false;
    return await schemaAlterationsCompleted(db);
  } catch {
    // A failed recovery inspection must not replace the original batch error.
    return false;
  }
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
  seedLength: () => number,
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
      nextStatement > seedLength() ||
      (incidentVersion === '1' && nextStatement !== seedLength()) ||
      (nextStatement !== seedLength() && nextStatement % BATCH_SIZE !== 0)
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
  const knownTables = new Set<string>(schemaTables);
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

  const statements = buildSupportSeedStatements(
    users.results.map(({ user_id }) => user_id),
  ).map(({ sql, params }) => db.prepare(sql).bind(...params));
  statements.push(
    db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .bind(markerKey, '1'),
  );
  await db.batch(statements);
}
