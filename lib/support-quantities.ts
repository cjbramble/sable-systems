export type QuantityOccurrence = {
  start: number;
  end: number;
  raw: string;
  quantity:
    | { kind: 'valid'; value: number }
    | { kind: 'invalid'; reason: 'syntax' | 'range' };
};

export type ProductMention = {
  itemNumber: string;
  start: number;
  end: number;
};

type ProductGroup = {
  start: number;
  end: number;
  items: Set<string>;
};

type QuantityAssignment =
  | { kind: 'assigned'; quantities: Map<string, number> }
  | {
      kind: 'clarification';
      reason: 'syntax' | 'range' | 'ambiguous' | 'missing_target';
    };

// Retain support's six-digit quantity range. Checkout has its own order limit.
const MAX_SUPPORT_QUANTITY = 999_999;

// Nouns that count a product. Catalog unit labels extend these generic ones,
// so "12 cells" is a quantity once the caller passes the product labels.
const GENERIC_UNITS = [
  'unit',
  'license',
  'controller',
  'array',
  'module',
  'hub',
  'node',
  'pack',
];

export type QuantityUnits = { readonly key: string; readonly source: string };

function plural(label: string) {
  if (/[^aeiou]y$/.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(?:s|x|ch|sh)$/.test(label)) return `${label}es`;
  return `${label}s`;
}

const MAX_CACHED_UNITS = 8;
const unitSets = new Map<string, QuantityUnits>();

export function quantityUnits(labels: Iterable<string> = []): QuantityUnits {
  const singular = new Set(GENERIC_UNITS);
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    // Labels are catalog data; only plain words become part of the pattern.
    if (/^[a-z]+$/.test(normalized)) singular.add(normalized);
  }
  const key = [...singular].sort().join(',');
  let units = unitSets.get(key);
  if (!units) {
    const words = [...singular]
      .flatMap((label) => [label, plural(label)])
      .sort((left, right) => right.length - left.length);
    units = Object.freeze({ key, source: words.join('|') });
    if (unitSets.size >= MAX_CACHED_UNITS)
      unitSets.delete(unitSets.keys().next().value!);
    unitSets.set(key, units);
  }
  return units;
}

const DEFAULT_UNITS = quantityUnits();

// Classification re-reads saved history for every clause of the latest
// message, so identical messages are parsed once. Entries are pure results.
const MAX_CACHED_MESSAGES = 64;
const parsedMessages = new Map<string, readonly QuantityOccurrence[]>();

export function parseQuantityOccurrences(
  message: string,
  units: QuantityUnits = DEFAULT_UNITS,
): QuantityOccurrence[] {
  const cacheKey = `${units.key}\n${message}`;
  let parsed = parsedMessages.get(cacheKey);
  if (!parsed) {
    parsed = Object.freeze(scanQuantityOccurrences(message, units));
    if (parsedMessages.size >= MAX_CACHED_MESSAGES)
      parsedMessages.delete(parsedMessages.keys().next().value!);
    parsedMessages.set(cacheKey, parsed);
  }
  return parsed.map((occurrence) => ({
    ...occurrence,
    quantity: { ...occurrence.quantity },
  }));
}

const NUMBER_WORD =
  '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen)';
const MULTIPLIER = /\b(?:dozen|hundred|thousand|million)\b/i;
const NUMBER_CHARACTER = /[\d.,/e+\-−–—]/i;
const NUMBER_TOKEN = /^(?:[+\-−–—])?(?:\d|\.\d)[\d.,/e+\-−–—]*$/i;
const BOUNDARY_BEFORE_NUMBER = /[\w.,/+\-−–—$]/;

// The bounded repeat can start a match inside a run of more than nine numbers.
// Walk back to where the whole expression begins, so its start (which a
// preceding "order" label relies on) matches the unbounded pattern. Each step
// reads one token, so this stays linear.
function expressionStart(message: string, start: number, floor: number) {
  let current = start;
  while (true) {
    let index = current;
    while (index > floor && /[ \t]/.test(message[index - 1])) index -= 1;
    if (index === current) return current;
    const connector = message
      .slice(Math.max(floor, index - 8), index)
      .match(/(?:^|[ \t])(to|through|and)$/i);
    if (connector) {
      index -= connector[1].length;
      const beforeConnector = index;
      while (index > floor && /[ \t]/.test(message[index - 1])) index -= 1;
      if (index === beforeConnector) return current;
    }
    const tokenEnd = index;
    while (index > floor && NUMBER_CHARACTER.test(message[index - 1]))
      index -= 1;
    if (
      index === tokenEnd ||
      !NUMBER_TOKEN.test(message.slice(index, tokenEnd)) ||
      (index > 0 && BOUNDARY_BEFORE_NUMBER.test(message[index - 1]))
    )
      return current;
    current = index;
  }
}

