// Schemas 6 and later already have distributor accounts, attributed orders,
// credentials, and sessions. Earlier compatibility conversions are unsupported.
export async function hasUnsupportedLegacyLayout(db: D1Database) {
  const legacy = await db
    .prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name IN ('wholesalers', 'simulated_payments') LIMIT 1`)
    .first();
  if (legacy) return true;
  const columns = await db
    .prepare('PRAGMA table_info(orders)')
    .all<{ name: string }>();
  return (
    columns.results.length > 0 &&
    !columns.results.some(({ name }) => name === 'placed_by_user_id')
  );
}

const REVISION_TABLES = ['support_incidents', 'support_messages'] as const;

// Schema 15 retired an index no query uses and two that duplicate indexes
// SQLite builds for UNIQUE and PRIMARY KEY constraints.
const RETIRED_INDEXES = [
  'idx_orders_customer_open',
  'idx_account_charges_order',
  'idx_inventory_item',
] as const;

// Schema 16 stores emails in lowercase. Run before any startup writes so a
// case-duplicate is refused with a clear message instead of a constraint error.
export async function auditUserEmails(db: D1Database) {
  const duplicate = await db
    .prepare(`SELECT 1 FROM users GROUP BY lower(email)
      HAVING COUNT(*) > 1 LIMIT 1`)
    .first();
  if (duplicate)
    throw new Error(
      'Cannot upgrade database: two or more users have email addresses that differ only by letter case. Startup made no changes. Preserve the database and resolve the duplicate accounts before retrying.',
    );
}

async function columnsOf(db: D1Database, table: string) {
  const { results } = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  return results.map(({ name }) => name);
}

// CREATE IF NOT EXISTS handles newly introduced tables. Existing tables need
// these explicit alterations, committed with the schema version in one batch.
export async function planSchemaUpgrades(db: D1Database) {
  const statements: string[] = [];
  for (const table of REVISION_TABLES) {
    const columns = await columnsOf(db, table);
    if (columns.length && !columns.includes('revision')) {
      statements.push(`ALTER TABLE ${table}
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)`);
    }
  }
  const addsRevisions = statements.length > 0;
  const removesSessionActivity = (await columnsOf(db, 'sessions')).includes(
    'last_seen_at',
  );
  if (removesSessionActivity)
    statements.push('ALTER TABLE sessions DROP COLUMN last_seen_at');
  if ((await columnsOf(db, 'users')).length)
    statements.push(
      'UPDATE users SET email = lower(email) WHERE email <> lower(email)',
    );
  statements.push(
    ...RETIRED_INDEXES.map((index) => `DROP INDEX IF EXISTS ${index}`),
  );
  return { statements, addsRevisions, removesSessionActivity };
}

export async function schemaAlterationsCompleted(db: D1Database) {
  for (const table of REVISION_TABLES) {
    if (!(await columnsOf(db, table)).includes('revision')) return false;
  }
  const sessions = await columnsOf(db, 'sessions');
  return sessions.includes('expires_at') && !sessions.includes('last_seen_at');
}
