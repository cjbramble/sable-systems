import { expect, it } from 'vitest';
import { findPositiveStockShortfallClaims } from '../assertions/stock-shortfall';

it('distinguishes a requested-quantity explanation from a stock shortage without hiding contradictory claims', () => {
  const noShortage = [
    'Stock shortfall: 310 units cannot be fulfilled due to ordering restriction. The nearest valid quantity is 312 units.',
    'Stock shortfall: 310 units cannot be ordered due to ordering restriction.',
    'Stock shortfall: 310 units is not a valid order quantity because it is not a multiple of 8.',
    '**Stock shortfall:** 310 units cannot be ordered because of the case-pack rule.',
    "Stock shortfall: 310 units can't be accepted because of the case-pack restriction.",
    'Stock shortfall:\n- 310 units cannot be fulfilled as requested due to ordering restriction.\n- No stock shortfall exists.',
    'Stock shortfall: 0 units. Available stock is 312 units.',
    'There is no shortage of 8 units. This is a case-pack restriction.',
    'There is not a stock shortfall of 8 units.',
    'The product is not out of stock.',
    'The product isn’t out of stock.',
    'We are not 8 units short.',
  ];
  for (const answer of noShortage)
    expect(findPositiveStockShortfallClaims(answer, 310), answer).toEqual([]);

  const shortages = [
    'Stock shortfall: 8 units.',
    'Stock shortage is 8 units.',
    'There is a shortfall of 8 units.',
    'Shortfall 8.',
    'Stock shortfall: 310 units.',
    'Stock shortfall: 310 units are missing.',
    'Stock shortfall: 310 units cannot be fulfilled due to insufficient stock.',
    'Stock shortfall: 310 units cannot be fulfilled due to insufficient stock; the case-pack restriction also applies.',
    'Stock shortfall: 310 units cannot be fulfilled due to insufficient stock and the case-pack restriction.',
    'Stock shortfall: 8 units cannot be ordered due to ordering restriction.',
    'The product is out of stock.',
    'We are 8 units short.',
    'The stock is short by 8 units.',
    'There is an 8-unit stock shortfall.',
    'No stock shortfall exists. However, there is a shortage of 8 units.',
    'Stock shortfall: 310 units cannot be ordered due to ordering restriction; there is also a shortage of 8 units.',
    'Stock shortfall: 310 units cannot be ordered due to ordering restriction. The product is out of stock.',
    'We are not out of stock, but we are 8 units short.',
    'This is not only a shortage of 8 units; the case-pack rule also applies.',
  ];
  for (const answer of shortages)
    expect(findPositiveStockShortfallClaims(answer, 310), answer).not.toEqual(
      [],
    );

  // The exemption is for the actual request, not a hard-coded number or any
  // arbitrary number that happens to precede an ordering-restriction phrase.
  const differentRequest =
    'Stock shortfall: 318 units cannot be ordered due to ordering restriction.';
  expect(findPositiveStockShortfallClaims(differentRequest, 318)).toEqual([]);
  expect(findPositiveStockShortfallClaims(differentRequest, 310)).not.toEqual(
    [],
  );
});
