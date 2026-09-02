import { env } from 'cloudflare:workers';

import {
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
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
  const currentSeed = await db
    .prepare("SELECT value FROM metadata WHERE key = 'seed_version'")
    .first<{ value: string }>();
  const currentSchema = await db
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .first<{ value: string }>();
  if (
    currentSeed?.value === SEED_VERSION &&
    currentSchema?.value === SCHEMA_VERSION
  )
    return db;

  await db.batch(seedCleanupStatements.map((sql) => db.prepare(sql)));
  const seedStatements = buildSeedStatements();
  for (let index = 0; index < seedStatements.length; index += BATCH_SIZE) {
    const batch = seedStatements
      .slice(index, index + BATCH_SIZE)
      .map((statement) => db.prepare(statement.sql).bind(...statement.params));
    await db.batch(batch);
  }
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
