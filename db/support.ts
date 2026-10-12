import {
  lookupSupportAccount,
  lookupSupportSummary,
  lookupSupportIncidentHistory,
} from './support-account';
import type {
  AccountLookupOutcome,
  SummaryLookupOutcome,
  IncidentHistoryOutcome,
} from '@/lib/support-account-outcomes';
import type { AuthenticatedUser } from './auth';
import { lookupSupportOrder } from './support-orders';
import { lookupSupportOrderSearch } from './support-order-search';
import type { OrderSearchOutcome } from '@/lib/support-order-search-outcomes';
import { lookupSupportShipment } from './support-shipments';
import { lookupSupportReturn } from './support-returns';
import {
  lookupSupportProducts,
  type SupportProductRow,
} from './support-products';
import type { ProductLookupOutcome } from '@/lib/support-product-outcomes';
import type { CatalogLookupOutcome } from '@/lib/support-catalog-outcomes';
import {
  lookupSupportCategory,
  lookupSupportInventoryAdvisories,
} from './support-catalog';
import {
  renderSupportContextPart,
  type RecordLookupOutcome,
  type SupportContextPart,
  type SupportContextResult,
} from '@/lib/support-outcomes';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import {
  bindProductQuantities,
  type ProductMention,
  type QuantityOccurrence,
} from '@/lib/support-quantities';
import { itemReferences } from '@/lib/support-references';
import {
  classifySupportQueries,
  type SupportQueryIntent,
} from '@/lib/support-query';

const REFERENCE_NAMESPACE_LABELS = {
  order_id: 'order ID',
  customer_po: 'customer PO',
  shipment_id: 'shipment ID',
  tracking_reference: 'tracking reference',
  return_id: 'return ID',
};

function compoundPartLabel(intent: SupportQueryIntent) {
  if (intent.kind === 'orders') return 'order search';
  if (!('identifier' in intent)) return 'catalog request';
  const namespace =
    intent.namespace === 'unresolved'
      ? ''
      : ` (${REFERENCE_NAMESPACE_LABELS[intent.namespace]})`;
  return `${intent.kind} ${intent.identifier}${namespace}`;
}

const CLARIFICATION_REFERENCES = {
  order: 'order ID or customer PO number',
  shipment: 'shipment ID or tracking reference',
  return: 'return ID',
  record: 'order, shipment, or return reference, or item number',
};

type Clarification = Extract<SupportContextResult, { kind: 'clarification' }>;

const QUANTITY_CLARIFICATIONS = {
  syntax:
    'Please provide a whole-number quantity of units for each item, using digits with optional comma grouping.',
  range: 'Please provide a quantity from 1 to 999,999 units for each item.',
  ambiguous:
    'Please specify one quantity for each item, or say that the same quantity applies to each item.',
  missing_target:
    'Please provide the item number or product name for the requested quantity.',
};

function quantityClarification(
  reason: keyof typeof QUANTITY_CLARIFICATIONS,
): Clarification {
  return { kind: 'clarification', message: QUANTITY_CLARIFICATIONS[reason] };
}

// Each part of a compound question is retrieved with the same scoped lookups
// and combined into one records block, so every part is evidence and a missing
// record is stated alongside the authorized ones.
export async function buildSupportContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
): Promise<SupportContextResult> {
  const intents = classifySupportQueries(messages);
  const parts: SupportContextPart[] = [];
  const rendered: string[] = [];
  for (const [index, intent] of intents.entries()) {
    const context = await authorizedContextForIntent(db, intent, user);
    // Resolve ambiguity before any compound facts are sent to the model.
    if (context.kind === 'clarification') return context;
    if (context.outcome === 'ambiguous')
      return {
        kind: 'clarification',
        message:
          context.kind === 'order'
            ? `Please specify whether ${context.reference.identifier} is an order ID or a customer PO number.`
            : context.reference.namespace === 'tracking_reference'
              ? `Please specify a shipment ID for tracking reference ${context.reference.identifier}.`
              : `Please specify whether ${context.reference.identifier} is a shipment ID or a tracking reference.`,
      };
    parts.push(context);
    const text = renderSupportContextPart(context);
    if (intents.length === 1) return { kind: 'records', records: text, parts };
    const records = text
      .replace(/^<authorized_records>\n/, '')
      .replace(/\n<\/authorized_records>$/, '');
    rendered.push(
      `Part ${index + 1} of ${intents.length}: ${compoundPartLabel(intent)}\n${records}`,
    );
  }
  return {
    kind: 'records',
    parts,
    records: `<authorized_records>
The customer asked about ${intents.length} things in one message. Answer each part from its own records.

${rendered.join('\n\n')}
</authorized_records>`,
  };
}

