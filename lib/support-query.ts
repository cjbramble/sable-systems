import type { ChatHistoryMessage } from './chat-history.ts';
import type { OrderStatus } from './contracts.ts';
import {
  explicitCustomerPos,
  explicitOrderPo,
  itemReferences,
  referenceTokens,
} from './support-references.ts';
import {
  isCatalogCategory,
  type CatalogCategory,
} from './catalog-categories.ts';

export type SupportOrderStatus = OrderStatus | 'active';

export type SupportQueryIntent =
  | { kind: 'order'; identifier: string }
  | { kind: 'shipment'; identifier: string }
  | { kind: 'return'; identifier: string }
  | {
      kind: 'orders';
      message: string;
      status?: SupportOrderStatus;
      year?: number;
      yearField?: 'created' | 'requested';
    }
  | { kind: 'incidents' }
  | { kind: 'account'; includeCharges: boolean }
  | {
      kind: 'catalog';
      message: string;
      category?: CatalogCategory;
      quantity?: number;
      includeLocations: boolean;
      compare: boolean;
    }
  | { kind: 'summary'; message: string };

const ORDER_PATTERN =
  /^(?:SBL-\d{4}-[A-Z0-9-]+|[A-Z]{3}-(?:PO|REL)-[A-Z0-9-]+)$/i;
const SHIPMENT_PATTERN = /^(?:SHP|AST)-[A-Z0-9-]+$/i;
const RETURN_PATTERN = /^RTN-[A-Z0-9-]+$/i;

function identifierFrom(message: string) {
  const tokens = referenceTokens(message);
  const returnIdentifier = tokens.find((token) => RETURN_PATTERN.test(token));
  if (returnIdentifier)
    return {
      kind: 'return' as const,
      identifier: returnIdentifier.toUpperCase(),
    };
  const shipmentIdentifier = tokens.find((token) =>
    SHIPMENT_PATTERN.test(token),
  );
  if (shipmentIdentifier)
    return {
      kind: 'shipment' as const,
      identifier: shipmentIdentifier.toUpperCase(),
    };
  const orderIdentifier =
    explicitOrderPo(message) ??
    tokens.find((token) => ORDER_PATTERN.test(token));
  if (orderIdentifier)
    return {
      kind: 'order' as const,
      identifier: orderIdentifier.toUpperCase(),
    };
  return null;
}

function orderStatus(message: string): SupportOrderStatus | undefined {
  if (/\bpart(?:ial|ially)[ -]shipped\b/.test(message))
    return 'partially_shipped';
  if (/\bon[ -]hold\b/.test(message)) return 'on_hold';
  if (/\bbackorder(?:ed)?\b/.test(message)) return 'backordered';
  if (/\bcancel(?:led|ed)?\b/.test(message)) return 'cancelled';
  if (/\bdeliver(?:ed|ies|y)?\b/.test(message)) return 'delivered';
  if (/\bshipped\b/.test(message)) return 'shipped';
  if (/\ballocat(?:ing|ion)\b/.test(message)) return 'allocating';
  if (/\bconfirm(?:ed|ation)?\b/.test(message)) return 'confirmed';
  if (/\bschedul(?:ed|e)\b|\bfuture\b|\bupcoming\b/.test(message))
    return 'scheduled';
  if (/\bactive\b|\bopen orders?\b/.test(message)) return 'active';
  return undefined;
}

function requestedCategory(message: string) {
  for (const word of message.match(/[a-z]+/g) ?? []) {
    const titleCase = `${word[0].toUpperCase()}${word.slice(1)}`;
    if (isCatalogCategory(titleCase)) return titleCase;
  }
  return undefined;
}

