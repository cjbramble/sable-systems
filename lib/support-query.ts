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

const ORDER_SEARCH_REQUEST_SOURCE =
  '(?:(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?(?:show|list|find|count)\\b|how many\\b)';
const ORDER_SEARCH_REQUEST = new RegExp(`^${ORDER_SEARCH_REQUEST_SOURCE}`, 'i');
const TOPIC_REQUEST_SOURCE =
  '(?:(?:please\\s+)?(?:what|where|when|how|is|are|tell\\s+me|explain)\\b)';
const TOPIC_REQUEST = new RegExp(
  `^(?:${ORDER_SEARCH_REQUEST_SOURCE}|${TOPIC_REQUEST_SOURCE})`,
  'i',
);
const COMPOUND_REQUEST_BOUNDARY = new RegExp(
  `(?:[;.!?]\\s*|\\b(?:and|also)\\s+)(?=(?:${ORDER_SEARCH_REQUEST_SOURCE}|${TOPIC_REQUEST_SOURCE}|(?:my|our)\\s+(?:account|payment|billing)\\b|(?:please\\s+)?(?:orders?|purchases?|releases?|shipments?|returns?|customer\\s+po)\\b))`,
  'gi',
);

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

type RequestBoundary = { start: number; end: number; coordinated: boolean };

function requestBoundaries(
  latest: string,
  remainder: string,
): RequestBoundary[] {
  const boundaries = Array.from(
    latest.matchAll(COMPOUND_REQUEST_BOUNDARY),
    (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      coordinated: /^(?:and|also)\b/i.test(match[0]),
    }),
  );
  const starts = [0, ...boundaries.map(({ end }) => end)];
  const ends = [...boundaries.map(({ start }) => start), latest.length];
  // Split shared account/catalog requests without splitting product lists owned
  // by an order search or separating a quantity from its catalog target.
  for (const [index, start] of starts.entries()) {
    const end = ends[index];
    const clause = remainder.slice(start, end);
    if (classifyCurrentTopic(clause).kind === 'orders') continue;
    for (const match of clause.matchAll(/\b(?:and|also)\s+/gi)) {
      const left = clause.slice(0, match.index);
      const right = clause.slice(match.index + match[0].length);
      if (
        classifyCurrentTopic(left).kind !== 'account' ||
        classifyCurrentTopic(right).kind !== 'catalog'
      )
        continue;
      boundaries.push({
        start: start + match.index,
        end: start + match.index + match[0].length,
        coordinated: true,
      });
      break;
    }
  }
  return boundaries.sort((left, right) => left.start - right.start);
}

// Coordinated subjects containing a named record own their descriptive words.
// Only a separate subject can position the catalog part; record-only comparisons
// therefore have no catalog position, regardless of their polite request prefix.
function catalogSubjectStart(
  remainder: string,
  occurrences: ReferenceOccurrence[],
  start: number,
  end: number,
): number | undefined {
  const separators = Array.from(
    remainder
      .slice(start, end)
      .matchAll(
        /\b(?:and|also|with|versus|vs|plus)\b|[;!?]|\.(?!\d)|,(?!\d)/gi,
      ),
  );
  const starts = [
    start,
    ...separators.map((match) => start + match.index + match[0].length),
  ];
  const ends = [...separators.map((match) => start + match.index), end];
  for (const [index, subjectStart] of starts.entries()) {
    const subjectEnd = ends[index];
    if (
      occurrences.some(
        (reference) =>
          reference.start < subjectEnd && reference.end > subjectStart,
      )
    )
      continue;
    const subject = remainder.slice(subjectStart, subjectEnd);
    // A detached request cue or politeness marker is not a product target.
    if (
      /^(?:(?:can|could|would|will)\s+you\s*)?(?:please\s*)?(?:show|list|find|count|compare)?$|^(?:thanks|thank you)$/i.test(
        subject.trim(),
      )
    )
      continue;
    const offset = subject.search(/[a-z0-9]/i);
    if (offset >= 0) return subjectStart + offset;
  }
  return undefined;
}

// Record identity comes from source spans; independent topic requests retain
// their own position instead of being appended after every named record.
export function classifySupportQueries(
  messages: ChatHistoryMessage[],
): SupportQueryIntent[] {
  const primary = classifySupportQuery(messages);
  const latest = messages.at(-1)?.content.trim() ?? '';
  const { occurrences, remainder } = parseSupportReferences(latest);
  const records = uniqueReferences(occurrences);
  if (!records.length) return [primary];
  const requests: { intent: SupportQueryIntent; start: number }[] = records.map(
    (reference) => ({
      intent: reference,
      start: occurrences.find(
        ({ reference: candidate }) => candidate === reference,
      )!.start,
    }),
  );
  // Keep source spans intact when removing separately owned topics, so product
  // quantities and reference labels retain their existing interpretation.
  const catalogCharacters = remainder.split('');
  let catalogStart: number | undefined;
  const boundaries = requestBoundaries(latest, remainder);
  const starts = [0, ...boundaries.map((boundary) => boundary.end)];
  const ends = [...boundaries.map((boundary) => boundary.start), latest.length];
  let searchRequested = false;
  let topicRequested = false;
  for (const [index, start] of starts.entries()) {
    const end = ends[index];
    const clause = remainder.slice(start, end).trim();
    // A coordinated noun phrase can share "show"; a new sentence cannot.
    if (index > 0 && !boundaries[index - 1].coordinated) {
      searchRequested = false;
      topicRequested = false;
    }
    if (TOPIC_REQUEST.test(clause)) {
      searchRequested = ORDER_SEARCH_REQUEST.test(clause);
      topicRequested = true;
    }
    const hasRecord = occurrences.some(
      (reference) => reference.start < end && reference.end > start,
    );
    const request = classifyCurrentTopic(clause);
    if (request.kind === 'catalog') {
      catalogStart ??= catalogSubjectStart(remainder, occurrences, start, end);
    }
    // Explicit account ownership permits later pronouns about that fact.
    // Subjects and prepositional references still tie fields to a named record.
    const accountOwnsPronoun =
      /\b(?:my|our)\s+(?:account|payment|billing|terms|currency|region|charge)\b/i.test(
        clause,
      );
    const recordContinuation =
      /\b(?:for|of|about|on|to|in|from|with)\s+(?:it|them)\b|\b(?:that|this|the|those|these)\s+(?:orders?|shipments?|returns?)\b/i.test(
        clause,
      ) ||
      (!accountOwnsPronoun &&
        /\b(?:its|their)\b|\b(?:is|are|was|were|does|do|has|have|can|will|would|should)\s+(?:it|they)\b/i.test(
          clause,
        ));
    if (hasRecord || (request.kind === 'account' && recordContinuation))
      continue;
    const accountRequested = request.kind === 'account' && topicRequested;
    const ordersRequested =
      request.kind === 'orders' && searchRequested && request.statusFilter;
    if (!accountRequested && !ordersRequested) continue;
    if (
      !accountRequested ||
      !requests.some(({ intent }) => intent.kind === 'account')
    )
      requests.push({ intent: request, start });
    catalogCharacters.fill(' ', start, end);
  }
  const catalog = classifyCurrentTopic(catalogCharacters.join(''));
  if (catalog.kind === 'catalog' && catalogStart !== undefined)
    requests.push({ intent: catalog, start: catalogStart });
  return requests.length > 1
    ? requests
        .sort((left, right) => left.start - right.start)
        .map(({ intent }) => intent)
    : [primary];
}
