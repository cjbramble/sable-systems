import { RETURN_ITEMS_TABLE_SQL, SHIPMENT_ITEMS_TABLE_SQL } from './schema';

// Empty schema-only databases have no version marker. A failed setup may also
// leave the old tables alongside a current initialization checkpoint.
export async function hasLegacyOrderLineTables(db: D1Database) {
  for (const [child, parent] of [
    ['shipment_items', 'shipments'],
    ['return_items', 'returns'],
  ]) {
    const { results } = await db
      .prepare(`PRAGMA foreign_key_list(${child})`)
      .all<{ table: string; from: string }>();
    if (
      results.some((key) => key.table === parent) &&
      !results.some((key) => key.table === parent && key.from === 'order_id')
    )
      return true;
  }
  return false;
}

// Run before any startup writes: independent legacy FKs do not detect mismatches.
export async function auditOrderLineParents(db: D1Database) {
  const mismatch = await db
    .prepare(`SELECT si.shipment_id AS parent_id
      FROM shipment_items si
      LEFT JOIN shipments s ON s.shipment_id = si.shipment_id
      WHERE s.shipment_id IS NULL OR si.order_id <> s.order_id
      UNION ALL
      SELECT ri.return_id AS parent_id
      FROM return_items ri
      LEFT JOIN returns r ON r.return_id = ri.return_id
      WHERE r.return_id IS NULL OR ri.order_id <> r.order_id
      LIMIT 1`)
    .first();
  if (mismatch)
    throw new Error(
      'Cannot upgrade database: shipment or return lines do not match their parent order. Startup made no changes. Preserve the database and repair the inconsistent records before retrying.',
    );
}

// Schemas 6–9 have the same child tables and no objects referencing them.
// Run with parent indexes and the version marker in one atomic D1 batch.
export const orderLineMigrationStatements = [
  'ALTER TABLE shipment_items RENAME TO shipment_items_legacy',
  SHIPMENT_ITEMS_TABLE_SQL,
  `INSERT INTO shipment_items (shipment_id, order_id, line_number, shipped_quantity)
    SELECT shipment_id, order_id, line_number, shipped_quantity FROM shipment_items_legacy`,
  'DROP TABLE shipment_items_legacy',
  'ALTER TABLE return_items RENAME TO return_items_legacy',
  RETURN_ITEMS_TABLE_SQL,
  `INSERT INTO return_items (return_id, order_id, line_number, return_quantity, disposition)
    SELECT return_id, order_id, line_number, return_quantity, disposition FROM return_items_legacy`,
  'DROP TABLE return_items_legacy',
] as const;
