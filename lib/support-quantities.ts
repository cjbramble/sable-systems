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

export function parseQuantityOccurrences(
  message: string,
): QuantityOccurrence[] {
  const occurrences: QuantityOccurrence[] = [];
  // Consume the complete numeric expression before validating it. In particular,
  // punctuation, signs, exponents, and grouped digits cannot expose a valid suffix.
  // The outer boundaries exclude SKU/model suffixes and attached capacity units.
  const phrases =
    /(?<![\w.,/+\-−–—$])((?:[+\-−–—]\s*)?(?:\d|\.\d)[\d.,/e+\-−–—]*(?:[ \t]+(?:(?:to|through|and)[ \t]+)?[\d.,/+\-−–—][\d.,/e+\-−–—]*)*)(?![\w.,/+\-−–—])(?!\s*(?:tb|gb|mb|kb|m)\b)(?:\s+[a-z-]+){0,2}\s+(?:units?|licenses?|controllers?|arrays?|modules?|hubs?|nodes?|packs?)\b/gi;
  for (const match of message.matchAll(phrases)) {
    const raw = match[1];
    // A rate such as "680.00 per unit" is not an order quantity. Inspect only
    // this phrase so "1.5 units per item" still retains its invalid quantity.
    if (/\bper\b/i.test(match[0].slice(raw.length))) continue;
    const validSyntax = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw);
    const value = Number(raw.replaceAll(',', ''));
    const quantity: QuantityOccurrence['quantity'] = !validSyntax
      ? { kind: 'invalid', reason: 'syntax' }
      : value < 1 || value > MAX_SUPPORT_QUANTITY
        ? { kind: 'invalid', reason: 'range' }
        : { kind: 'valid', value };
    occurrences.push({
      start: match.index,
      end: match.index + match[0].length,
      raw,
      quantity,
    });
  }
  return occurrences;
}

function localTargets(
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
