import {
  lookupSupportCategory,
  lookupSupportInventoryAdvisories,
} from './support-catalog';
import {
  lookupSupportProducts,
  type SupportProductRow,
} from './support-products';
import type { CatalogLookupOutcome } from '@/lib/support-catalog-outcomes';
import type { ProductLookupOutcome } from '@/lib/support-product-outcomes';
import type { SupportContextResult } from '@/lib/support-outcomes';
import {
  bindProductQuantities,
  type ProductMention,
} from '@/lib/support-quantities';
import type { SupportQueryIntent } from '@/lib/support-query';
import { itemReferences } from '@/lib/support-references';

type CatalogIntent = Extract<SupportQueryIntent, { kind: 'catalog' }>;
type Clarification = Extract<SupportContextResult, { kind: 'clarification' }>;
type ProductMatches = {
  products: SupportProductRow[];
  explicitProducts: SupportProductRow[];
  mentions: ProductMention[];
};
type ProductRequestPart = ProductLookupOutcome | CatalogLookupOutcome;
const PRODUCT_TARGET_LIMIT = 3;
const QUANTITY_CLARIFICATIONS = {
  syntax:
    'Please provide a whole-number quantity of units for each item, using digits with optional comma grouping.',
  range: 'Please provide a quantity from 1 to 999,999 units for each item.',
  ambiguous:
    'Please specify one quantity for each item, or say that the same quantity applies to each item.',
  missing_target:
    'Please provide the item number or product name for the requested quantity.',
};

export async function lookupSupportProductRequest(
  db: D1Database,
  intent: CatalogIntent,
  { products, explicitProducts, mentions }: ProductMatches,
): Promise<ProductRequestPart[] | Clarification> {
  for (const { quantity } of intent.quantities)
    if (quantity.kind === 'invalid')
      return {
        kind: 'clarification',
        message: QUANTITY_CLARIFICATIONS[quantity.reason],
      };

  const references = [...new Set(itemReferences(intent.message))];
  const requestedProducts =
    intent.compare || intent.quantities.length
      ? products
      : explicitProducts.length
        ? explicitProducts
        : products.slice(0, 1);
  const byNumber = new Map(
    products.map((product) => [product.item_number, product]),
  );
  const firstMention = (itemNumber: string) =>
    Math.min(
      ...mentions
        .filter((mention) => mention.itemNumber === itemNumber)
        .map(({ start }) => start),
    );
  const targets = [
    ...new Set([
      ...requestedProducts.map((product) => product.item_number),
      ...references,
    ]),
  ]
    .map((itemNumber) => ({
      itemNumber,
      product: byNumber.get(itemNumber),
      start: firstMention(itemNumber),
    }))
    .sort((left, right) => left.start - right.start);

  if (intent.quantities.length && targets.length > PRODUCT_TARGET_LIMIT)
    return {
      kind: 'clarification',
      message: 'Please ask about quantities for up to three items at a time.',
    };
  // Include unknown SKU spans when binding quantities, so their quantities cannot
  // be assigned to a different, known item merely because it is the only DB match.
  const binding = bindProductQuantities(
    intent.message,
    intent.quantities,
    mentions,
  );
  if (binding.kind === 'clarification')
    return {
      kind: 'clarification',
      message: QUANTITY_CLARIFICATIONS[binding.reason],
    };

  // A category request with no explicit item numbers retains its aggregate lookup.
  if (
    !references.length &&
    (!products.length ||
      (intent.category &&
        !intent.compare &&
        !explicitProducts.length &&
        products.length > PRODUCT_TARGET_LIMIT))
  )
    return [
      intent.category
        ? await lookupSupportCategory(db, intent.category)
        : await lookupSupportInventoryAdvisories(db),
    ];

  const selected = targets.slice(0, PRODUCT_TARGET_LIMIT);
  const parts: ProductRequestPart[] = [];
  for (let index = 0; index < selected.length; index++) {
    const target = selected[index];
    if (!target.product) {
      const previous = parts.at(-1);
      if (previous?.kind === 'unknown_products')
        previous.requestedItemNumbers.push(target.itemNumber);
      else
        parts.push({
          kind: 'unknown_products',
          outcome: 'unavailable',
          requestedItemNumbers: [target.itemNumber],
        });
      continue;
    }
    const group = [target.product];
    while (selected[index + 1]?.product) {
      index++;
      const next = selected[index].product;
      if (next) group.push(next);
    }
    parts.push(
      await lookupSupportProducts(
        db,
        group.map((product) => ({
          product,
          quantity: binding.quantities.get(product.item_number),
        })),
        intent.includeLocations,
      ),
    );
  }
  const omitted = targets.slice(PRODUCT_TARGET_LIMIT);
  if (omitted.length)
    parts.push({
      kind: 'omitted_products',
      outcome: 'omitted',
      requestedItemNumbers: omitted.map(({ itemNumber }) => itemNumber),
      limit: PRODUCT_TARGET_LIMIT,
    });
  return parts;
}
