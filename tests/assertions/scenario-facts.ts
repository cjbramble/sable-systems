import { expect } from 'vitest';

// Evaluation-only grammar: direct status statements/labels and numeric available
// quantities. This does not infer arbitrary prose or use the production parser.
export function normalizeAnswerPresentation(answer: string) {
  return answer
    .replace(/[*`]/g, '')
    .replace(/(?<!\w)_+|_+(?!\w)/g, '')
    .replace(/’/g, "'");
}

const entityId = String.raw`(?:SBL-\d{4}-\d{6}|SHP-\d{4}-\d{6}|RTN-\d{4}-\d{6}|SBL-[A-Z0-9]+(?:-[A-Z0-9]+)+)`;
const entity = String.raw`\b(?:${entityId}|order|shipment|return|product|item)\b`;
const entityPattern = new RegExp(entity, 'gi');
const trailingSubject = new RegExp(
  String.raw`^\s*(?:(?:units?|cells?)\s+)?(?:for|of)\s+(?:(another|a different|the other|other|different|the|this|that|my|our|your|its|their|an?)\s+)?(${entity})(?:\s+(${entityId})\b)?`,
  'i',
);
const subjectBeforeClaim = new RegExp(
  String.raw`${entity}\s*(?:(?:has|have)\s+|[:|—]\s*)?$`,
  'i',
);
const subjectInClaim = new RegExp(`^${entity}`, 'i');
type Subject = { id: string; kind: string };

function hasLeadingSubject(text: string, start: number, end: number) {
  return (
    subjectBeforeClaim.test(text.slice(0, start)) ||
    subjectInClaim.test(text.slice(start, end))
  );
}

function resolveSubject(
  token: string,
  prefix: string,
  named: Map<string, string>,
  subject: Subject,
) {
  token = token.toUpperCase();
  if (token.includes('-')) {
    const kind = /^SBL-\d{4}-\d{6}$/.test(token)
      ? 'order'
      : token.startsWith('SHP-')
        ? 'shipment'
        : token.startsWith('RTN-')
          ? 'return'
          : 'product';
    named.set(kind, token);
    return token;
  }
  const kind = token === 'ITEM' ? 'product' : token.toLowerCase();
  if (/\b(?:another|different|other)\s+$/i.test(prefix)) {
    const other = `other ${kind}`;
    named.set(kind, other);
    return other;
  }
  return named.get(kind) ?? (kind === subject.kind ? subject.id : kind);
}

function followsFact(clause: string, qualifier: RegExpExecArray) {
  if (!/^(?:for|of)\b/i.test(qualifier[0])) return false;
  const before = clause.slice(0, qualifier.index);
  return [statusClaims, quantityClaims, stockDenials].some((pattern) =>
    [...before.matchAll(pattern)].some((claim) => {
      const end = claim.index + claim[0].length;
      return (
        !hasLeadingSubject(before, claim.index, end) &&
        /^\s*(?:(?:units?|cells?)\s*)?$/i.test(before.slice(end))
      );
    }),
  );
}

function belongsTo(
  text: string,
  position: number,
  end: number,
  subject: Subject,
) {
  // IDs and noun-like labels establish ownership. Trailing factual subjects
  // also remain the referents of subsequent pronouns and kind labels.
  const named = new Map<string, string>();
  let owner = subject.id;
  for (const mention of text.slice(0, end).matchAll(entityPattern)) {
    const clause = text
      .slice(0, mention.index)
      .split(/[.!?;\n]/)
      .at(-1)!;
    const qualifier =
      /\b(?:for|of|on|from|to|with)\s+(?:(?:this|that|the|your|our|its|their|another|a different|the other|other|different)\s+)?(?:(?:order|shipment|return|product|item)\s+)?$/i.exec(
        clause,
      );
    // "Shipment for this order" retains shipment scope, whereas "Status:
    // delivered for this order" names the subject of the preceding fact.
    if (
      qualifier &&
      /\w/.test(clause.slice(0, qualifier.index)) &&
      !followsFact(clause, qualifier)
    )
      continue;
    if (!mention[0].includes('-')) {
      const suffix = text.slice(mention.index + mention[0].length);
      const nounLike =
        qualifier ||
        /\b(?:the|a|an|this|that|my|our|your|its|their|another|different|other)\s+$/i.test(
          clause,
        ) ||
        /^\s*(?:[:|—]|\b(?:status|is|was|has|had)\b)/i.test(suffix);
      if (!nounLike) continue;
    }
    owner = resolveSubject(mention[0], clause, named, subject);
  }
  // Only an immediate qualifier in this clause owns the value. A later sentence
  // or conjunction must not reassign an already complete claim.
  const tail = text.slice(end).split(/[.!?;\n]/, 1)[0];
  const trailing = trailingSubject.exec(tail);
  if (trailing && !hasLeadingSubject(text, position, end))
    owner = resolveSubject(
      trailing[3] ?? trailing[2],
      `${trailing[1] ?? ''} `,
      named,
      subject,
    );
  return owner === subject.id;
}

const statuses =
  'partially[_ -]shipped|in[_ -]transit|on[_ -]hold|delivered|shipped|delayed|backordered|closed|authorized|cancelled|canceled|received|scheduled|confirmed|allocating|preparing|returned|requested|denied|credited';
const statusClaims = new RegExp(
  `(?:\\b(?:current\\s+)?status\\s*(?:(?:is|was|as)\\s*|[:|]\\s*)?|\\b(?:is(?: now)?|was|has been|isn't|wasn't)\\s+|(?:SBL-\\d{4}-\\d{6}|SHP-\\d{4}-\\d{6}|RTN-\\d{4}-\\d{6})\\s*[:|—]\\s*)((?:(?:not|never|no longer|currently)\\s+)*)(${statuses})\\b`,
  'gi',
);

function expectStatus(text: string, subject: Subject, expected: string | null) {
  let affirmed = false;
  for (const claim of text.matchAll(statusClaims)) {
    if (!belongsTo(text, claim.index, claim.index + claim[0].length, subject))
      continue;
    const value = claim[2]
      .toLowerCase()
      .replace(/[_ -]/g, '_')
      .replace('canceled', 'cancelled');
    const negated =
      /\b(?:not|never|no longer)\b/i.test(claim[1]) ||
      /\b(?:isn't|wasn't)\b/i.test(claim[0]);
    expect(
      expected,
      `No status is known for ${subject.id}: ${claim[0]}`,
    ).not.toBeNull();
    if (negated) {
      expect(
        value,
        `Denied expected status for ${subject.id}: ${claim[0]}`,
      ).not.toBe(expected);
    } else {
      expect(value, `Conflicting status for ${subject.id}: ${claim[0]}`).toBe(
        expected,
      );
      affirmed = true;
    }
  }
  if (expected !== null)
    expect(affirmed, `Missing affirmative status for ${subject.id}`).toBe(true);
}

const quantityClaims =
  /(?:\bavailable(?:[- ]to[- ]promise)?(?:\s+(?:quantity|stock|units))?\s*(?:is|of|:|=)?\s*(not\s+)?([+-]?\d[\d,]*(?:\.\d+)?)|(?<![\w.,+-])([+-]?\d[\d,]*(?:\.\d+)?)\s+(?:units?|cells?)\s+(?:are\s+)?(not\s+)?available)\b/gi;
const stockDenials =
  /\b(?:not|never|no longer|isn't|aren't|wasn't|weren't)\s+(?:currently\s+)?(?:available|(?:in\s+)?stock)\b|\bout of\s+(?:current\s+)?stock\b|\bunavailable\b|\b(?:no|zero)\s+(?:current\s+)?stock\b/gi;

function expectAvailability(text: string, subject: Subject, expected: number) {
  let affirmed = false;
  for (const claim of text.matchAll(quantityClaims)) {
    if (!belongsTo(text, claim.index, claim.index + claim[0].length, subject))
      continue;
    const token = claim[2] ?? claim[3];
    expect(token, `Malformed availability: ${claim[0]}`).toMatch(
      /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/,
    );
    const quantity = Number(token.replaceAll(',', ''));
    if (claim[1] || claim[4]) {
      expect(
        quantity,
        `Denied availability for ${subject.id}: ${claim[0]}`,
      ).not.toBe(expected);
    } else {
      expect(
        quantity,
        `Conflicting availability for ${subject.id}: ${claim[0]}`,
      ).toBe(expected);
      affirmed = true;
    }
  }
  if (expected > 0) {
    for (const denial of text.matchAll(stockDenials)) {
      const prefix = text.slice(0, denial.index);
      // "Not available" denies stock, but "not out of stock" affirms it.
      if (
        /\b(?:not|never|no longer|isn't|aren't|wasn't|weren't)\s+(?:currently\s+)?$/i.test(
          prefix,
        )
      )
        continue;
      expect(
        belongsTo(text, denial.index, denial.index + denial[0].length, subject),
        `Denied stock for ${subject.id}: ${denial[0]}`,
      ).toBe(false);
    }
  }
  expect(affirmed, `Missing available quantity for ${subject.id}`).toBe(true);
}

export function expectScenarioFacts(
  text: string,
  scenario: {
    contextIncludes: string[];
    expectedStatus: string | null;
    expectedAvailable: number | null;
  },
) {
  const record = scenario.contextIncludes[0].match(
    /\b(order|shipment|return)\b(?: matching)?[: ]+((?:SBL|SHP|RTN)-\d{4}-\d{6})/i,
  );
  if (scenario.expectedStatus !== null)
    expect(
      record,
      'Scenario must identify the requested record',
    ).not.toBeNull();
  if (record)
    expectStatus(
      text,
      { id: record[2], kind: record[1].toLowerCase() },
      scenario.expectedStatus,
    );
  if (scenario.expectedAvailable !== null) {
    const product = scenario.contextIncludes
      .join('\n')
      .match(/Product: (SBL-[A-Z0-9]+(?:-[A-Z0-9]+)+)/);
    expect(
      product,
      'Scenario must identify the requested product',
    ).not.toBeNull();
    expectAvailability(
      text,
      { id: product![1], kind: 'product' },
      scenario.expectedAvailable,
    );
  }
}
