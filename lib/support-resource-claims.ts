// Only a structured, trusted source may supply these facts. The current database
// has no internal-resource catalog; rendered records and customer text are not one.
export type VerifiedSupportResource = { name: string };

const RESOURCE_WORD =
  '(?:divisions?|departments?|teams?|manuals?|handbooks?|guidelines?|hotlines?|help ?desks?|polic(?:y|ies)|procedures?|technicians?|engineers?|specialists?|representatives?|contacts?|liaisons?)';
const RESOURCE_CLAIMS = [
  new RegExp(
    `\\b(?:SABLE(?:\\s+Systems)?|COV-E|our|my)(?:['’]s?)?(?:-authorized|-certified)?\\s+((?:[\\w-]+\\s+){0,4}?${RESOURCE_WORD})\\b`,
    'gi',
  ),
  new RegExp(`\\brecords\\b[^.!?\\n]{0,60}?\\b(${RESOURCE_WORD})\\b`, 'gi'),
];

function presentationText(content: string) {
  return content
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/(?<!\w)_+|_+(?!\w)/g, '');
}

function resourceName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(?:the|official|authorized|certified)\s+/g, '')
    .replace(new RegExp(`\\b${RESOURCE_WORD}\\b`, 'g'), (word) =>
      word === 'policies' ? 'policy' : word.replace(/s$/, ''),
    )
    .replace(/\s+/g, ' ')
    .trim();
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
export function unsupportedSableResources(
  content: string,
  verifiedResources: readonly VerifiedSupportResource[] = [],
) {
  const verified = new Set(
    verifiedResources.map(({ name }) => resourceName(name)),
  );
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
      // Detection retains broad records attribution. Only the bounded direct
      // noun phrase supplies a name for an explicit verified-fact comparison.
      const resource = /^records\b/i.test(phrase)
        ? phrase.replace(
            /^records\s+(?:(?:do|does)\s+not\s+)?\w+\s+(?:(?:an?|the|any)\s+)?/i,
            '',
          )
        : kind;
      if (
        !verified.has(resourceName(resource)) &&
        !isDenied(
          clause,
          match.index + phrase.length - resource.length,
          match.index + phrase.length,
        )
      )
        phrases.add(phrase);
    }
  }
  return [...phrases];
}
