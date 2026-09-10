import { expect, it } from 'vitest';
import { findIncorrectNearestCasePackClaims } from '../assertions/nearest-case-pack';

it('rejects incorrect nearest case-pack claims without rejecting valid alternatives or directional rounding', () => {
  const incorrect = [
    'The nearest valid multiple of 8 (304 units, which is 38 cases).',
    'Adjust to the nearest valid case-pack multiple (304 units, which is 38 cases of 8).',
    'The closest valid order is 304 units (38 cases), which is within available stock.',
    'The nearest valid multiple of 8 (e.g., 304 or 312 units).',
    'The closest valid quantity is 312 or 304 units.',
    '**304 units** is the nearest valid quantity.',
    'The nearest valid quantity to 310 is 304 units.',
    'The nearest valid quantity is 320 units.',
    '304 units is not the closest valid quantity. The nearest valid quantity is 320 units.',
  ];
  for (const answer of incorrect) {
    const issues = findIncorrectNearestCasePackClaims(answer, 310, 8);
    expect(issues, answer).toHaveLength(1);
    expect(issues[0].expectedQuantities, answer).toEqual([312]);
    expect(issues[0].claimedQuantity, answer).toBe(
      answer.includes('320') ? 320 : 304,
    );
  }

  const correct = [
    'The nearest valid quantity is 312 units, only 2 units from 310.',
    'The closest valid order is 312 units (39 cases).',
    '312 units is the nearest valid quantity to 310.',
    'Adjust to the nearest full multiple of 8 (e.g., 312 units = 39 cases).',
    'Either 304 or 312 units is a valid alternative; 312 is closer to 310.',
    'The nearest lower valid quantity is 304 units.',
    'The nearest higher valid quantity is 312 units.',
    '304 units is the nearest lower valid quantity.',
    '304 units is not the nearest valid quantity. The nearest valid quantity is 312.',
    'The nearest valid quantity is not 304; it is 312 units.',
    'The nearest valid quantity is 312, not 304 units.',
    'The available stock is 312 units; 310 is invalid for packs of 8. Adjust to 304 or 312.',
  ];
  for (const answer of correct)
    expect(findIncorrectNearestCasePackClaims(answer, 310, 8), answer).toEqual(
      [],
    );

  for (const [direction, claimedQuantity, expectedQuantity] of [
    ['lower', 312, 304],
    ['higher', 304, 312],
  ] as const) {
    expect(
      findIncorrectNearestCasePackClaims(
        `The nearest ${direction} valid quantity is ${claimedQuantity} units.`,
        310,
        8,
      ),
    ).toMatchObject([
      { claimedQuantity, expectedQuantities: [expectedQuantity] },
    ]);
  }

  // An equidistant choice may legitimately have two nearest quantities.
  expect(
    findIncorrectNearestCasePackClaims(
      'The nearest valid quantities are 304 and 312 units.',
      308,
      8,
    ),
  ).toEqual([]);
  expect(
    findIncorrectNearestCasePackClaims(
      'The nearest valid quantities are 296 and 320 units.',
      308,
      8,
    ).map(({ claimedQuantity, expectedQuantities }) => ({
      claimedQuantity,
      expectedQuantities,
    })),
  ).toEqual([
    { claimedQuantity: 296, expectedQuantities: [304, 312] },
    { claimedQuantity: 320, expectedQuantities: [304, 312] },
  ]);
});

it('rejects contradictory nearest-quantity lists while respecting list boundaries', () => {
  const contradictory = `2. Case-pack validity:
   - Valid nearest quantities:
     - 304 units (38 cases) — 6 units below requested
     - 312 units (39 cases) — 2 units above requested
   - Nearest valid quantity: 312 units (smallest absolute difference).`;
  const issues = findIncorrectNearestCasePackClaims(contradictory, 310, 8);
  expect(issues).toMatchObject([
    { claimedQuantity: 304, expectedQuantities: [312] },
  ]);
  expect(issues).toHaveLength(1);
  expect(issues[0].claim).toContain('Valid nearest quantities');

  for (const answer of [
    '**Nearest valid quantities:**\n- 312 units\n- 304 units\n\nThe nearest valid quantity is 312 units.',
    '### Closest valid quantities\n+ 304 units (38 cases)\n+ 312 units (39 cases)',
    '* **Valid nearest quantities:**\n  * **304 units** (38 cases)\n  * 312 units (39 cases)',
    'Nearest valid quantities:\n1. 312 units\n2. 304 units',
  ]) {
    expect(
      findIncorrectNearestCasePackClaims(answer, 310, 8),
      answer,
    ).toMatchObject([{ claimedQuantity: 304, expectedQuantities: [312] }]);
    expect(
      findIncorrectNearestCasePackClaims(answer, 310, 8),
      answer,
    ).toHaveLength(1);
  }

  for (const answer of [
    'Valid alternatives:\n- 304 units\n- 312 units\n\nThe nearest valid quantity is 312 units.',
    'Nearest valid quantities:\n- 312 units (39 cases)\n\nOther valid alternatives:\n- 304 units (38 cases)',
    'Nearest valid quantities:\n  - 312 units\n  Other valid alternatives:\n  - 304 units',
    'Nearest valid quantities:\n- 312 units\n  ### Other valid alternatives\n- 304 units',
    '- Nearest valid quantities:\n  - 312 units\n- Valid alternatives:\n  - 304 units',
    '- Nearest valid quantities:\n  - 312 units\n- 304 units is a lower valid alternative.',
    'Nearest valid quantities:\n1. 312 units (39 cases)\n\nOther quantities:\n1. 304 units',
    'Nearest valid quantities:\n* **312 units** (39 cases)\n\nOther quantities:\n* 304 units',
    'Nearest valid quantities:\n- 312 units\n  - 39 cases\n  - 2 units above requested',
    'Not nearest quantities:\n- 304 units\n\nNearest valid quantities:\n- 312 units',
    'Nearest lower valid quantities:\n- 304 units\n\nNearest higher valid quantities:\n- 312 units',
  ])
    expect(findIncorrectNearestCasePackClaims(answer, 310, 8), answer).toEqual(
      [],
    );

  expect(
    findIncorrectNearestCasePackClaims(
      'Nearest lower valid quantities:\n- 312 units',
      310,
      8,
    ),
  ).toMatchObject([{ claimedQuantity: 312, expectedQuantities: [304] }]);
  expect(
    findIncorrectNearestCasePackClaims(
      'Equally nearest valid quantities:\n- 304 units\n- 312 units',
      308,
      8,
    ),
  ).toEqual([]);
});
