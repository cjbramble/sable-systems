import { isProductOrderable } from '@/lib/product-eligibility';
import type {
  ProductLookupOutcome,
  SupportProduct,
  SupportProductFacts,
  SupportProductLocation,
} from '@/lib/support-product-outcomes';

export type SupportProductRow = SupportProduct & { search_terms: string };

type InventoryRow = {
  on_hand: number | null;
  reserved: number | null;
  quarantined: number | null;
  inbound: number | null;
  expected_restock_date: string | null;
  updated_at: string | null;
};

export async function lookupSupportProducts(
  db: D1Database,
  products: { product: SupportProductRow; quantity?: number }[],
  includeLocations = false,
): Promise<ProductLookupOutcome> {
  const facts = await Promise.all(
    products.map(({ product, quantity }) =>
      productFacts(db, product, quantity, includeLocations),
    ),
  );
  return {
    kind: 'products',
    outcome: 'found',
    facts,
    verifiedReferences: facts.map(({ product }) => ({
      namespace: 'item_number',
      identifier: product.item_number,
    })),
  };
}

async function productFacts(
  db: D1Database,
  row: SupportProductRow,
  quantity: number | undefined,
  includeLocations: boolean,
): Promise<SupportProductFacts> {
  // Matching aliases are retrieval metadata, not product facts for the model.
  const { search_terms: _searchTerms, ...product } = row;
  const facts = {
    product,
    quantity,
    orderable: isProductOrderable(product.active_to),
  };
  if (product.fulfillment_type === 'license')
    return { ...facts, fulfillment: { kind: 'license' } };

  const inventory = await db
    .prepare(`SELECT
      SUM(on_hand_quantity) AS on_hand,
      SUM(reserved_quantity) AS reserved,
      SUM(quarantined_quantity) AS quarantined,
      SUM(inbound_quantity) AS inbound,
      MIN(expected_restock_date) AS expected_restock_date,
      MAX(updated_at) AS updated_at
      FROM inventory_balances WHERE item_number = ?`)
    .bind(product.item_number)
    .first<InventoryRow>();
  const locations = includeLocations
    ? (
        await db
          .prepare(`SELECT l.location_name, l.service_region,
          i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity AS available,
          i.inbound_quantity, i.expected_restock_date
          FROM inventory_balances i
          JOIN fulfillment_locations l ON l.location_id = i.location_id
          WHERE i.item_number = ? ORDER BY available DESC, l.location_name`)
          .bind(product.item_number)
          .all<SupportProductLocation>()
      ).results
    : null;
  return {
    ...facts,
    fulfillment: {
      kind: 'physical',
      available:
        (inventory?.on_hand ?? 0) -
        (inventory?.reserved ?? 0) -
        (inventory?.quarantined ?? 0),
      inbound: inventory?.inbound ?? 0,
      expectedRestockDate: inventory?.expected_restock_date ?? null,
      updatedAt: inventory?.updated_at ?? null,
      retrievedAt: new Date().toISOString(),
      locations,
    },
  };
}
