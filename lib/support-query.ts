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
import { findProductMentions, type ProductTerms } from './product-mentions.ts';

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
      // Dates, months, and year ranges the single-year search can't express.
      unsupportedDate?: true;
    }
  | { kind: 'incidents' }
  | { kind: 'account' }
  | {
      kind: 'catalog';
      message: string;
      category?: CatalogCategory;
      quantities: QuantityOccurrence[];
      includeLocations: boolean;
      compare: boolean;
    }
  | { kind: 'summary'; message: string };

const INCIDENT_TOPIC_SOURCE =
  '(?:(?:support|service)\\s+incidents?|incident\\s+(?:history|records?)|past\\s+incidents?)';
const INCIDENT_TOPIC = new RegExp(`\\b${INCIDENT_TOPIC_SOURCE}\\b`, 'i');

// Category names are everyday words ("a power outage", "a security review"),
// so they name a category only beside a catalog noun or in a stock question.
const CATEGORY_NOUN =
  /^\s+(?:products?|items?|category|categories|catalog|line|lineup|range|gear|parts|hardware|equipment|stock|inventory|offerings?|availability)\b/;
const CATEGORY_LABEL = /\b(?:category|catalog)\s+(?:of\s+|for\s+)?$/;
const STOCK_CUE =
  /\b(?:(?:you|we)\s+(?:sell|carry|offer|stock)|for\s+sale|(?:can|could)\s+i\s+(?:buy|purchase)|in\s+stock|stock(?:ed)?|inventory|catalog|availability|available|backorder(?:ed)?|products?|prices?|pricing|lead[ -]times?|case[ -]packs?)\b/;

function requestedCategory(message: string) {
  const stockQuestion = STOCK_CUE.test(message);
  for (const match of message.matchAll(/[a-z]+/g)) {
    const [word] = match;
    const titleCase = `${word[0].toUpperCase()}${word.slice(1)}`;
    if (!isCatalogCategory(titleCase)) continue;
    const before = message.slice(0, match.index);
    const after = message.slice(match.index + word.length);
    if (
      stockQuestion ||
      CATEGORY_NOUN.test(after) ||
      CATEGORY_LABEL.test(before)
    )
      return titleCase;
  }
  return undefined;
}

// Generic stock words also describe records: "my invoice is available",
// "the warehouse my order shipped from". Beside a record noun they need a
// product, item, or category to make the question a catalog request.
const GENERIC_CATALOG_WORDS =
  /\b(?:item|available|availability|warehouse|fulfillment location)\b/;
const STRONG_CATALOG_WORDS =
  /\b(?:product|catalog|inventory|stock|backorder|compare|versus|vs\.?|where stocked)\b/;
const RECORD_NOUN =
  /\b(?:orders?|shipments?|returns?|invoices?|packages?|tracking|incidents?|account|payments?|refunds?|credits?)\b/;

const AMOUNT_BEFORE =
  /(?:\$\s*|\b(?:over|under|above|below|exceeding|(?:more|less|greater|fewer)\s+than|at\s+(?:least|most))\s+\$?\s*)$/;
// Only a unit or currency directly after the number (optionally "more" or
// "additional") makes it an amount; "2024 in USD" still names a year.
const AMOUNT_AFTER =
  /^\s*(?:(?:more|additional|extra|total)\s+)?(?:units?|licenses?|controllers?|arrays?|modules?|hubs?|nodes?|packs?|cells?|items?|cases?|seats?|kits?|dollars?|usd|cents?|%)\b/;
const MONTH_SOURCE =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// "March 2026", "September 15, 2026", "15 September 2026", "2026 March".
const MONTH_BEFORE_YEAR = new RegExp(
  `\\b${MONTH_SOURCE}\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?,?\\s*$|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_SOURCE}\\.?,?\\s*$`,
);
const MONTH_AFTER_YEAR = new RegExp(`^[\\s,]*${MONTH_SOURCE}\\b`);
// A month or relative date named without a year. "May" or "March" alone can
// be a verb, so a standalone month needs a date preposition or a day number.
const DATE_WITHOUT_YEAR = new RegExp(
  `\\b(?:in|from|during|since|until|till|before|after|for|of|by)\\s+(?:early\\s+|late\\s+|mid-?)?${MONTH_SOURCE}\\b|\\b${MONTH_SOURCE}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b(?:today|yesterday|tomorrow)\\b|\\b(?:this|last|next|past|previous)\\s+(?:\\d+\\s+)?(?:days?|weeks?|months?|quarters?|years?)\\b`,
);
const RANGE_WORD =
  /\b(?:between|before|after|since|until|till|through|prior\s+to)\s+(?:\w+\s+){0,2}$/;