// What may follow a quantity: up to two modifiers and a unit noun, or an item
// number directly ("100 SBL-RPC-12"). Order IDs (SBL-2026-…) are not items.
function quantityTail(units: QuantityUnits) {
  return `(?:(?:\\s+[a-z-]+){0,2}\\s+(?:${units.source})\\b|(?=\\s+sbl-(?!\\d{4}-)[a-z0-9][a-z0-9-]*(?![\\w-])))`;
}

const MAX_CACHED_PATTERNS = 8;
const patterns = new Map<string, { digits: RegExp; words: RegExp }>();

function quantityPatterns(units: QuantityUnits) {
  let compiled = patterns.get(units.key);
  if (!compiled) {
    const tail = quantityTail(units);
    compiled = {
      // Consume the complete numeric expression before validating it. In
      // particular, punctuation, signs, exponents, and grouped digits cannot
      // expose a valid suffix. The bounded repeat keeps long runs of numbers
      // linear; expressionStart restores the start of a longer run, which is
      // invalid syntax either way. The outer boundaries exclude SKU/model
      // suffixes and attached capacity units.
      digits: new RegExp(
        `(?<![\\w.,/+\\-−–—$])((?:[+\\-−–—]\\s*)?(?:\\d|\\.\\d)[\\d.,/e+\\-−–—]*(?:[ \\t]+(?:(?:to|through|and)[ \\t]+)?[\\d.,/+\\-−–—][\\d.,/e+\\-−–—]*){0,8})(?![\\w.,/+\\-−–—])(?!\\s*(?:tb|gb|mb|kb|m)\\b)${tail}`,
        'gi',
      ),
      // Spelled-out amounts ("two", "a dozen", "twenty-five") are quantities
      // the lookup can't check, so they ask for digits instead of being ignored.
      words: new RegExp(
        `(?<![\\w-])((?:(?:a|half[ \\t]+a)[ \\t]+)?${NUMBER_WORD}(?:(?:[ \\t]+(?:and[ \\t]+)?|-)${NUMBER_WORD}){0,5})(?![\\w-])${tail}`,
        'gi',
      ),
    };
    if (patterns.size >= MAX_CACHED_PATTERNS)
      patterns.delete(patterns.keys().next().value!);
    patterns.set(units.key, compiled);
  }
  return compiled;
}

function scanQuantityOccurrences(
  message: string,
  units: QuantityUnits,
): QuantityOccurrence[] {
  const { digits, words } = quantityPatterns(units);
  const occurrences: QuantityOccurrence[] = [];
  let previousEnd = 0;
  for (const match of message.matchAll(digits)) {
    const tail = match[0].slice(match[1].length);
    // A rate such as "680.00 per unit" is not an order quantity. Inspect only
    // this phrase so "1.5 units per item" still retains its invalid quantity.
    if (/\bper\b/i.test(tail)) continue;
    const start = expressionStart(message, match.index, previousEnd);
    const end = match.index + match[0].length;
    const raw = message.slice(start, match.index + match[1].length);
    previousEnd = end;
    // "2 dozen units" is not 2 units.
    const validSyntax =
      /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw) && !MULTIPLIER.test(tail);
    const value = Number(raw.replaceAll(',', ''));
    const quantity: QuantityOccurrence['quantity'] = !validSyntax
      ? { kind: 'invalid', reason: 'syntax' }
      : value < 1 || value > MAX_SUPPORT_QUANTITY
        ? { kind: 'invalid', reason: 'range' }
        : { kind: 'valid', value };
    occurrences.push({ start, end, raw, quantity });
  }
  for (const match of message.matchAll(words)) {
    const start = match.index;
    const end = start + match[0].length;
    // A lone "one" can be a pronoun: "which one", "one of the hubs".
    if (
      (/^one$/i.test(match[1]) &&
        (/^\s+of\b/i.test(match[0].slice(match[1].length)) ||
          /\b(?:which|the|that|this|any|each|every|no|some)\s+$/i.test(
            message.slice(0, start),
          ))) ||
      /\bper\b/i.test(match[0].slice(match[1].length)) ||
      occurrences.some(
        (occurrence) => start < occurrence.end && end > occurrence.start,
      )
    )
      continue;
    occurrences.push({
      start,
      end,
      raw: match[1],
      quantity: { kind: 'invalid', reason: 'syntax' },
    });
  }
  return occurrences.sort((left, right) => left.start - right.start);
}