async function authorizedContextForIntent(
  db: D1Database,
  intent: SupportQueryIntent,
  user: AuthenticatedUser,
): Promise<
  | AccountLookupOutcome
  | SummaryLookupOutcome
  | IncidentHistoryOutcome
  | Clarification
  | RecordLookupOutcome
  | OrderSearchOutcome
  | ProductLookupOutcome
  | CatalogLookupOutcome
> {
  if (intent.kind === 'orders' && intent.statusFilter?.kind === 'clarification')
    return {
      kind: 'clarification',
      message:
        'Please clarify which order statuses to include or exclude. For example, ask for orders excluding cancelled and delivered.',
    };
  if (intent.kind === 'catalog') {
    for (const { quantity } of intent.quantities)
      if (quantity.kind === 'invalid')
        return quantityClarification(quantity.reason);
  }
  const { products, mentions } =
    'message' in intent
      ? await matchProducts(
          db,
          intent.message,
          intent.kind === 'catalog' ? intent.quantities : [],
        )
      : { products: [], mentions: [] };
  if (
    intent.kind === 'catalog' ||
    intent.kind === 'orders' ||
    intent.kind === 'summary'
  ) {
    const references = itemReferences(intent.message);
    if (references.length) {
      const unknown = references.filter(
        (reference) =>
          !products.some((product) => product.item_number === reference),
      );
      if (unknown.length)
        return {
          kind: 'unknown_products',
          outcome: 'unavailable',
          requestedItemNumbers: unknown,
        };
    }
  }
  switch (intent.kind) {
    case 'clarification':
      return {
        kind: 'clarification',
        message: `Please specify ${intent.reason === 'multiple_targets' ? 'which' : 'the'} ${intent.entity} you mean by its ${CLARIFICATION_REFERENCES[intent.entity]}.`,
      };
    case 'order':
      return lookupSupportOrder(db, intent, user);
    case 'shipment':
      return lookupSupportShipment(db, intent, user);
    case 'return':
      return lookupSupportReturn(db, intent, user);
    case 'orders': {
      const product = products[0];
      return lookupSupportOrderSearch(db, user, {
        statusFilter:
          intent.statusFilter?.kind === 'filter'
            ? intent.statusFilter
            : undefined,
        year: intent.year,
        yearField: intent.yearField,
        product: product
          ? {
              item_number: product.item_number,
              product_name: product.product_name,
            }
          : undefined,
      });
    }
    case 'incidents':
      return lookupSupportIncidentHistory(db, user);
    case 'account':
      return lookupSupportAccount(db, user, intent.includeCharges);
    case 'catalog': {
      let quantities = new Map<string, number>();
      if (intent.quantities.length) {
        if (products.length > 3)
          return {
            kind: 'clarification',
            message:
              'Please ask about quantities for up to three items at a time.',
          };
        const binding = bindProductQuantities(
          intent.message,
          intent.quantities,
          mentions,
        );
        if (binding.kind === 'clarification')
          return quantityClarification(binding.reason);
        quantities = binding.quantities;
      }
      if (products.length > 0 && (!intent.category || products.length <= 3)) {
        const selected =
          intent.compare || intent.quantities.length > 0
            ? products.slice(0, 3)
            : products.slice(0, 1);
        return lookupSupportProducts(
          db,
          selected.map((product) => ({
            product,
            quantity: quantities.get(product.item_number),
          })),
          intent.includeLocations,
        );
      }
      if (intent.category) return lookupSupportCategory(db, intent.category);
      return lookupSupportInventoryAdvisories(db);
    }
    case 'summary': {
      if (products.length > 0)
        return lookupSupportProducts(db, [{ product: products[0] }]);
      return lookupSupportSummary(db, user);
    }
  }
}

