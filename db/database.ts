import { env } from 'cloudflare:workers';

import {
  METADATA_TABLE_SQL,
  schemaStatements,
  schemaTables,
  SCHEMA_VERSION,
  SEED_VERSION,
} from './schema';
import { buildSeedStatements, buildSupportSeedStatements } from './seed';
import { logServerError } from '@/lib/server-log';
import {
  hasUnsupportedLegacyLayout,
  planSchemaUpgrades,
  schemaAlterationsCompleted,
} from './schema-upgrades';
import { UPGRADABLE_SEED_VERSIONS, upgradeSeed } from './seed-upgrade';
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
  '14',
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
  let state = await inspectDatabase(db, () => seed().length);
  if (isCurrent(state)) return db;
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
    // Another Worker may claim it first; then continue from its checkpoint.
    await db.batch([
      db.prepare(METADATA_TABLE_SQL),
      db
        .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING`)
        .bind(
          INITIALIZATION_KEY,
          JSON.stringify({ version: INITIALIZATION_VERSION, nextStatement: 0 }),
        ),
    ]);
    state = await inspectDatabase(db, () => seed().length);
    if (state.kind === 'empty') unsupportedDatabase();
    if (isCurrent(state)) return db;
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
    if (state.seedVersion !== SEED_VERSION) await upgradeSeed(db);
    await seedSupportIncidents(db);
    if (upgradingSchema || state.seedVersion !== SEED_VERSION)
      await optimize(db);
    return db;
  }

  let index = state.nextStatement;
  while (index < seedStatements.length) {
    const next = Math.min(index + BATCH_SIZE, seedStatements.length);
    const batch = seedStatements
      .slice(index, next)
      .map((statement) => db.prepare(statement.sql).bind(...statement.params));
    // D1 batches commit atomically: progress never advances past a failed batch.
    try {
      await db.batch([...batch, progressStatement(db, next)]);
      index = next;
    } catch (error) {
      // Every seed row has a key, so a batch another Worker already committed
      // fails whole. Continue only when its checkpoint shows that commit.
      if (!isConstraintError(error)) throw error;
      const current = await inspectDatabase(db, () => seed().length);
      if (isCurrent(current)) return db;
      if (current.kind !== 'pending' || current.nextStatement <= index)
        throw error;
      index = current.nextStatement;
    }
  }
  await seedSupportIncidents(db);
  await db.batch([
    db
      .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING`)
      .bind('schema_version', SCHEMA_VERSION),
    db
      .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING`)
      .bind('seed_version', SEED_VERSION),
    db.prepare('DELETE FROM metadata WHERE key = ?').bind(INITIALIZATION_KEY),
  ]);
  // A concurrent Worker may have written the markers first; confirm them.
  if (!isCurrent(await inspectDatabase(db, () => seed().length)))
    throw new Error(
      'Database initialization finished with unexpected version metadata.',
    );
  await optimize(db);
  return db;
}

function isCurrent(state: DatabaseState) {
  return (
    state.kind === 'ready' &&
    state.schemaVersion === SCHEMA_VERSION &&
    state.seedVersion === SEED_VERSION &&
    state.incidentVersion === '1'
  );
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint failed/i.test(error.message);
}

// Statistics upkeep only; initialization has already committed its markers.
async function optimize(db: D1Database) {
  try {
    await db.prepare('PRAGMA optimize').run();
  } catch (error) {
    logServerError('database optimize', error);
  }
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
  | {
      kind: 'ready';
      schemaVersion: string;
      seedVersion: string;
      incidentVersion: string | undefined;
    };

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
      seedVersion === undefined ||
      (seedVersion !== SEED_VERSION &&
        !UPGRADABLE_SEED_VERSIONS.has(seedVersion)) ||
      schemaVersion === undefined ||
      !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)
    )
      unsupportedDatabase();
    return { kind: 'ready', schemaVersion, seedVersion, incidentVersion };
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
      .prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING`)
      .bind(markerKey, '1'),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    // Another Worker may have committed the same history rows and marker.
    const current = await db
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .bind(markerKey)
      .first<{ value: string }>();
    if (!isConstraintError(error) || current?.value !== '1') throw error;
  }
}
