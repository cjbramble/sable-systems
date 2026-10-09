import type { ChatHistoryMessage } from './chat-history.ts';
import type { OrderStatus } from './contracts.ts';
import {
  itemReferences,
  parseSupportReferences,
  type ReferenceOccurrence,
  type SupportRecordReference,
} from './support-references.ts';
import {
  isCatalogCategory,
  type CatalogCategory,
} from './catalog-categories.ts';

export type SupportOrderStatus = OrderStatus | 'active';

export type SupportQueryIntent =
  | SupportRecordReference
  | {
      kind: 'clarification';
      entity: 'order' | 'shipment' | 'return' | 'record';
      reason: 'multiple_targets' | 'missing_target';
    }
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

function classifyCurrentTopic(latest: string): SupportQueryIntent {
  const normalized = latest.toLowerCase();
  const items = itemReferences(latest);
  const category = requestedCategory(normalized);
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

type RecordKind = SupportRecordReference['kind'];
type ClarificationIntent = Extract<
  SupportQueryIntent,
  { kind: 'clarification' }
>;
type Target = { references: SupportRecordReference[]; items: string[] };
type ConversationFrame = {
  active?: Target | ClarificationIntent;
  customer: Partial<Record<RecordKind, SupportRecordReference[]>>;
  assistant: Partial<Record<RecordKind, SupportRecordReference[]>>;
  assistantActive?: Target;
};

function emptyFrame(): ConversationFrame {
  return { customer: {}, assistant: {} };
}

function uniqueReferences(occurrences: ReferenceOccurrence[]) {
  const references: SupportRecordReference[] = [];
  for (const { reference } of occurrences)
    if (
      !references.some(
        (existing) =>
          existing.kind === reference.kind &&
          existing.namespace === reference.namespace &&
          existing.identifier === reference.identifier,
      )
    )
      references.push(reference);
  return references;
}

function rememberCustomer(frame: ConversationFrame, target: Target) {
  frame.active = target;
  for (const kind of ['order', 'shipment', 'return'] as const) {
    const references = target.references.filter(
      (reference) => reference.kind === kind,
    );
    if (references.length) frame.customer[kind] = references;
  }
}

function referenceEntity(
  references: SupportRecordReference[],
): RecordKind | 'record' {
  const kinds = new Set(references.map((reference) => reference.kind));
  return kinds.size === 1 ? references[0].kind : 'record';
}

function clarify(
  frame: ConversationFrame,
  entity: ClarificationIntent['entity'],
  reason: ClarificationIntent['reason'],
): ClarificationIntent {
  const clarification = { kind: 'clarification' as const, entity, reason };
  frame.active = clarification;
  return clarification;
}

function resolveFollowUp(
  latest: string,
  frame: ConversationFrame,
  entity?: RecordKind,
): SupportQueryIntent {
  const target = entity
    ? {
        references: frame.customer[entity] ?? frame.assistant[entity] ?? [],
        items: [],
      }
    : (frame.active ?? frame.assistantActive ?? { references: [], items: [] });
  if ('kind' in target) return target;
  if (
    target.references.length > 1 ||
    (target.references.length && target.items.length)
  )
    return clarify(
      frame,
      entity ?? referenceEntity(target.references),
      'multiple_targets',
    );
  const reference = target.references[0];
  if (reference) {
    rememberCustomer(frame, { references: [reference], items: [] });
    return reference;
  }
  if (target.items.length) {
    rememberCustomer(frame, target);
    return classifyCurrentTopic(`${latest} ${target.items.join(' ')}`);
  }
  return clarify(frame, entity ?? 'record', 'missing_target');
}

// Replay the bounded saved window. Assistant mentions provide entity-specific
// fallbacks but never replace the customer's active target. New explicit topics
// reset the frame; resolved follow-ups keep related targets within that frame.
export function classifySupportQuery(
  messages: ChatHistoryMessage[],
): SupportQueryIntent {
  let frame = emptyFrame();
  let intent: SupportQueryIntent = { kind: 'summary', message: '' };
  for (const message of messages) {
    const latest = message.content.trim();
    const { occurrences, remainder } = parseSupportReferences(latest);
    const normalized = remainder.toLowerCase();
    const references = uniqueReferences(occurrences);
    const items = itemReferences(remainder);
    if (message.role === 'assistant') {
      for (const kind of ['order', 'shipment', 'return'] as const) {
        const matching = references.filter(
          (reference) => reference.kind === kind,
        );
        if (matching.length) frame.assistant[kind] = matching;
      }
      if (references.length || items.length)
        frame.assistantActive = { references, items };
      continue;
    }

    const entityCues = [
      ...new Set(
        Array.from(
          normalized.matchAll(
            /\b(?:the|that|this)\s+(order|shipment|return)\b/g,
          ),
          ([, entity]) => entity as RecordKind,
        ),
      ),
    ];
    const followUp =
      entityCues.length > 0 ||
      /\b(?:it|its|those|them)\b|\b(?:about|for) that\s*[?.!]*$/.test(
        normalized,
      );
    const currentTopic =
      items.length > 0 ||
      requestedCategory(normalized) ||
      /\b(?:orders|purchases?|releases?|incidents?|my account|account tier)\b/.test(
        normalized,
      );
    const current = classifyCurrentTopic(remainder);
    if (
      references.length ||
      currentTopic ||
      (!followUp && current.kind !== 'summary')
    ) {
      frame = emptyFrame();
      rememberCustomer(frame, { references, items });
      intent = references[0] ?? current;
    } else if (followUp) {
      intent =
        entityCues.length > 1
          ? clarify(frame, 'record', 'multiple_targets')
          : resolveFollowUp(remainder, frame, entityCues[0]);
    } else intent = current;
  }
  return intent;
}

// Explicit records retain appearance order and namespace, including two labels
// with the same value. The existing three-part retrieval budget stays unchanged.
export function classifySupportQueries(
  messages: ChatHistoryMessage[],
): SupportQueryIntent[] {
  const primary = classifySupportQuery(messages);
  const latest = messages.at(-1)?.content.trim() ?? '';
  const { occurrences, remainder } = parseSupportReferences(latest);
  const records = uniqueReferences(occurrences);
  if (!records.length) return [primary];
  const intents: SupportQueryIntent[] = [...records];
  const rest = classifyCurrentTopic(remainder);
  if (rest.kind === 'catalog') intents.push(rest);
  return intents.length > 1
    ? intents.slice(0, MAX_COMPOUND_REQUESTS)
    : [primary];
}