function productMentions(
  message: string,
  itemNumber: string,
  term: string,
  wholeToken = false,
): ProductMention[] {
  const mentions: ProductMention[] = [];
  let start = message.indexOf(term);
  while (start !== -1) {
    const end = start + term.length;
    if (
      !wholeToken ||
      (!/[\w-]/.test(message[start - 1] ?? '') &&
        !/[\w-]/.test(message[end] ?? ''))
    )
      mentions.push({ itemNumber, start, end });
    start = message.indexOf(term, end);
  }
  return mentions;
}

async function matchProducts(
  db: D1Database,
  message: string,
  quantities: QuantityOccurrence[] = [],
) {
  const rows = await db
    .prepare(`SELECT item_number, product_name, category, fulfillment_type,
      unit_price_cents, unit_label, case_pack, lead_time_days, active_to,
      search_terms FROM products ORDER BY product_name`)
    .all<SupportProductRow>();
  const explicitMatches: SupportProductRow[] = [];
  const references = new Set(itemReferences(message));
  const mentions: ProductMention[] = [];
  for (const product of rows.results) {
    const itemNumber = product.item_number.toLowerCase();
    const productName = product.product_name.toLowerCase();
    if (references.has(product.item_number) || message.includes(productName)) {
      explicitMatches.push(product);
      const exact = [
        ...productMentions(message, product.item_number, itemNumber, true),
        ...productMentions(message, product.item_number, productName),
      ];
      // "SBL-CSR-R2 controller" describes the explicit product; its trailing
      // noun must not become another product through the generic alias tier.
      const descriptors = [
        product.unit_label,
        `${product.unit_label}s`,
        ...product.search_terms.split(','),
      ]
        .map((term) => term.trim())
        .filter((term) => term.length >= 4)
        .flatMap((term) =>
          productMentions(message, product.item_number, term, true),
        )
        .filter((descriptor) =>
          exact.some(
            (mention) =>
              (descriptor.start >= mention.end &&
                /^\s+$/.test(message.slice(mention.end, descriptor.start))) ||
              (descriptor.end <= mention.start &&
                /^\s+$/.test(message.slice(descriptor.end, mention.start))),
          ),
        );
      mentions.push(...exact, ...descriptors);
    }
  }
  // Mask exact references without shifting the source positions. A word in a
  // full product name must not also identify another product through an alias.
  const keywordCharacters = message.split('');
  for (const { start, end } of mentions)
    keywordCharacters.fill(' ', start, end);
  // The final word of a parsed quantity is its unit, not a product alias:
  // "20 licenses of SBL-RLY-1Y" must not also select Palisade via "license".
  for (const { start, end } of quantities) {
    const unit = message.slice(start, end).match(/[a-z]+$/i)?.[0];
    if (unit) keywordCharacters.fill(' ', end - unit.length, end);
  }
  const keywordMessage = keywordCharacters.join('');
  // Check aliases after collecting all explicit references, regardless of row
  // order. Separately mentioned aliases remain available for mixed comparisons.
  const keywordMatches: SupportProductRow[] = [];
  for (const product of rows.results) {
    const aliases = product.search_terms
      .split(',')
      .map((term) => term.trim())
      .filter((term) => term.length >= 4);
    const aliasMentions = aliases.flatMap((term) =>
      productMentions(keywordMessage, product.item_number, term),
    );
    if (!aliasMentions.length) continue;
    mentions.push(...aliasMentions);
    if (!explicitMatches.includes(product)) keywordMatches.push(product);
  }
  // Full names and item numbers outrank generic terms such as "controller".
  // Preserve alphabetical order within each tier and include each product once.
  return { products: [...explicitMatches, ...keywordMatches], mentions };
}
