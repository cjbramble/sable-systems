import { formatCurrency } from './format';
import type { VerifiedSupportReference } from './support-outcomes';

export type SupportProduct = {
  item_number: string;
  product_name: string;
  category: string;
  fulfillment_type: 'physical' | 'license';
  unit_price_cents: number;
  unit_label: string;
  case_pack: number;
  lead_time_days: number;
  active_to: string | null;
};

export type SupportProductLocation = {
  location_name: string;
  service_region: string;
  available: number;
  inbound_quantity: number;
  expected_restock_date: string | null;
};

export type SupportProductFacts = {
  product: SupportProduct;
  quantity?: number;
  // Catalog eligibility is independent of stock and quantity constraints.
  orderable: boolean;
  fulfillment:
    | { kind: 'license' }
    | {
        kind: 'physical';
        available: number;
        inbound: number;
        expectedRestockDate: string | null;
        updatedAt: string | null;
        retrievedAt: string;
        // null means locations were not requested; [] means none were found.
        locations: SupportProductLocation[] | null;
      };
};

export type ProductLookupOutcome = {
  kind: 'products';
  outcome: 'found';
  facts: SupportProductFacts[];
  verifiedReferences: VerifiedSupportReference[];
};

export function renderProductOutcome(result: ProductLookupOutcome): string {
  return `<authorized_records>
${result.facts.map(renderProduct).join('\n')}
</authorized_records>`;
}

function renderProduct({
  product,
  quantity,
  orderable,
  fulfillment,
}: SupportProductFacts): string {
  const status = orderable
    ? 'Catalog status: active; eligible for new orders, subject to quantity and stock requirements.'
    : `Catalog status: retired (retirement marker: ${product.active_to}); not eligible for new orders. Remaining stock does not make this product orderable. Do not offer order quantity adjustments or promise fulfillment of a new order for this product. Historical order records remain available.`;
  if (fulfillment.kind === 'license') {
    const quantityNote =
      quantity !== undefined
        ? `Requested quantity ${quantity}: ${quantity % product.case_pack === 0 ? 'valid minimum-block multiple' : orderable ? `must be adjusted to a multiple of ${product.case_pack}` : `not a minimum-block multiple of ${product.case_pack}`}.
`
        : '';
    return `Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
${status}
Wholesale price: ${formatCurrency(product.unit_price_cents)} per ${product.unit_label}; minimum block ${product.case_pack}.
${quantityNote}This is a digitally allocated license and does not have a physical stock balance.`;
  }
  const inventory = fulfillment;
  const available = inventory.available;
  const invalidCasePack =
    quantity !== undefined && quantity % product.case_pack !== 0;
  // Compare the original request to usable stock, not to an adjusted case-pack
  // quantity. Surplus stock is not a negative shortage or an adjustment gap.
  const requestedShortfall =
    quantity === undefined ? undefined : Math.max(0, quantity - available);
  const quantityNote =
    quantity !== undefined
      ? `Requested quantity ${quantity}: ${invalidCasePack ? `not a multiple of case pack ${product.case_pack}` : 'valid case-pack multiple'}; ${available >= quantity ? 'currently within available-to-promise stock' : `exceeds current available-to-promise stock by ${requestedShortfall}`}.
`
      : '';
  const shortfallNote =
    quantity !== undefined
      ? `Stock shortfall for requested quantity ${quantity}: ${requestedShortfall} units (${quantity} requested; ${available} available). Case-pack adjustment distance is not a stock shortfall.\n`
      : '';
  const orderingRestriction =
    invalidCasePack && orderable
      ? `Ordering restriction: quantity ${quantity} cannot be ordered or fulfilled as requested. It must be adjusted to a full case-pack multiple of ${product.case_pack}; sufficient stock does not waive this rule. Do not offer partial-unit or broken-case exceptions to this ordering restriction.\n`
      : '';
  const adjustmentNote =
    invalidCasePack && orderable
      ? casePackAdjustmentContext(quantity, product.case_pack, available)
      : '';
  const locationNote =
    inventory.locations === null
      ? ''
      : `\nFulfillment locations (each figure is part of the ${available} total available to promise; give the total unless the customer names a specific location):\n${inventory.locations.map((location) => `- ${location.location_name} (${location.service_region}): ${location.available} available; ${location.inbound_quantity} inbound; restock ${location.expected_restock_date ?? 'not scheduled'}.`).join('\n') || '- No physical fulfillment locations recorded.'}`;
  return `Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
${status}
Wholesale price: ${formatCurrency(product.unit_price_cents)} per ${product.unit_label}; case pack ${product.case_pack}; standard lead time ${product.lead_time_days} days.
${quantityNote}${shortfallNote}${orderingRestriction}${adjustmentNote}Available to promise: ${available}. Inbound: ${inventory.inbound}. Expected restock: ${inventory.expectedRestockDate ?? 'none scheduled'}.
Inventory retrieved at: ${inventory.retrievedAt}. Latest inventory record update: ${inventory.updatedAt ?? 'not recorded'}.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.${locationNote}`;
}

function casePackAdjustmentContext(
  requested: number,
  casePack: number,
  available: number,
) {
  // Compute from the matched product, not from model-generated arithmetic.
  // Zero is not an orderable alternative when the request is below one case.
  const alternatives = [
    {
      quantity: Math.floor(requested / casePack) * casePack,
      label: 'Lower',
      direction: 'below',
    },
    {
      quantity: Math.ceil(requested / casePack) * casePack,
      label: 'Higher',
      direction: 'above',
    },
  ]
    .filter(({ quantity }) => quantity > 0)
    .map((alternative) => ({
      ...alternative,
      cases: alternative.quantity / casePack,
      distance: Math.abs(alternative.quantity - requested),
    }));
  const nearestDistance = Math.min(
    ...alternatives.map(({ distance }) => distance),
  );
  const nearest = alternatives.filter(
    ({ distance }) => distance === nearestDistance,
  );
  // There are at most two adjacent multiples. Explicitly distinguish a
  // farther alternative from the nearest choice so a list heading cannot
  // imply they are tied. Stock availability does not change this comparison.
  const farther = alternatives.find(
    ({ distance }) => distance > nearestDistance,
  );
  const nearestLabel =
    nearest.length === 1
      ? `Only ${nearest[0].quantity} units is nearest.`
      : `${nearest.map(({ quantity }) => quantity).join(' and ')} units are equally nearest. Both may appear in a "Nearest quantities" list.`;
  const alternativeLabel = farther
    ? ` ${farther.quantity} units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".`
    : '';
  const descriptions = alternatives.map(
    ({ quantity, label, direction, cases, distance }) => {
      const availability =
        quantity <= available
          ? 'within current available-to-promise stock'
          : `exceeds current available-to-promise stock by ${quantity - available} units`;
      return `${label} valid quantity: ${quantity} units (${cases} ${cases === 1 ? 'case' : 'cases'}), ${distance} ${distance === 1 ? 'unit' : 'units'} ${direction} requested quantity ${requested}; ${availability}.`;
    },
  );
  descriptions.push(
    `${nearest.length === 1 ? 'Nearest valid quantity' : 'Equally nearest valid quantities'}: ${nearest.map(({ quantity }) => quantity).join(' or ')} units (${nearestDistance} ${nearestDistance === 1 ? 'unit' : 'units'} from requested quantity ${requested}). Nearest means smallest absolute quantity difference, not rounding down or a guarantee of stock availability.`,
    `Response labeling: ${nearestLabel}${alternativeLabel}`,
  );
  return descriptions.join('\n') + '\n';
}
