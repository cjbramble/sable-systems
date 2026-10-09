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

function coordinatedTargets(
  message: string,
  occurrence: QuantityOccurrence,
  mentions: ProductMention[],
): boolean {
  const sorted = [...mentions].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous.itemNumber !== current.itemNumber &&
      (occurrence.end <= previous.start || occurrence.start >= current.end) &&
      /^\s*(?:and|or|versus|vs\.?|,|&)\s*(?:the\s+)?$/i.test(
        message.slice(previous.end, current.start),
      )
    )
      return true;
  }
  return false;
}

// Sharing words must qualify the quantity, not an unrelated price question.
function sharedTargets(
  message: string,
  occurrence: QuantityOccurrence,
  mentions: ProductMention[],
): Set<string> | undefined {
  let prose = message;
  for (const { start, end } of [...mentions, occurrence])
    prose = `${prose.slice(0, start)}${' '.repeat(end - start)}${prose.slice(end)}`;
  const before = prose.slice(0, occurrence.start);
  const after = message.slice(occurrence.end);
  if (
    !/^\s+(?:each\b|per (?:item|product)\b|(?:of|for)\s+(?:each|both)\b)/i.test(
      after,
    ) &&
    !/\b(?:compare\s+both|(?:each|both)(?:\s+(?:items?|products?))?(?:\s+(?:and|or|versus|vs\.?))?\s+(?:for|needs?|requires?|at|with))\s*$/i.test(
      before,
    )
  )
    return undefined;

  // Product names can contain punctuation. Find clause boundaries only outside
  // those names and the quantity; a separate question does not share its count.
  let start = 0;
  let end = message.length;
  for (const boundary of prose.matchAll(/[;.!?]|\b(?:what|where|how)\b/gi)) {
    if (boundary.index < occurrence.start)
      start = boundary.index + boundary[0].length;
    else if (boundary.index >= occurrence.end) {
      end = boundary.index;
      break;
    }
  }
  const targets = mentions.filter(
    (mention) => mention.start >= start && mention.end <= end,
  );
  // Saved SKU follow-ups append their resolved targets after the question.
  return new Set(
    (targets.length ? targets : mentions).map((mention) => mention.itemNumber),
  );
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

  for (const occurrence of occurrences) {
    if (occurrence.quantity.kind !== 'valid') continue;
    const shared =
      occurrences.length === 1
        ? sharedTargets(message, occurrence, mentions)
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
        coordinatedTargets(message, occurrence, mentions))
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
