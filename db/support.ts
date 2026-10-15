import { lookupSupportProductRequest } from './support-product-requests';
import {
  lookupSupportAccount,
  lookupSupportSummary,
  lookupSupportIncidentHistory,
} from './support-account';
import type { AuthenticatedUser } from './auth';
import { lookupSupportOrder } from './support-orders';
import { lookupSupportOrderSearch } from './support-order-search';
import { lookupSupportShipment } from './support-shipments';
import { lookupSupportReturn } from './support-returns';
import {
  lookupSupportProducts,
  type SupportProductRow,
} from './support-products';
import {
  renderSupportContextPart,
  type RecordLookupOutcome,
  type SupportContextPart,
  type SupportContextResult,
} from '@/lib/support-outcomes';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import type {
  ProductMention,
  QuantityOccurrence,
} from '@/lib/support-quantities';
import { itemReferences } from '@/lib/support-references';
import {
  classifySupportQueries,
  type SupportQueryIntent,
} from '@/lib/support-query';
import { supportRequestLabel } from '@/lib/support-request-outcomes';

const MAX_COMPOUND_REQUESTS = 3;

const CLARIFICATION_REFERENCES = {
  order: 'order ID or customer PO number',
  shipment: 'shipment ID or tracking reference',
  return: 'return ID',
  record: 'order, shipment, or return reference, or item number',
};

type Clarification = Extract<SupportContextResult, { kind: 'clarification' }>;

// Each intent uses scoped lookups and can yield several typed outcomes, so
// known, unknown and omitted product targets remain visible together.
export async function buildSupportContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
): Promise<SupportContextResult> {
  const intents = classifySupportQueries(messages);
  const selected = intents.slice(0, MAX_COMPOUND_REQUESTS);
  const omitted = intents.slice(MAX_COMPOUND_REQUESTS);
  const parts: SupportContextPart[] = [];
  const rendered: string[] = [];
  for (const [index, intent] of selected.entries()) {
    const result = await authorizedContextForIntent(db, intent, user);
    const outcomes = Array.isArray(result) ? result : [result];
    const group: SupportContextPart[] = [];
    for (const context of outcomes) {
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
      group.push(context);
    }
    parts.push(...group);
    const records = group
      .map((part) =>
        renderSupportContextPart(part)
          .replace(/^<authorized_records>\n/, '')
          .replace(/\n<\/authorized_records>$/, ''),
      )
      .join('\n\n');
    if (intents.length === 1)
      return {
        kind: 'records',
        records: `<authorized_records>\n${records}\n</authorized_records>`,
        parts,
      };
    rendered.push(
      `Part ${index + 1} of ${intents.length}: ${supportRequestLabel(intent)}\n${records}`,
    );
  }
  if (omitted.length) {
    const omission = {
      kind: 'omitted_requests' as const,
      outcome: 'omitted' as const,
      requests: omitted,
      limit: MAX_COMPOUND_REQUESTS,
    };
    parts.push(omission);
    rendered.push(renderSupportContextPart(omission));
  }
  return {
    kind: 'records',
    parts,
    records: `<authorized_records>
The customer asked about ${intents.length} things in one message. Answer retrieved parts from their own records and explicitly report any omitted parts.

${rendered.join('\n\n')}
</authorized_records>`,
  };
}

async function authorizedContextForIntent(
  db: D1Database,
  intent: SupportQueryIntent,
  user: AuthenticatedUser,
): Promise<
  | Clarification
  | RecordLookupOutcome
  | SupportContextPart
  | SupportContextPart[]
> {
  if (intent.kind === 'orders' && intent.statusFilter?.kind === 'clarification')
    return {
      kind: 'clarification',
      message:
        'Please clarify which order statuses to include or exclude. For example, ask for orders excluding cancelled and delivered.',
    };
  const matches =
    'message' in intent
      ? await matchProducts(
          db,
          intent.message,
          intent.kind === 'catalog' ? intent.quantities : [],
        )
      : { products: [], explicitProducts: [], mentions: [] };
  const { products } = matches;
  if (intent.kind === 'orders' || intent.kind === 'summary') {
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
    case 'catalog':
      return lookupSupportProductRequest(db, intent, matches);
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
  for (const reference of references)
    if (!rows.results.some((product) => product.item_number === reference))
      mentions.push(
        ...productMentions(message, reference, reference.toLowerCase(), true),
      );
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
  return {
    products: [...explicitMatches, ...keywordMatches],
    explicitProducts: explicitMatches,
    mentions,
  };
}
