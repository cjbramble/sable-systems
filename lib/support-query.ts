import type { ChatHistoryMessage } from './chat-history.ts';
import {
  matchingOrderStatuses,
  parseOrderStatusFilter,
  type SupportOrderStatusFilter,
} from './support-order-status.ts';
import {
  parseQuantityOccurrences,
  type QuantityOccurrence,
} from './support-quantities.ts';
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
      statusFilter?: SupportOrderStatusFilter;
      year?: number;
      yearField?: 'created' | 'requested';
    }
  | { kind: 'incidents' }
  | { kind: 'account'; includeCharges: boolean }
  | {
      kind: 'catalog';
      message: string;
      category?: CatalogCategory;
      quantities: QuantityOccurrence[];
      includeLocations: boolean;
      compare: boolean;
    }
  | { kind: 'summary'; message: string };

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

  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  if (/\b(orders|purchases?|releases?)\b/.test(normalized)) {
    const statusFilter = parseOrderStatusFilter(normalized);
    const includedStatuses =
      statusFilter?.kind === 'filter' && statusFilter.include.length
        ? matchingOrderStatuses({ ...statusFilter, exclude: [] })
        : [];
    const scheduledOnly =
      includedStatuses.length === 1 && includedStatuses[0] === 'scheduled';
    return {
      kind: 'orders',
      message: normalized,
      statusFilter,
      year,
      yearField:
        year && (scheduledOnly || /\breleases?\b/.test(normalized))
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

  const quantities = parseQuantityOccurrences(normalized);
  if (
    items.length > 0 ||
    quantities.length > 0 ||
    category ||
    /\b(product|item|catalog|inventory|availability|available|stock|backorder|compare|versus|vs\.?|where stocked|warehouse|fulfillment location)\b/.test(
      normalized,
    )
  ) {
    return {
      kind: 'catalog',
      message: normalized,
      category,
      quantities,
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
type NamespaceAnswer =
  | { kind: 'order'; namespace: 'order_id' | 'customer_po' }
  | { kind: 'shipment'; namespace: 'shipment_id' | 'tracking_reference' };
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

// Only a complete affirmative answer chooses a namespace. Questions, negation,
// and alternatives such as "order ID or customer PO" keep their usual meaning.
function namespaceAnswer(message: string): NamespaceAnswer | undefined {
  const label = message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .match(
      /^(?:(?:it['’]s|it is) )?(?:(?:the|a|an) )?(order (?:id|number)|customer po(?: number)?|shipment (?:id|number)|tracking (?:reference|number))\s*[.!]?$/,
    )?.[1];
  if (label === 'order id' || label === 'order number')
    return { kind: 'order', namespace: 'order_id' };
  if (label === 'customer po' || label === 'customer po number')
    return { kind: 'order', namespace: 'customer_po' };
  if (label === 'shipment id' || label === 'shipment number')
    return { kind: 'shipment', namespace: 'shipment_id' };
  if (label === 'tracking reference' || label === 'tracking number')
    return { kind: 'shipment', namespace: 'tracking_reference' };
  return undefined;
}

function refineNamespace(
  frame: ConversationFrame,
  answer: NamespaceAnswer,
): SupportQueryIntent {
  // A field choice cannot supply a missing identifier or choose between records.
  if (frame.active && 'kind' in frame.active) return frame.active;
  const candidates = frame.customer[answer.kind] ?? [];
  if (candidates.length !== 1)
    return clarify(
      frame,
      answer.kind,
      candidates.length ? 'multiple_targets' : 'missing_target',
    );
  const previous = candidates[0];
  const reference: SupportRecordReference =
    previous.namespace === 'unresolved'
      ? { ...answer, identifier: previous.identifier }
      : previous;
  rememberCustomer(frame, { references: [reference], items: [] });
  return reference;
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
    const current = classifyCurrentTopic(remainder);
    const followUp =
      entityCues.length > 0 ||
      (current.kind === 'catalog' &&
        current.quantities.length > 0 &&
        /\beach\b/.test(normalized)) ||
      /\b(?:it|its|those|them|both)\b|\b(?:about|for) that\s*[?.!]*$/.test(
        normalized,
      );
    const currentTopic =
      items.length > 0 ||
      requestedCategory(normalized) ||
      /\b(?:orders|purchases?|releases?|incidents?|my account|account tier)\b/.test(
        normalized,
      );
    const answer = namespaceAnswer(latest);
    if (
      references.length ||
      currentTopic ||
      (!followUp && current.kind !== 'summary')
    ) {
      frame = emptyFrame();
      rememberCustomer(frame, { references, items });
      intent = references[0] ?? current;
    } else if (answer) {
      intent = refineNamespace(frame, answer);
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
  // Split only at a new request or record label. Preserve source spans so a
  // description of named records cannot become a broad search after masking.
  // Other continuations stay attached, including unsupported negative clauses.
  const boundaries = Array.from(
    latest.matchAll(
      /(?:[;.!?]\s*|\b(?:and|also)\s+)(?=(?:please\s+)?(?:show|list|find|count|orders?|purchases?|releases?|shipments?|returns?|customer\s+po)\b)/gi,
    ),
    (match) => ({ start: match.index, end: match.index + match[0].length }),
  );
  const starts = [0, ...boundaries.map((boundary) => boundary.end)];
  const ends = [...boundaries.map((boundary) => boundary.start), latest.length];
  for (const [index, start] of starts.entries()) {
    const end = ends[index];
    if (
      occurrences.some(
        (reference) => reference.start < end && reference.end > start,
      )
    )
      continue;
    const request = classifyCurrentTopic(remainder.slice(start, end));
    if (request.kind === 'orders' && request.statusFilter)
      intents.push(request);
  }
  return intents.length > 1
    ? intents.slice(0, MAX_COMPOUND_REQUESTS)
    : [primary];
}
