import type { ChatHistoryMessage } from './chat-history.ts';
import {
  isCatalogCategory,
  type CatalogCategory,
} from './catalog-categories.ts';

export type SupportOrderStatus =
  | 'active'
  | 'allocating'
  | 'backordered'
  | 'cancelled'
  | 'confirmed'
  | 'delivered'
  | 'on_hold'
  | 'partially_shipped'
  | 'scheduled'
  | 'shipped';

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

const ORDER_PATTERN = /\b(?:SBL-\d{4}-\d{6}|[A-Z]{3}-(?:PO|REL)-\d{6})\b/i;
const SHIPMENT_PATTERN = /\b(?:SHP-\d{4}-\d{6}|AST-\d{10})\b/i;
const RETURN_PATTERN = /\bRTN-\d{4}-\d{6}\b/i;

function identifierFrom(message: string) {
  const returnIdentifier = message.match(RETURN_PATTERN)?.[0];
  if (returnIdentifier)
    return { kind: 'return' as const, identifier: returnIdentifier.toUpperCase() };
  const shipmentIdentifier = message.match(SHIPMENT_PATTERN)?.[0];
  if (shipmentIdentifier)
    return {
      kind: 'shipment' as const,
      identifier: shipmentIdentifier.toUpperCase(),
    };
  const orderIdentifier = message.match(ORDER_PATTERN)?.[0];
  if (orderIdentifier)
    return { kind: 'order' as const, identifier: orderIdentifier.toUpperCase() };
  return null;
}

function orderStatus(message: string): SupportOrderStatus | undefined {
  if (/\bpart(?:ial|ially)[ -]shipped\b/.test(message))
    return 'partially_shipped';
  if (/\bon[ -]hold\b/.test(message)) return 'on_hold';
  if (/\bbackorder(?:ed)?\b/.test(message)) return 'backordered';
  if (/\bcancel(?:led|ed)?\b/.test(message)) return 'cancelled';
  if (/\bdeliver(?:ed|ies|y)?\b/.test(message)) return 'delivered';
  if (/\bship(?:ped|ment)?\b/.test(message)) return 'shipped';
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

  if (/\b(it|that|this|those|them|its)\b|\bthe (?:order|shipment|return)\b/.test(normalized)) {
    for (const message of messages.slice(0, -1).toReversed()) {
      const previousIdentifier = identifierFrom(message.content);
      if (previousIdentifier) return previousIdentifier;
    }
  }

  const includeCharges =
    /\b(charge|billing|authorization|payment|terms|currency|account tier|region)\b/.test(
      normalized,
    );
  if (includeCharges) return { kind: 'account', includeCharges: true };

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

  const category = requestedCategory(normalized);
  const quantityMatch = normalized.match(
    /\b(\d{1,6})(?:\s+[a-z-]+){0,2}\s+(?:units?|licenses?|controllers?|arrays?|modules?|hubs?|nodes?|packs?)\b/,
  );
  if (
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
      includeLocations:
        /\b(where|location|warehouse|stocked|region)\b/.test(normalized),
      compare: /\b(compare|versus|vs\.?)\b/.test(normalized),
    };
  }

  return { kind: 'summary', message: normalized };
}
