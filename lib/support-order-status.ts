import type { OrderStatus } from './contracts.ts';

export type SupportOrderStatus = OrderStatus | 'active';
export type SupportOrderStatusFilter =
  | {
      kind: 'filter';
      include: SupportOrderStatus[];
      exclude: SupportOrderStatus[];
    }
  | { kind: 'clarification'; reason: 'unsupported' | 'contradictory' };

type Filter = Extract<SupportOrderStatusFilter, { kind: 'filter' }>;

const ORDER_STATUSES: OrderStatus[] = [
  'scheduled',
  'confirmed',
  'allocating',
  'backordered',
  'partially_shipped',
  'shipped',
  'delivered',
  'on_hold',
  'cancelled',
];
const INACTIVE_STATUSES = new Set<OrderStatus>([
  'scheduled',
  'delivered',
  'cancelled',
]);

export function matchingOrderStatuses(filter: Filter): OrderStatus[] {
  const matches = (status: OrderStatus, requested: SupportOrderStatus) =>
    requested === 'active'
      ? !INACTIVE_STATUSES.has(status)
      : status === requested;
  return ORDER_STATUSES.filter(
    (status) =>
      (!filter.include.length ||
        filter.include.some((requested) => matches(status, requested))) &&
      !filter.exclude.some((requested) => matches(status, requested)),
  );
}

// Longer phrases come first so "partially shipped" is a single status.
const STATUS_TERMS: [SupportOrderStatus, string][] = [
  ['partially_shipped', 'part(?:ial|ially)[ -]shipped'],
  ['on_hold', 'on[ -]hold'],
  ['backordered', 'backorder(?:ed)?'],
  ['cancelled', 'cancel(?:led|ed)?'],
  ['delivered', 'deliver(?:ed|ies|y)?'],
  ['shipped', 'shipped'],
  ['allocating', 'allocat(?:ing|ion)'],
  ['confirmed', 'confirm(?:ed|ation)?'],
  ['scheduled', 'schedul(?:ed|e)|future|upcoming'],
  ['active', 'active|open'],
];
const STATUS_SOURCE = `(?:${STATUS_TERMS.map(([, term]) => term).join('|')})`;
const STATUS = new RegExp(`^${STATUS_SOURCE}(?![\\w-])`, 'i');
const CONNECTOR_SOURCE = '(?:,\\s*(?:(?:and|or|nor)\\s+)?|(?:and|or|nor)\\s+)';
const CONNECTOR = new RegExp(`^${CONNECTOR_SOURCE}`, 'i');
const STATUS_WORD = new RegExp(`\\b${STATUS_SOURCE}\\b`, 'i');
const ORDER_NOUN = /\b(?:orders|purchases?|releases?)\b/i;
const PREFIX_FILTER = new RegExp(
  `\\b((?:(?:not|neither)\\s+)?${STATUS_SOURCE}(?:\\s*${CONNECTOR_SOURCE}${STATUS_SOURCE})*)\\s*$`,
  'i',
);
const UNSUPPORTED_NEGATION =
  /\b(?:not|never|neither|without|except|excluding|non|no|isn't|aren't|wasn't|weren't)\b/i;
const EXCLUSION = /^(?:excluding|except|without)\s+/i;
const EXPLANATION =
  /^\s*(?:and\s+)?(?:please\s+)?(?:explain|describe|define)\b/i;
const unsupported = (): SupportOrderStatusFilter => ({
  kind: 'clarification',
  reason: 'unsupported',
});

function readStatus(
  value: string,
): { status: SupportOrderStatus; rest: string } | undefined {
  const word = value.match(STATUS)?.[0];
  if (!word) return undefined;
  const status = STATUS_TERMS.find(([, term]) =>
    new RegExp(`^(?:${term})$`, 'i').test(word),
  )?.[0];
  return status
    ? { status, rest: value.slice(word.length).trimStart() }
    : undefined;
}

