export function findPartialFulfillmentPromises(answer: string): string[] {
  const text = answer.replace(/[*`]/g, '').replace(/[’‘]/g, "'");
  const unit = String.raw`(?:partial|individual|loose|single|broken)(?:\s+|-)(?:units?|packs?|cases?)(?:\s+exceptions)?`;
  const separator = String.raw`(?:[ \t]+(?:or|and)[ \t]+|[ \t]*,[ \t]*(?:(?:or|and)[ \t]+)?)`;
  // Share "no" only across an uninterrupted list of the recognized unit
  // phrases. A completed predicate, contrast ("but"), or sentence boundary
  // cannot extend this scope to a later promise. This is not a general parser.
  const negatedListPrefix = String.raw`\bno\s+(?:${unit}${separator})*`;
  const patterns = [
    {
      pattern: new RegExp(
        String.raw`\b(?:can|may|will)\s+(?:still\s+)?(?:be\s+)?(?:handle[ds]?|fulfill(?:ed)?|ship(?:ped)?|process(?:ed)?|suppl(?:y|ied)|sell|sold|order(?:ed)?)\b[^.!?\n]{0,60}\b${unit}\b`,
        'gi',
      ),
      // "No partial units can be shipped as loose units" is a refusal too.
      negatedPrefix: new RegExp(
        String.raw`${negatedListPrefix}${unit}\s+$`,
        'i',
      ),
    },
    {
      pattern: new RegExp(
        String.raw`\b${unit}\s+(?:can|may|will|are|is)\s+(?:still\s+)?(?:be\s+)?(?:fulfilled|shipped|processed|supplied|sold|ordered|allowed|permitted|accepted)\b`,
        'gi',
      ),
      negatedPrefix: new RegExp(`${negatedListPrefix}$`, 'i'),
    },
  ];
  const promises: string[] = [];
  for (const { pattern, negatedPrefix } of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!negatedPrefix.test(text.slice(0, match.index)))
        promises.push(match[0]);
    }
  }
  return promises;
}
