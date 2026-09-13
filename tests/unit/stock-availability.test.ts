import { expect, it } from 'vitest';
import { findCurrentStockOverclaims } from '../assertions/stock-availability';
import directClaims from '../fixtures/judge/direct-claims.json';
import holdout from '../fixtures/judge/holdout.json';

it('checks current-stock promises without treating pack validity or future supply as current availability', () => {
  for (const example of directClaims.examples) {
    const verdict = expect(
      findCurrentStockOverclaims(example.text, 312),
      example.id,
    );
    if (example.correct) verdict.toEqual([]);
    else verdict.not.toEqual([]);
  }

  for (const answer of [
    '320 units is a valid case-pack quantity, but exceeds available stock by 8.',
    'We cannot supply 320 units entirely from current stock.',
    'A quantity of 320 units cannot be supplied entirely from current stock.',
    'After restocking, we can supply 320 units entirely from current stock.',
    'We can supply 320 units entirely from current stock if another 8 arrive.',
    'It is not true that we can supply 320 units entirely from current stock.',
    'We can supply 320 units entirely from current stock?',
  ])
    expect(findCurrentStockOverclaims(answer, 312), answer).toEqual([]);

  // The original full-answer control uses a relative clause, not the direct
  // active/passive sentences above. Retain it verbatim as regression evidence.
  const badAlternative = holdout.scenarios['case-pack'].find(
    (example) => example.id === 'holdout-unavailable-alternative',
  );
  expect(badAlternative).toBeDefined();
  expect(findCurrentStockOverclaims(badAlternative!.text, 312)).not.toEqual([]);

  const promise =
    '**We can supply 320 Redline Power Cell R12 units entirely from current stock.**';
  expect(findCurrentStockOverclaims(promise, 312)).toHaveLength(1);
  expect(findCurrentStockOverclaims(promise, 320)).toEqual([]);
  expect(
    findCurrentStockOverclaims('We can supply 1 unit from current stock.', 0),
  ).toHaveLength(1);
  expect(
    findCurrentStockOverclaims(
      'We can ship 1,000 units from current stock.',
      312,
    ),
  ).toHaveLength(1);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => findCurrentStockOverclaims(promise, invalid)).toThrow(
      RangeError,
    );
});