// Expressions are status lists, one directly negated status, or an explicit
// exclusion list. Unconsumed negation never falls back to a positive keyword.
function readExpression(value: string):
  | {
      operation: 'include' | 'exclude';
      statuses: SupportOrderStatus[];
      rest: string;
    }
  | undefined {
  let rest = value.trim();
  const negative = rest.match(/^(not|neither)\s+/i)?.[1].toLowerCase();
  const exclusion = rest.match(EXCLUSION)?.[0];
  const operation = negative || exclusion ? 'exclude' : 'include';
  if (negative) rest = rest.slice(negative.length).trimStart();
  else if (exclusion) rest = rest.slice(exclusion.length);
  const first = readStatus(rest);
  if (!first) return undefined;
  const statuses = [first.status];
  rest = first.rest;
  while (true) {
    const connector = rest.match(CONNECTOR)?.[0];
    if (!connector) break;
    if (negative === 'not') return undefined;
    if ((negative === 'neither') !== /\bnor\b/i.test(connector))
      return undefined;
    const next = readStatus(rest.slice(connector.length));
    if (!next) return undefined;
    statuses.push(next.status);
    rest = next.rest;
  }
  if (negative === 'neither' && statuses.length < 2) return undefined;
  return { operation, statuses, rest };
}

function addExpression(filter: Filter, value: string): string | undefined {
  const parsed = readExpression(value);
  if (!parsed) return undefined;
  for (const status of parsed.statuses)
    if (!filter[parsed.operation].includes(status))
      filter[parsed.operation].push(status);
  return parsed.rest;
}

function afterOrderNoun(suffix: string): string | undefined {
  const value = suffix.trim();
  if (
    STATUS.test(value) ||
    /^(?:not|neither|excluding|except|without)\b/i.test(value)
  )
    return value;
  const anchor = value.match(
    /\b(?:(?:that|which)\s+(?:(?:are|were|have been)\s+)?|with\s+status(?:es)?(?:\s+(?:of|is|are))?\s+|(excluding|except|without)\b)|^(?:are|were)\s+/i,
  );
  const adjective = value.match(
    /\bwith\s+(?:(?:a|an|the)\s+)?(.+?)\s+status(?:es)?\b/i,
  );
  // Normalize the explicit "with a cancelled status" form through the same
  // expression reader. Unknown labels must not become an unrestricted search.
  if (
    adjective?.index !== undefined &&
    (anchor?.index === undefined || adjective.index < anchor.index)
  )
    return `${adjective[1]} ${value.slice(adjective.index + adjective[0].length)}`.trim();
  if (anchor && anchor.index !== undefined)
    return value.slice(anchor.index + (anchor[1] ? 0 : anchor[0].length));
  return UNSUPPORTED_NEGATION.test(value) ? value : undefined;
}

export function parseOrderStatusFilter(
  message: string,
): SupportOrderStatusFilter | undefined {
  const filter: Filter = { kind: 'filter', include: [], exclude: [] };
  for (const clause of message.split(
    /[;.!?]|\band\s+(?=(?:please\s+)?(?:explain|describe|define)\b)/i,
  )) {
    if (EXPLANATION.test(clause)) continue;
    const noun = clause.match(ORDER_NOUN);
    if (!noun || noun.index === undefined) {
      if (
        ORDER_NOUN.test(message) &&
        UNSUPPORTED_NEGATION.test(clause) &&
        (STATUS_WORD.test(clause) || /\bstatus(?:es)?\b/i.test(clause))
      )
        return unsupported();
      continue;
    }
    const prefix = clause.slice(0, noun.index);
    const before = prefix.match(PREFIX_FILTER);
    if (before) {
      const unparsed = prefix.slice(0, before.index);
      if (UNSUPPORTED_NEGATION.test(unparsed) || STATUS_WORD.test(unparsed))
        return unsupported();
      const remaining = addExpression(filter, before[1]);
      if (remaining === undefined || remaining) return unsupported();
    } else if (UNSUPPORTED_NEGATION.test(prefix)) return unsupported();

    let expression = afterOrderNoun(clause.slice(noun.index + noun[0].length));
    while (expression !== undefined) {
      const remaining = addExpression(filter, expression);
      if (remaining === undefined) return unsupported();
      const trailing = remaining.replace(/^(?:but|and)\s+/i, '');
      if (/^(?:not|neither|excluding|except|without)\b/i.test(trailing)) {
        expression = trailing;
        continue;
      }
      if (/^(?:yet|already|previously|but)\b/i.test(remaining))
        return unsupported();
      // Date/product modifiers do not introduce status keywords. Explicit
      // exclusions retain their meaning even when they follow those modifiers.
      expression = afterOrderNoun(remaining);
      if (expression === remaining && remaining) return unsupported();
      if (!expression && UNSUPPORTED_NEGATION.test(remaining))
        return unsupported();
    }
  }
  if (!filter.include.length && !filter.exclude.length) return undefined;
  return matchingOrderStatuses(filter).length
    ? filter
    : { kind: 'clarification', reason: 'contradictory' };
}
