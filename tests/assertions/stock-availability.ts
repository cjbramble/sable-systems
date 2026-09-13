// Bounded coverage for explicit, single-product current-stock promises. An empty
// result means no recognized overclaim, not that arbitrary prose is factual.
export function findCurrentStockOverclaims(
  answer: string,
  availableQuantity: number,
): string[] {
  if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0)
    throw new RangeError('Expected a non-negative integer available quantity');

  // Allow an optional product name between the amount and its unit, including
  // names such as "Redline Power Cell R12". Never take R12 as the amount.
  const quantity =
    '((?:\\d{1,3}(?:,\\d{3})+|\\d+))(?:[ \\t]+[a-z][a-z0-9-]*){0,8}[ \\t]+(?:units?|cells?)';
  const fromStock =
    '(?:(?:entirely|fully|in full) )?from (?:the )?(?:current|available) stock(?:,? with no (?:stock )?(?:shortfall|shortage))?[.!;]?$';
  const patterns = [
    new RegExp(`^we can (?:supply|ship|fulfill) ${quantity} ${fromStock}`, 'i'),
    new RegExp(
      `^(?:a quantity of )?${quantity} can be (?:supplied|shipped|fulfilled) ${fromStock}`,
      'i',
    ),
    new RegExp(
      `^(?:change (?:it|the (?:order|quantity)) to )?${quantity},? which is a whole-(?:case|pack) quantity we can (?:supply|ship|fulfill) ${fromStock}`,
      'i',
    ),
  ];
  const text = answer.replace(/[*`]/g, '').replace(/[’‘]/g, "'");
  const claims: string[] = [];
  for (const statement of text.matchAll(/[^.!?\r\n;]+[.!?;]?/g)) {
    // Match direct assertions, not questions, quoted examples, or statements
    // prefixed with negation/conditions such as "After restocking, ...". The
    // pattern's ending also excludes trailing conditions such as "if ...".
    const clause = statement[0].trim().replace(/^[-+]\s+/, '');
    if (clause.endsWith('?')) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(clause);
      if (match && Number(match[1].replaceAll(',', '')) > availableQuantity)
        claims.push(match[0]);
    }
  }
  return claims;
}
