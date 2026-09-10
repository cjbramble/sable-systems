type IncorrectNearestCasePackClaim = {
  claim: string;
  claimedQuantity: number;
  expectedQuantities: number[];
};

export function findIncorrectNearestCasePackClaims(
  answer: string,
  requestedQuantity: number,
  casePackSize: number,
): IncorrectNearestCasePackClaim[] {
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
  const issues: IncorrectNearestCasePackClaim[] = [];
  function checkClaim(claim: string, values: string, description: string) {
    const expectedQuantities = /\blower\b/i.test(description)
      ? lower > 0
        ? [lower]
        : []
      : /\b(?:higher|upper)\b/i.test(description)
        ? [upper]
        : nearest;
    for (const value of values.match(/\d+/g)!) {
      const claimedQuantity = Number(value);
      if (!expectedQuantities.includes(claimedQuantity))
        issues.push({ claim, claimedQuantity, expectedQuantities });
    }
  }

  // Inline claims cannot consume the next line's ordered-list marker as a
  // quantity. Heading/list relationships are checked separately below.
  for (const line of text.split(/\r?\n/)) {
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        // Negation is local; a correct later claim cannot excuse an earlier
        // contradictory claim (or vice versa).
        if (/\b(?:not|never)\s+(?:the\s+)?$/i.test(line.slice(0, match.index)))
          continue;
        checkClaim(
          match[0],
          match.groups!.quantities,
          match.groups!.description,
        );
      }
    }
  }

  // This is a bounded Markdown-list reader, not a general Markdown parser.
  // Preserve list markers before stripping emphasis, including '*' bullets.
  const headingPattern = new RegExp(
    String.raw`^(?:(?:the|valid|equally)\s+)*${subject}\s*:?$`,
    'i',
  );
  const itemPattern = new RegExp(
    String.raw`^${quantities}(?=[ \t]*(?:$|[.(:;—–-]))`,
    'i',
  );
  let heading:
    | {
        indent: number;
        isListItem: boolean;
        childIndent?: number;
        description: string;
        text: string;
      }
    | undefined;
  for (const rawLine of answer.split(/\r?\n/)) {
    const parts = /^([ ]*)(?:([-+*]|\d+[.)])[ ]+)?(.*)$/.exec(
      rawLine.replace(/\t/g, '    '),
    )!;
    const indent = parts[1].length;
    const isListItem = Boolean(parts[2]);
    const content = parts[3]
      .replace(/[*`]/g, '')
      .replace(/^#{1,6}\s+/, '')
      .trim();
    if (!content) continue;
    const match = headingPattern.exec(content);
    if (match) {
      heading = {
        indent,
        isListItem,
        description: match.groups!.description,
        text: content,
      };
      continue;
    }
    if (!heading) continue;
    if (!isListItem) {
      if (
        indent <= (heading.childIndent ?? heading.indent) ||
        content.endsWith(':') ||
        /^#{1,6}\s+/.test(parts[3])
      )
        heading = undefined;
      continue;
    }
    if (
      indent < heading.indent ||
      (heading.isListItem && indent === heading.indent)
    ) {
      heading = undefined;
      continue;
    }
    heading.childIndent ??= indent;
    if (indent < heading.childIndent) {
      heading = undefined;
      continue;
    }
    if (indent > heading.childIndent) continue; // Nested explanatory details.
    const item = itemPattern.exec(content);
    if (!item) {
      heading = undefined; // A different direct-child topic ends this quantity list.
      continue;
    }
    checkClaim(
      `${heading.text}\n${rawLine}`,
      item.groups!.quantities,
      heading.description,
    );
  }
  return issues;
}
