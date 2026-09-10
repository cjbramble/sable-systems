import { expect, it } from 'vitest';
import { findPartialFulfillmentPromises } from '../assertions/partial-fulfillment';

it('keeps no attached to a coordinated unit list without hiding fulfillment promises elsewhere', () => {
  const refusals = [
    '310 units cannot be fulfilled due to ordering restriction; no partial units or broken cases are permitted.',
    'No broken cases or partial units are allowed.',
    'No partial units and broken cases can be shipped.',
    'No partial units, loose packs, or broken cases are permitted.',
    '**No partial units or broken cases** are permitted.',
    'No partial units can be shipped.',
    'No\npartial units can be shipped.',
    'No partial units can be shipped as loose units.',
    'No partial units\ncan be shipped as loose units.',
    'No partial units or broken cases can be shipped as loose units.',
    'Partial units cannot be fulfilled.',
    '310 units cannot be fulfilled as partial units.',
    'Partial units are not permitted.',
  ];
  for (const answer of refusals)
    expect(findPartialFulfillmentPromises(answer), answer).toEqual([]);

  const promises = [
    'Partial units or broken cases are permitted.',
    'Partial units and broken cases can still be shipped.',
    'Individual units are accepted.',
    'Loose packs may be supplied.',
    'Single units will be sold.',
    'The order can still be fulfilled as partial units.',
    '310 units may be processed as broken cases.',
    'There is no stock shortfall. Broken cases are permitted.',
    'Not only partial units but broken cases are permitted.',
    'No partial units are available, but the order can be fulfilled as broken cases.',
  ];
  for (const answer of promises)
    expect(findPartialFulfillmentPromises(answer), answer).not.toEqual([]);

  // Scope ends at punctuation, contrast, or a completed predicate. Keep only
  // the real promise, even if a negated coordinated list came before it.
  const contradictoryReplies = [
    'No partial units or broken cases are permitted. However, broken cases are allowed.',
    'No partial units or broken cases are permitted; broken cases are allowed.',
    'No partial units or broken cases are permitted, but broken cases are allowed.',
    'No partial units are permitted and broken cases are allowed.',
    'No partial units, but broken cases are allowed.',
    'No partial units\nBroken cases are allowed.',
    'Broken cases are allowed. No partial units or broken cases are permitted.',
  ];
  for (const answer of contradictoryReplies)
    expect(
      findPartialFulfillmentPromises(answer).map((claim) =>
        claim.toLowerCase(),
      ),
      answer,
    ).toEqual(['broken cases are allowed']);
});