// Order search filters by one whole year. Money and quantities are not years,
// and anything narrower or wider than one year asks for clarification.
function parseYearFilter(
  normalized: string,
): { kind: 'none' } | { kind: 'year'; year: number } | { kind: 'unsupported' } {
  const years = new Set<number>();
  for (const match of normalized.matchAll(
    /(?<![\d.,])\b(20\d{2})\b(?![.,]?\d)/g,
  )) {
    const before = normalized.slice(0, match.index);
    const after = normalized.slice(match.index + match[0].length);
    if (AMOUNT_BEFORE.test(before) || AMOUNT_AFTER.test(after)) continue;
    if (
      /^[-/]\d{1,2}\b/.test(after) ||
      /\b\d{1,2}[-/]$/.test(before) ||
      MONTH_BEFORE_YEAR.test(before) ||
      MONTH_AFTER_YEAR.test(after) ||
      RANGE_WORD.test(before)
    )
      return { kind: 'unsupported' };
    years.add(Number(match[1]));
  }
  if (years.size > 1 || DATE_WITHOUT_YEAR.test(normalized))
    return { kind: 'unsupported' };
  const [year] = years;
  return year === undefined ? { kind: 'none' } : { kind: 'year', year };
}

// `namesRecord` says the caller removed a named record from `latest`; that
// record owns its noun, so the rest of the message can still ask about stock.
function classifyCurrentTopic(
  latest: string,
  namesRecord = false,
): SupportQueryIntent {
  const normalized = latest.toLowerCase();
  const items = itemReferences(latest);
  const category = requestedCategory(normalized);
  const asksAboutAccount =
    /\b(charge|billing|authorization|payment|terms|currency|account tier|region)\b/.test(
      normalized,
    );
  if (asksAboutAccount && items.length === 0 && !category)
    return { kind: 'account' };

  const dateFilter = parseYearFilter(normalized);
  const year = dateFilter.kind === 'year' ? dateFilter.year : undefined;
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
      ...(dateFilter.kind === 'unsupported'
        ? { unsupportedDate: true as const }
        : {}),
    };
  }

  if (INCIDENT_TOPIC.test(normalized)) return { kind: 'incidents' };

  const quantities = parseQuantityOccurrences(normalized);
  if (
    items.length > 0 ||
    quantities.length > 0 ||
    category ||
    STRONG_CATALOG_WORDS.test(normalized) ||
    (GENERIC_CATALOG_WORDS.test(normalized) &&
      (namesRecord || !RECORD_NOUN.test(normalized)))
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
  `(?:[;.!?]\\s*|\\b(?:and|also)\\s+)(?=(?:${ORDER_SEARCH_REQUEST_SOURCE}|${TOPIC_REQUEST_SOURCE}|(?:my|our)\\s+(?:account|payment|billing|orders|purchases?|releases?|${INCIDENT_TOPIC_SOURCE})\\b|${INCIDENT_TOPIC_SOURCE}\\b|(?:please\\s+)?(?:orders?|purchases?|releases?|shipments?|returns?|customer\\s+po)\\b))`,
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

// An empty target leaves the assistant's mentions available as fallbacks.
function rememberCustomer(frame: ConversationFrame, target: Target) {
  frame.active =
    target.references.length || target.items.length ? target : undefined;
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
// `products` supplies the names and aliases that name a product without its
// item number; the frame records those products as items.
export function classifySupportQuery(
  messages: ChatHistoryMessage[],
  products: readonly ProductTerms[] = [],
): SupportQueryIntent {
  let frame = emptyFrame();
  let intent: SupportQueryIntent = { kind: 'summary', message: '' };
  for (const message of messages) {
    const latest = message.content.trim();
    const { occurrences, remainder } = parseSupportReferences(latest);
    const normalized = remainder.toLowerCase();
    const references = uniqueReferences(occurrences);
    const numberedItems = itemReferences(remainder);
    if (message.role === 'assistant') {
      for (const kind of ['order', 'shipment', 'return'] as const) {
        const matching = references.filter(
          (reference) => reference.kind === kind,
        );
        if (matching.length) frame.assistant[kind] = matching;
      }
      // Product names in a reply about records describe their lines.
      const items = references.length
        ? numberedItems
        : [
            ...numberedItems,
            ...mentionedProducts(normalized, products).filter(
              (item) => !numberedItems.includes(item),
            ),
          ];
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
    // A product name can describe a line on the record under discussion
    // ("the controller on that order", "was it shipped with the controller?");
    // with a record cue, or a pronoun outside a catalog question, it does not
    // replace that record.
    const recordTarget = [frame.active, frame.assistantActive].some(
      (target) => target && !('kind' in target) && target.references.length,
    );
    const named =
      entityCues.length ||
      (recordTarget && followUp && current.kind !== 'catalog')
        ? []
        : mentionedProducts(normalized, products).filter(
            (item) => !numberedItems.includes(item),
          );
    const items = [...numberedItems, ...named];
    // A category word with a record cue or pronoun describes that record.
    const currentTopic =
      items.length > 0 ||
      (!followUp && requestedCategory(normalized)) ||
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
      // Products filter an order search; the orders it finds are the targets.
      rememberCustomer(frame, {
        references,
        items: current.kind === 'orders' ? [] : items,
      });
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

function mentionedProducts(
  normalized: string,
  products: readonly ProductTerms[],
): string[] {
  if (!products.length) return [];
  const { explicitProducts, keywordProducts } = findProductMentions(
    normalized,
    products,
    parseQuantityOccurrences(normalized),
  );
  return [...explicitProducts, ...keywordProducts].map(
    (product) => product.item_number,
  );
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
  // Split shared topic/catalog requests without detaching product filters
  // or separating a quantity from its catalog target.
  for (const [index, start] of starts.entries()) {
    const end = ends[index];
    const clause = remainder.slice(start, end);
    if (classifyCurrentTopic(clause).kind === 'orders') continue;
    for (const match of clause.matchAll(/\b(?:and|also)\s+/gi)) {
      const left = clause.slice(0, match.index);
      const right = clause.slice(match.index + match[0].length);
      const leftKind = classifyCurrentTopic(left).kind;
      const rightTopic = classifyCurrentTopic(right);
      const separateCatalogSubject =
        rightTopic.kind === 'catalog' &&
        (itemReferences(right).length > 0 ||
          rightTopic.category !== undefined) &&
        (rightTopic.compare ||
          /\b(?:availability|available|stock|inventory|backorder|prices?|pricing|lead[ -]times?|case[ -]packs?)\b/i.test(
            right,
          ));
      // Bare products and stock terms can describe incidents; a separate target
      // with requested catalog facts is independent of an earlier qualifier.
      if (
        leftKind === 'incidents' &&
        !separateCatalogSubject &&
        /\b(?:about|for|regarding|containing|involving|with|on|related to)\b/i.test(
          left,
        )
      )
        continue;
      if (
        !['account', 'incidents'].includes(leftKind) ||
        rightTopic.kind !== 'catalog'
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
  products: readonly ProductTerms[] = [],
): SupportQueryIntent[] {
  const primary = classifySupportQuery(messages, products);
  const latest = messages.at(-1)?.content.trim() ?? '';
  const { occurrences, remainder } = parseSupportReferences(latest);
  const records = uniqueReferences(occurrences);
  if (!records.length && primary.kind === 'clarification') return [primary];
  const priorMessages = messages.slice(0, -1);
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
    const request = classifyCurrentTopic(clause, hasRecord);
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
    // Resolve each eligible clause independently; another topic must not
    // replace its saved target or suppress a clarification.
    if (
      !hasRecord &&
      TOPIC_REQUEST.test(clause) &&
      (request.kind !== 'account' || recordContinuation)
    ) {
      const preceding = latest.slice(0, start);
      const precedingTargets = parseSupportReferences(preceding);
      const hasPrecedingTarget =
        precedingTargets.occurrences.length > 0 ||
        itemReferences(precedingTargets.remainder).length > 0 ||
        mentionedProducts(precedingTargets.remainder.toLowerCase(), products)
          .length > 0;
      const resolved = classifySupportQuery(
        [
          ...priorMessages,
          ...(hasPrecedingTarget
            ? [{ role: 'user' as const, content: preceding }]
            : []),
          { role: 'user', content: clause },
        ],
        products,
      );
      if (resolved.kind === 'clarification') {
        requests.push({ intent: resolved, start });
        catalogCharacters.fill(' ', start, end);
        continue;
      }
      if ('identifier' in resolved) {
        if (
          !requests.some(
            ({ intent }) =>
              'identifier' in intent &&
              intent.kind === resolved.kind &&
              intent.namespace === resolved.namespace &&
              intent.identifier === resolved.identifier,
          )
        )
          requests.push({ intent: resolved, start });
        catalogCharacters.fill(' ', start, end);
        continue;
      }
    }
    if (request.kind === 'catalog') {
      catalogStart ??= catalogSubjectStart(remainder, occurrences, start, end);
    }
    if (hasRecord || (request.kind === 'account' && recordContinuation))
      continue;
    const accountRequested = request.kind === 'account' && topicRequested;
    const incidentsRequested = request.kind === 'incidents' && topicRequested;
    const ordersRequested = request.kind === 'orders' && searchRequested;
    if (!accountRequested && !incidentsRequested && !ordersRequested) continue;
    if (
      (!accountRequested && !incidentsRequested) ||
      !requests.some(({ intent }) => intent.kind === request.kind)
    )
      requests.push({ intent: request, start });
    catalogCharacters.fill(' ', start, end);
  }
  const catalogMessage = catalogCharacters.join('');
  const catalog = records.length
    ? classifyCurrentTopic(catalogMessage, true)
    : classifySupportQuery(
        [...priorMessages, { role: 'user', content: catalogMessage }],
        products,
      );
  if (
    catalogStart !== undefined &&
    (catalog.kind === 'catalog' || catalog.kind === 'clarification')
  )
    requests.push({ intent: catalog, start: catalogStart });
  return requests.length > 1
    ? requests
        .sort((left, right) => left.start - right.start)
        .map(({ intent }) => intent)
    : [primary];
}
