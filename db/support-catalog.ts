import type {
  CatalogCategoryOutcome,
  CatalogProductFacts,
  InventoryAdvisoryFacts,
  InventoryAdvisoryOutcome,
} from '@/lib/support-catalog-outcomes';
import { lowStockSql, orderableProductSql } from '@/lib/product-eligibility';

export async function lookupSupportCategory(
  db: D1Database,
  category: string,
): Promise<CatalogCategoryOutcome> {
  const rows = await db
    .prepare(`SELECT p.item_number, p.product_name, p.fulfillment_type,
      p.unit_price_cents, p.unit_label, p.case_pack, p.lead_time_days,
      CASE WHEN p.fulfillment_type = 'license' THEN NULL
        ELSE COALESCE(SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity), 0)
      END AS available,
      COALESCE(SUM(i.inbound_quantity), 0) AS inbound
      FROM products p
      LEFT JOIN inventory_balances i ON i.item_number = p.item_number
      WHERE ${orderableProductSql('p')} AND p.category = ?
      GROUP BY p.item_number ORDER BY p.product_name LIMIT 12`)
    .bind(category)
    .all<CatalogProductFacts>();
  return {
    kind: 'catalog_category',
    outcome: 'found',
    category,
    retrievedAt: new Date().toISOString(),
    facts: rows.results,
    verifiedReferences: rows.results.map(({ item_number }) => ({
      namespace: 'item_number',
      identifier: item_number,
    })),
  };
}

export async function lookupSupportInventoryAdvisories(
  db: D1Database,
): Promise<InventoryAdvisoryOutcome> {
  const rows = await db
    .prepare(`SELECT p.item_number, p.product_name, p.case_pack,
      COALESCE(SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity), 0) AS available,
      COALESCE(SUM(i.inbound_quantity), 0) AS inbound,
      MIN(i.expected_restock_date) AS restock
      FROM products p
      -- Matches the account alert count: no inventory rows means none available.
      LEFT JOIN inventory_balances i ON i.item_number = p.item_number
      WHERE ${orderableProductSql('p')} AND p.fulfillment_type = 'physical'
      GROUP BY p.item_number, p.product_name, p.case_pack
      HAVING ${lowStockSql('available', 'p')}
      ORDER BY available, p.item_number LIMIT 6`)
    .all<InventoryAdvisoryFacts>();
  return {
    kind: 'inventory_advisories',
    outcome: 'found',
    retrievedAt: new Date().toISOString(),
    facts: rows.results,
    verifiedReferences: rows.results.map(({ item_number }) => ({
      namespace: 'item_number',
      identifier: item_number,
    })),
  };
}
