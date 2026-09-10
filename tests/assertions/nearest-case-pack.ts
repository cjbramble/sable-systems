export function findIncorrectNearestCasePackClaims(
  answer: string,
  requestedQuantity: number,
  casePackSize: number,
): Array<{
  claim: string;
  claimedQuantity: number;
  expectedQuantities: number[];
}> {
  if (
    !Number.isSafeInteger(requestedQuantity) ||
    requestedQuantity <= 0 ||
    !Number.isSafeInteger(casePackSize) ||
    casePackSize <= 0
  )
    throw new RangeError('Expected positive integer quantities and case packs');

  const lower = Math.floor(requestedQuantity / casePackSize) * casePackSize;
  const upper = Math.ceil(requestedQuantity / casePackSize) * casePackSize;
  const candidates = [...new Set([lower, upper])].filter((value) => value > 0);
  const distance = Math.min(
    ...candidates.map((value) => Math.abs(value - requestedQuantity)),
  );
  const nearest = candidates.filter(
    (value) => Math.abs(value - requestedQuantity) === distance,
  );
  const text = answer
    .replace(/[*`]/g, '')
    .replace(/\be\.g\.,?/gi, 'for example,');

  // Target explicit nearest/closest quantity claims, not every number in a
  // reply. Pack size, requested quantity, and parenthetical case counts are
  // not asserted quantities. This is bounded phrase coverage, not general NLP.
  const subject = String.raw`\b(?:nearest|closest)\s+(?<description>(?:(?:valid|full|whole|case[- ]pack|lower|higher|upper)\s+)*(?:order(?:\s+quantity)?|quantit(?:y|ies)|multiples?|case[- ]packs?))\b(?:\s+of\s+\d+\b)?(?:\s+(?:to|for)\s+\d+\b)?`;
  const quantities = String.raw`(?<quantities>\b\d+(?:\s+units?)?(?:\s*(?:,|or|and)\s*\d+(?:\s+units?)?)*)\b`;
  const patterns = [
    new RegExp(
      String.raw`${subject}\s*(?:(?:is|are|would\s+be)\s+|[:=]\s*|\(\s*(?:for\s+example,?\s*)?)?${quantities}`,
      'gi',
    ),
    new RegExp(
      String.raw`\b${quantities}\s+(?:is|are|would\s+be)\s+(?:the\s+)?${subject}`,
      'gi',
    ),
  ];
  const issues = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      // Do not turn a local negation into an affirmative claim or let it
      // excuse a separate, later incorrect nearest-quantity statement.
      if (/\b(?:not|never)\s+(?:the\s+)?$/i.test(text.slice(0, match.index)))
        continue;
      const description = match.groups!.description;
      const expectedQuantities = /\blower\b/i.test(description)
        ? lower > 0
          ? [lower]
          : []
        : /\b(?:higher|upper)\b/i.test(description)
          ? [upper]
          : nearest;
      for (const value of match.groups!.quantities.match(/\d+/g)!) {
        const claimedQuantity = Number(value);
        if (!expectedQuantities.includes(claimedQuantity))
          issues.push({ claim: match[0], claimedQuantity, expectedQuantities });
      }
    }
  }
  return issues;
}
