const RESOURCE_WORD =
  '(?:divisions?|departments?|teams?|manuals?|handbooks?|guidelines?|hotlines?|help ?desks?|polic(?:y|ies)|procedures?|technicians?|engineers?|specialists?|representatives?|contacts?|liaisons?)';
const RESOURCE_CLAIMS = [
  new RegExp(
    `\\b(?:SABLE(?:\\s+Systems)?|COV-E|our|my)(?:['’]s?)?(?:-authorized|-certified)?\\s+((?:[\\w-]+\\s+){0,4}?${RESOURCE_WORD})\\b`,
    'gi',
  ),
  new RegExp(`\\brecords\\b[^.!?\\n]{0,60}?\\b(${RESOURCE_WORD})\\b`, 'gi'),
];

// Organizational units can be named without "SABLE" or "our": "contact the
// accounts department", "the billing team at SABLE". A determiner such as "a"
// or "your", or a word like "local", marks an outside or customer-side unit.
const UNIT_WORD = '(?:divisions?|departments?|teams?|desks?|hotlines?)';
const UNIT_NAME_WORD =
  '(?!(?:the|to|out|please|contact|reach|ask|call|consult|e-?mail|refer)\\b)[\\w-]+\\s+';
const UNIT_NAME = `(?!(?:an?|any|your|their|local|outside|external|independent|third-party)\\b)(?:${UNIT_NAME_WORD}){0,3}?${UNIT_WORD}`;
const AT_SABLE = '\\s+(?:at|of|from|within)\\s+(?:SABLE(?:\\s+Systems)?|COV-E)';
const UNIT_CLAIMS = [
  new RegExp(
    `\\b(?:contact|reach(?:\\s+out\\s+to)?|ask|call|consult|e-?mail|refer\\s+(?:[\\w-]+\\s+){0,2}?to)\\s+(?:the\\s+)?(${UNIT_NAME}(?:${AT_SABLE})?)\\b`,
    'gi',
  ),
  new RegExp(`\\b(${UNIT_NAME}${AT_SABLE})\\b`, 'gi'),
];

function presentationText(content: string) {
  return content
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/(?<!\w)_+|_+(?!\w)/g, '');
}

// These direct denials are local to a clause. A refusal to perform an action
// does not excuse a subsequent referral, even in the same sentence.
function isDenied(text: string, resourceStart: number, end: number) {
  const boundary = /[.!?;,:\n]|\b(?:but|however|instead|yet|and|so)\b/i;
  const prefix = (
    text.slice(0, resourceStart).split(boundary).at(-1) ?? ''
  ).replaceAll('’', "'");
  const suffix = text.slice(end).split(boundary)[0].replaceAll('’', "'");
  return (
    /\b(?:no|without)\s+(?:(?:verified|provided|known)\s+)?(?:SABLE(?:\s+Systems)?|COV-E|our|my)(?:'s?)?\s*$/i.test(
      prefix,
    ) ||
    /\b(?:do not|does not|don't|doesn't|cannot|can't|unable to)\s+(?:provide|include|name|list|verify|confirm|offer)\s+(?:(?!(?:contact|consult|ask|see|follow|refer)\b)\w[\w'-]*\s+){0,5}$/i.test(
      prefix,
    ) ||
    /^\s+(?:is|are|was|were)\s+(?:not|never)\s+(?:listed|provided|available|verified|named|included)\b/i.test(
      suffix,
    ) ||
    /^\s+(?:isn't|aren't|wasn't|weren't)\s+(?:listed|provided|available|verified|named|included)\b/i.test(
      suffix,
    )
  );
}

// Normalized phrases guide one corrective retry. The original answer remains
// untouched for output and persistence. This is a bounded claim grammar, not NLP.
export function unsupportedSableResources(content: string) {
  const text = presentationText(content);
  const phrases = new Set<string>();
  const clauses = text.split(
    /[.!?;,\n]|\s+-\s+|[—–]|\b(?:but|however|instead|yet|so)\b|\band\s+(?=(?:contact|consult|ask|see|follow|refer|our|my|SABLE|COV-E)\b)/i,
  );
  for (const clause of clauses) {
    const owned = [...clause.matchAll(RESOURCE_CLAIMS[0])];
    const records = [...clause.matchAll(RESOURCE_CLAIMS[1])].filter(
      (match) =>
        !owned.some(
          (specific) =>
            specific.index >= match.index &&
            specific.index + specific[0].length ===
              match.index + match[0].length,
        ),
    );
    for (const match of [...owned, ...records]) {
      const [phrase, kind] = match;
      // Records attribution keeps its broad phrase; only the direct noun
      // phrase after it is checked for a local denial.
      const resource = /^records\b/i.test(phrase)
        ? phrase.replace(
            /^records\s+(?:(?:do|does)\s+not\s+)?\w+\s+(?:(?:an?|the|any)\s+)?/i,
            '',
          )
        : kind;
      if (
        !isDenied(
          clause,
          match.index + phrase.length - resource.length,
          match.index + phrase.length,
        )
      )
        phrases.add(phrase);
    }
    const claimed = [...owned, ...records].map(
      (match) => [match.index, match.index + match[0].length] as const,
    );
    for (const match of UNIT_CLAIMS.flatMap((claim) => [
      ...clause.matchAll(claim),
    ])) {
      const unit = match[1];
      const end = match.index + match[0].length;
      const start = end - unit.length;
      // A unit inside an owned or records claim is already reported or denied.
      if (claimed.some(([from, to]) => start < to && end > from)) continue;
      if (!isDenied(clause, start, end)) phrases.add(unit);
    }
  }
  return [...phrases];
}