// Products that a quantity's own phrase names: inside it ("8 Redline units"),
// right after it ("8 units of SBL-RPC-12"), or right before it.
export function localTargets(
  message: string,
  occurrence: QuantityOccurrence,
  mentions: ProductMention[],
): Set<string> {
  const candidates = new Set<string>();
  for (const mention of mentions) {
    // A product alias can be a modifier inside "8 Redline units".
    const insidePhrase =
      mention.start >= occurrence.start + occurrence.raw.length &&
      mention.end <= occurrence.end;
    const prefix =
      mention.start >= occurrence.end &&
      /^[\s:("'`]*(?:(?:of|for)\s+)?(?:the\s+)?$/i.test(
        message.slice(occurrence.end, mention.start),
      );
    const postfix =
      mention.end <= occurrence.start &&
      /^[\s,:;("'`]*(?:(?:inventory|availability)\s*:\s*|(?:for|at|with)\s+)?$/i.test(
        message.slice(mention.end, occurrence.start),
      );
    if (insidePhrase || prefix || postfix) candidates.add(mention.itemNumber);
  }
  return candidates;
}

function productGroups(
  message: string,
  mentions: ProductMention[],
): ProductGroup[] {
  const groups: ProductGroup[] = [];
  const sorted = [...mentions].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  for (const mention of sorted) {
    const previous = groups.at(-1);
    const separator = previous
      ? message
          .slice(previous.end, mention.start)
          .replace(/^[\s()"'`]+|[\s()"'`]+$/g, '')
      : '';
    if (
      previous &&
      (mention.start <= previous.end ||
        separator === '' ||
        /^(?:(?:,\s*)?(?:and|or|versus|vs\.?|&|\/)|,)(?:\s+the)?$/i.test(
          separator,
        ))
    ) {
      previous.end = Math.max(previous.end, mention.end);
      previous.items.add(mention.itemNumber);
    } else {
      groups.push({
        start: mention.start,
        end: mention.end,
        items: new Set([mention.itemNumber]),
      });
    }
  }
  return groups;
}

// Sharing words must qualify the quantity, not an unrelated price question.
function sharedTargets(
  message: string,
  occurrence: QuantityOccurrence,
  groups: ProductGroup[],
): Set<string> | undefined {
  let prose = message;
  for (const { start, end } of groups)
    prose = `${prose.slice(0, start)}${' '.repeat(end - start)}${prose.slice(end)}`;
  const before = prose.slice(0, occurrence.start);
  const after = message.slice(occurrence.end);
  if (
    !/^\s+(?:each\b|per (?:item|product)\b|(?:of|for)\s+(?:each|both)\b)/i.test(
      after,
    ) &&
    !/\b(?:compare\s+both|(?:each|both)(?:\s+(?:items?|products?))?\s+(?:for|needs?|requires?|at|with))\s*$/i.test(
      before,
    )
  )
    return undefined;

  // Attach sharing to an adjacent list, not every product in the sentence.
  // List construction already preserves punctuation inside full product names.
  const targets = groups.filter((group) => {
    if (group.end <= occurrence.start)
      return /^[\s)"'`]*(?:(?:for|at|with|needs?|requires?)\s*)?$/i.test(
        message.slice(group.end, occurrence.start),
      );
    if (group.start >= occurrence.end)
      return /^(?:(?:each|both|of|for|the|per|items?|products?)\b|[\s.!?:("'`])*$/i.test(
        message.slice(occurrence.end, group.start),
      );
    return false;
  });
  if (targets.length === 1) return targets[0].items;
  // Saved SKU follow-ups can append one resolved list after the question.
  // Multiple unrelated lists must never become an implicit shared target set.
  if (!targets.length && groups.length === 1) return groups[0].items;
  return new Set();
}

export function bindProductQuantities(
  message: string,
  occurrences: QuantityOccurrence[],
  mentions: ProductMention[],
): QuantityAssignment {
  const quantities = new Map<string, number>();
  // An empty map means absence, never a zero quantity. Invalid occurrences
  // remain explicit even if no product could be matched.
  for (const { quantity } of occurrences)
    if (quantity.kind === 'invalid')
      return { kind: 'clarification', reason: quantity.reason };
  if (!occurrences.length) return { kind: 'assigned', quantities };
  const items = new Set(mentions.map((mention) => mention.itemNumber));
  if (!items.size) return { kind: 'clarification', reason: 'missing_target' };
  if (
    items.size > 1 &&
    /\b(?:total|combined|altogether|between)\b/i.test(message)
  )
    return { kind: 'clarification', reason: 'ambiguous' };

  const groups = productGroups(message, mentions);
  for (const occurrence of occurrences) {
    if (occurrence.quantity.kind !== 'valid') continue;
    const shared =
      occurrences.length === 1
        ? sharedTargets(message, occurrence, groups)
        : undefined;
    const candidates =
      shared ??
      (items.size === 1 && occurrences.length === 1
        ? items
        : localTargets(message, occurrence, mentions));
    if (
      !candidates.size ||
      (!shared && candidates.size > 1) ||
      (!shared &&
        occurrences.length === 1 &&
        groups.some(
          (group) =>
            group.items.size > 1 &&
            (occurrence.end <= group.start || occurrence.start >= group.end),
        ))
    )
      return { kind: 'clarification', reason: 'ambiguous' };
    for (const item of candidates) {
      const previous = quantities.get(item);
      if (previous !== undefined && previous !== occurrence.quantity.value)
        return { kind: 'clarification', reason: 'ambiguous' };
      quantities.set(item, occurrence.quantity.value);
    }
  }
  return { kind: 'assigned', quantities };
}