export function classifySupportQuery(
  messages: ChatHistoryMessage[],
): SupportQueryIntent {
  const latest = messages.at(-1)?.content.trim() ?? '';
  const normalized = latest.toLowerCase();
  const explicitIdentifier = identifierFrom(latest);
  if (explicitIdentifier) return explicitIdentifier;

  const items = itemReferences(latest);
  const category = requestedCategory(normalized);
  const currentTopic =
    items.length > 0 ||
    category ||
    /\b(?:orders|purchases?|releases?|incidents?|my account|account tier)\b/.test(
      normalized,
    );
  // Explicit current targets outrank follow-ups. Bare "this" (for example,
  // "this warehouse") does not refer back to an earlier order.
  if (
    !currentTopic &&
    /\b(?:it|its|those|them)\b|\b(?:the|that|this) (?:order|shipment|return)\b|\b(?:about|for) that\s*[?.!]*$/.test(
      normalized,
    )
  ) {
    let assistantItems: string[] | undefined;
    for (const message of messages.slice(0, -1).toReversed()) {
      const previousIdentifier = identifierFrom(message.content);
      if (previousIdentifier) return previousIdentifier;
      const previousItems = itemReferences(message.content);
      if (!previousItems.length) continue;
      // Line-item SKUs in a reply must not displace the customer's order.
      // Retain them as a fallback when no explicit conversation target exists.
      if (message.role === 'assistant') assistantItems ??= previousItems;
      else
        return classifySupportQuery([
          { role: 'user', content: `${latest} ${previousItems.join(' ')}` },
        ]);
    }
    if (assistantItems)
      return classifySupportQuery([
        { role: 'user', content: `${latest} ${assistantItems.join(' ')}` },
      ]);
  }

  const includeCharges =
    /\b(charge|billing|authorization|payment|terms|currency|account tier|region)\b/.test(
      normalized,
    );
  if (includeCharges && items.length === 0 && !category)
    return { kind: 'account', includeCharges: true };

  const status = orderStatus(normalized);
  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  if (/\b(orders|purchases?|releases?)\b/.test(normalized)) {
    return {
      kind: 'orders',
      message: normalized,
      status,
      year,
      yearField:
        year && (status === 'scheduled' || /\breleases?\b/.test(normalized))
          ? 'requested'
          : year
            ? 'created'
            : undefined,
    };
  }

  if (
    /\b(?:support|service) incidents?\b|\bincident (?:history|records?)\b|\bpast incidents?\b/.test(
      normalized,
    )
  )
    return { kind: 'incidents' };

  // A quantity must start outside a word or hyphenated item number. A word
  // boundary alone also matches the "12" in "SBL-RPC-12 units".
  const quantityMatch = normalized.match(
    /(?<![\w-])(\d{1,6})(?!\s*(?:tb|gb|mb|kb|m)\b)(?:\s+[a-z-]+){0,2}\s+(?:units?|licenses?|controllers?|arrays?|modules?|hubs?|nodes?|packs?)\b/,
  );
  if (
    items.length > 0 ||
    category ||
    /\b(product|item|catalog|inventory|availability|available|stock|backorder|compare|versus|vs\.?|where stocked|warehouse|fulfillment location)\b/.test(
      normalized,
    )
  ) {
    return {
      kind: 'catalog',
      message: normalized,
      category,
      quantity: quantityMatch ? Number(quantityMatch[1]) : undefined,
      includeLocations: /\b(where|location|warehouse|stocked|region)\b/.test(
        normalized,
      ),
      compare: /\b(compare|versus|vs\.?)\b/.test(normalized),
    };
  }

  return { kind: 'summary', message: normalized };
}

const MAX_COMPOUND_REQUESTS = 3;

type RecordIntent = Extract<
  SupportQueryIntent,
  { kind: 'order' | 'shipment' | 'return' }
>;

// Every explicit order, shipment or return reference, in order of appearance.
function recordIdentifiers(message: string): RecordIntent[] {
  const records: RecordIntent[] = [];
  const add = (kind: RecordIntent['kind'], identifier: string) => {
    const normalized = identifier.toUpperCase();
    if (!records.some((record) => record.identifier === normalized))
      records.push({ kind, identifier: normalized });
  };
  for (const token of referenceTokens(message)) {
    if (RETURN_PATTERN.test(token)) add('return', token);
    else if (SHIPMENT_PATTERN.test(token)) add('shipment', token);
    else if (ORDER_PATTERN.test(token)) add('order', token);
  }
  for (const po of explicitCustomerPos(message)) add('order', po);
  return records;
}

// A question that names more than one record, or a record and a product, gets
// one intent per part (up to three) so each part is retrieved. Everything else,
// including follow-ups, keeps the single intent from classifySupportQuery.
export function classifySupportQueries(
  messages: ChatHistoryMessage[],
): SupportQueryIntent[] {
  const primary = classifySupportQuery(messages);
  const latest = messages.at(-1)?.content.trim() ?? '';
  const records = recordIdentifiers(latest);
  if (!records.length) return [primary];
  const intents: SupportQueryIntent[] = [...records];
  const remainder = records.reduce(
    (text, record) =>
      text.replace(
        new RegExp(record.identifier.replace(/[-]/g, '\\-'), 'gi'),
        ' ',
      ),
    latest,
  );
  const rest = classifySupportQuery([{ role: 'user', content: remainder }]);
  if (rest.kind === 'catalog') intents.push(rest);
  return intents.length > 1
    ? intents.slice(0, MAX_COMPOUND_REQUESTS)
    : [primary];
}
