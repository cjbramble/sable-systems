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
import type { QuantityOccurrence } from '@/lib/support-quantities';
import { findProductMentions, type ProductTerms } from '@/lib/product-mentions';
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
// Callers that already classified the conversation pass those intents.
export async function buildSupportContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
  intents?: SupportQueryIntent[],
): Promise<SupportContextResult> {
  intents ??= classifySupportQueries(
    messages,
    await loadSupportProductTerms(db),
  );
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
  if (intent.kind === 'orders' && intent.unsupportedDate)
    return {
      kind: 'clarification',
      message:
        'Order search can filter by one whole year. Please name a single year, for example orders created in 2025.',
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
      // Search every named product; dropping all but the first would answer
      // a different question than the customer asked.
      return lookupSupportOrderSearch(db, user, {
        statusFilter:
          intent.statusFilter?.kind === 'filter'
            ? intent.statusFilter
            : undefined,
        year: intent.year,
        yearField: intent.yearField,
        products: products.length
          ? products.map(({ item_number, product_name }) => ({
              item_number,
              product_name,
            }))
          : undefined,
      });
    }
    case 'incidents':
      return lookupSupportIncidentHistory(db, user);
    case 'account':
      return lookupSupportAccount(db, user);
    case 'catalog':
      return lookupSupportProductRequest(db, intent, matches);
    case 'summary': {
      if (products.length > 0)
        return lookupSupportProducts(db, [{ product: products[0] }]);
      return lookupSupportSummary(db, user);
    }
  }
}

// The classifier needs product names and aliases to keep a product named
// without its item number as the target of a follow-up.
export async function loadSupportProductTerms(
  db: D1Database,
): Promise<ProductTerms[]> {
  const rows = await db
    .prepare(
      `SELECT item_number, product_name, unit_label, search_terms
      FROM products ORDER BY product_name`,
    )
    .all<ProductTerms>();
  return rows.results;
}

async function matchProducts(
  db: D1Database,
  message: string,
  quantities: QuantityOccurrence[] = [],
) {
  const rows = await db
    .prepare(
      `SELECT item_number, product_name, category, fulfillment_type,
      unit_price_cents, unit_label, case_pack, lead_time_days, active_to,
      search_terms FROM products ORDER BY product_name`,
    )
    .all<SupportProductRow>();
  const { explicitProducts, keywordProducts, mentions } = findProductMentions(
    message,
    rows.results,
    quantities,
  );
  // Full names and item numbers outrank generic terms such as "controller".
  // Preserve alphabetical order within each tier and include each product once.
  return {
    products: [...explicitProducts, ...keywordProducts],
    explicitProducts,
    mentions,
  };
}
