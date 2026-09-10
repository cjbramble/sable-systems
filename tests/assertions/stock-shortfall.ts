export function findPositiveStockShortfallClaims(
  answer: string,
  requestedQuantity: number,
): string[] {
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0)
    throw new RangeError('Expected a positive integer requested quantity');
  const text = answer.replace(/[*`]/g, '').replace(/[’‘]/g, "'");
  const patterns = [
    /\bout of stock\b|\b(?:shortfall|shortage)\s*(?:of|is|:)?\s*([1-9]\d*)\b/gi,
    /\b[1-9]\d*\s+(?:units?|cells?)\s+short\b/gi,
    /\bshort\s+by\s+[1-9]\d*\b/gi,
    /\b[1-9]\d*[- ]units?(?:\s+stock)?\s+(?:shortfall|shortage)\b/gi,
  ];
  const claims: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      // Only a negation immediately attached to this claim is relevant.
      // "No shortage ... but 8 units short" must still report the latter.
      if (
        /\b(?:no|not|never|isn't|aren't|wasn't|weren't)(?:[ \t]+(?:a|an|any|actual|current|stock|inventory))*[ \t]+$/i.test(
          text.slice(0, match.index),
        )
      )
        continue;

      // In "Stock shortfall: 310 units cannot be ordered due to the case-pack
      // rule", 310 is the subject (the request), not a reported shortage.
      // Keep this exception narrow: colon label, exact requested quantity,
      // explicit ordering predicate/reason, and no simultaneous stock deficit.
      // "Is not a multiple" directly states the ordering restriction; an
      // additional claim that the request exceeds stock must not be excused.
      if (
        Number(match[1]) === requestedQuantity &&
        /(?:shortfall|shortage)\s*:/i.test(match[0])
      ) {
        const predicate = text
          .slice(match.index + match[0].length)
          .match(/^[ \t]+(?:units?|cells?)[ \t]+([^.!?\r\n;]*)/i)?.[1];
        if (
          predicate &&
          /^(?:(?:cannot|can't|can not)\s+(?:be\s+)?(?:ordered|fulfilled|accepted|processed)|(?:is|are)\s+(?:not\s+(?:a\s+)?(?:valid|multiple)|invalid))\b/i.test(
            predicate,
          ) &&
          /\b(?:ordering restriction|case[- ]pack|not\s+(?:a\s+)?(?:valid\s+)?multiple|not divisible)\b/i.test(
            predicate,
          ) &&
          !/\b(?:insufficient|shortage|shortfall|unavailable|missing|lack|lacks|exceeds?|out of stock)\b/i.test(
            predicate,
          )
        )
          continue;
      }
      claims.push(match[0]);
    }
  }
  return claims;
}
