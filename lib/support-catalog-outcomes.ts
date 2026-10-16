import { formatCurrency } from './format';
import type { VerifiedSupportReference } from './support-outcomes';
import type { SupportProduct } from './support-product-outcomes';

export type CatalogProductFacts = Pick<
  SupportProduct,
  | 'item_number'
  | 'product_name'
  | 'fulfillment_type'
  | 'unit_price_cents'
  | 'unit_label'
  | 'case_pack'
  | 'lead_time_days'
> & { available: number | null; inbound: number };

export type InventoryAdvisoryFacts = Pick<
  SupportProduct,
  'item_number' | 'product_name' | 'case_pack'
> & {
  available: number;
  inbound: number;
  restock: string | null;
};

export type CatalogCategoryOutcome = {
  kind: 'catalog_category';
  outcome: 'found';
  category: string;
  retrievedAt: string;
  facts: CatalogProductFacts[];
  verifiedReferences: VerifiedSupportReference[];
};

export type InventoryAdvisoryOutcome = {
  kind: 'inventory_advisories';
  outcome: 'found';
  retrievedAt: string;
  facts: InventoryAdvisoryFacts[];
  verifiedReferences: VerifiedSupportReference[];
};

type UnknownProductsOutcome = {
  kind: 'unknown_products';
  outcome: 'unavailable';
  // Requested item numbers may be echoed without verifying any record.
  requestedItemNumbers: string[];
};

type OmittedProductsOutcome = {
  kind: 'omitted_products';
  outcome: 'omitted';
  // Unanswered targets are echo allowances, not missing or verified products.
  requestedItemNumbers: string[];
  limit: number;
};

export type CatalogLookupOutcome =
  | CatalogCategoryOutcome
  | InventoryAdvisoryOutcome
  | UnknownProductsOutcome
  | OmittedProductsOutcome;

export function renderCatalogOutcome(result: CatalogLookupOutcome): string {
  switch (result.kind) {
    case 'omitted_products':
      return `<authorized_records>
Items not answered because of the limit of ${result.limit} items per catalog request: ${result.requestedItemNumbers.join(', ')}.
Tell the customer these items were omitted and ask them to request them separately. Do not claim they are missing or infer their availability, price, or orderability.
</authorized_records>`;
    case 'unknown_products':
      return `<authorized_records>
No catalog item matching ${result.requestedItemNumbers.join(', ')} was found. Ask the customer to verify the complete item number. Do not substitute a similarly numbered product or infer its stock or price.
</authorized_records>`;
    case 'catalog_category':
      return `<authorized_records>
Active ${result.category} catalog retrieved at ${result.retrievedAt}:
${result.facts.map((row) => `- ${row.item_number} ${row.product_name}: ${formatCurrency(row.unit_price_cents, 'USD')} per ${row.unit_label}; pack ${row.case_pack}; lead ${row.lead_time_days} days; ${row.fulfillment_type === 'license' ? 'digital allocation' : `${row.available} available, ${row.inbound} inbound`}.`).join('\n') || '- No active products in this category.'}
</authorized_records>`;
    case 'inventory_advisories':
      return `<authorized_records>
Current SABLE physical inventory advisories retrieved at ${result.retrievedAt}:
${result.facts.map((row) => `- ${row.item_number} ${row.product_name}: ${row.available} available; ${row.inbound} inbound; restock ${row.restock ?? 'not scheduled'}.`).join('\n')}
Ask which item the customer wants if a specific availability decision is required.
</authorized_records>`;
  }
}
