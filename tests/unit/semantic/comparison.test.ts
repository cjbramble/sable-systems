import { expect, it } from 'vitest';
import fixture from '../../fixtures/semantic/comparison.json';

// Independently authored oracle for the 2026-09-02 test inventory. Do not derive
// these facts from generated answers or the fixture being checked.
const expectedFacts = [
  { item: 'SBL-CSR-R2', price: 2250, pack: 4, lead: 90, available: 0 },
  { item: 'SBL-RPC-12', price: 680, pack: 8, lead: 18, available: 312 },
];
const productNames: Record<string, string> = {
  'SBL-CSR-R2': 'Coldstart Rack Controller R2',
  'SBL-RPC-12': 'Redline Power Cell R12',
  'SBL-BCH-V3': 'Blackchannel Haptic Controller',
};
const sorted = (facts: typeof expectedFacts) =>
  [...facts].sort((a, b) => a.item.localeCompare(b.item));

// Only the fixture's authored, labeled one-product-per-line format is supported.
// This is not a general natural-language or live model-response judge.
function labeledFacts(text: string) {
  return sorted(
    text.split('\n').flatMap((line) => {
      const items = line.match(/\bSBL-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) ?? [];
      const item = items[0];
      if (item === undefined) return [];
      expect(items, 'One item per authored product line').toHaveLength(1);
      expect(productNames[item], 'Known product identity').toBeDefined();
      expect(line).toContain(productNames[item]);
      expect(line).toMatch(/\blead time:\s*\d+\s+days\b/i);
      const number = (label: string, money = false) => {
        const matches = [
          ...line.matchAll(
            new RegExp(
              `\\b${label}:\\s*${money ? '\\$' : ''}([\\d,]+(?:\\.\\d+)?)\\b`,
              'gi',
            ),
          ),
        ];
        expect(matches, `One ${label} for ${item}`).toHaveLength(1);
        return Number(matches[0][1].replaceAll(',', ''));
      };
      return [
        {
          item,
          price: number('price', true),
          pack: number('case pack'),
          lead: number('lead time'),
          available: number('available units'),
        },
      ];
    }),
  );
}

function expectFixtureIntegrity(candidate: typeof fixture) {
  expect(candidate.schemaVersion).toBe(1);
  expect(candidate.scenario).toBe('coldstart-redline-comparison');
  expect(candidate.question).toBe(
    'Compare Coldstart Rack Controller R2 versus Redline Power Cell R12. Use one line per product with these labeled fields: item number, price, case pack, lead time, available units.',
  );
  expect(candidate.references).toHaveLength(2);
  expect(candidate.examples).toHaveLength(12);
  const texts = [
    ...candidate.references,
    ...candidate.examples.map((row) => row.text),
  ];
  expect(texts.every((text) => typeof text === 'string' && text.trim())).toBe(
    true,
  );
  const normalized = texts.map((text) =>
    text.toLowerCase().replace(/\s+/g, ' ').trim(),
  );
  expect(
    new Set(normalized).size,
    'No repeated reference/calibration/holdout text',
  ).toBe(texts.length);
  expect(new Set(candidate.examples.map((row) => row.id)).size).toBe(12);
  for (const row of candidate.examples) {
    expect(row.id).toMatch(/^[a-z][a-z0-9-]+$/);
    expect(typeof row.correct).toBe('boolean');
    expect(['calibration', 'holdout']).toContain(row.split);
    expect(row.correct).toBe(row.kind === 'paraphrase');
  }
  const negativeKinds: Record<string, string[]> = {
    calibration: ['off_topic', 'swapped_availability', 'wrong_price'],
    holdout: ['unrequested_product', 'wrong_case_pack', 'wrong_lead_time'],
  };
  for (const split of ['calibration', 'holdout']) {
    const examples = candidate.examples.filter((row) => row.split === split);
    expect(examples).toHaveLength(6);
    expect(examples.filter((row) => row.correct)).toHaveLength(3);
    expect(
      examples
        .filter((row) => !row.correct)
        .map((row) => row.kind)
        .sort(),
    ).toEqual(negativeKinds[split]);
  }
  for (const text of [
    ...candidate.references,
    ...candidate.examples.filter((row) => row.correct).map((row) => row.text),
  ]) {
    expect(labeledFacts(text), text).toEqual(expectedFacts);
    expect(text).toContain('Coldstart Rack Controller R2');
    expect(text).toContain('Redline Power Cell R12');
    expect(text).not.toMatch(/Blackchannel|Haptic|\bWHS-\d{4}\b/i);
  }
  // Check the intentional defect, not merely that a negative differs in wording.
  const negativeFacts: Record<string, typeof expectedFacts> = {
    wrong_price: [{ ...expectedFacts[0], price: 225 }, expectedFacts[1]],
    swapped_availability: [
      { ...expectedFacts[0], available: 312 },
      { ...expectedFacts[1], available: 0 },
    ],
    off_topic: [],
    wrong_case_pack: [expectedFacts[0], { ...expectedFacts[1], pack: 4 }],
    wrong_lead_time: [{ ...expectedFacts[0], lead: 9 }, expectedFacts[1]],
    unrequested_product: sorted([
      ...expectedFacts,
      { item: 'SBL-BCH-V3', price: 1460, pack: 4, lead: 24, available: 134 },
    ]),
  };
  for (const row of candidate.examples.filter((example) => !example.correct)) {
    expect(labeledFacts(row.text), row.id).toEqual(negativeFacts[row.kind]);
  }
}

it('keeps comparison references grounded and calibration/holdout examples distinct and correctly labeled', () => {
  expectFixtureIntegrity(fixture);

  // In-memory corruption controls: never alter retained transcripts or model data.
  const duplicate = structuredClone(fixture);
  duplicate.examples[6].text = `  ${duplicate.examples[0].text.toUpperCase()}  `;
  expect(() => expectFixtureIntegrity(duplicate)).toThrow('repeated');
  const relabeled = structuredClone(fixture);
  relabeled.examples.find((row) => row.kind === 'wrong_price')!.correct = true;
  expect(() => expectFixtureIntegrity(relabeled)).toThrow();
  const wrongPrice = structuredClone(fixture);
  wrongPrice.references[0] = wrongPrice.references[0].replace(
    '$2,250.00',
    '$225.00',
  );
  expect(() => expectFixtureIntegrity(wrongPrice)).toThrow();
  const wrongUnit = structuredClone(fixture);
  wrongUnit.references[0] = wrongUnit.references[0].replace(
    '90 days',
    '90 hours',
  );
  expect(() => expectFixtureIntegrity(wrongUnit)).toThrow();
  const wrongName = structuredClone(fixture);
  wrongName.references[0] = wrongName.references[0].replace(
    'Coldstart Rack Controller R2',
    'Redline Power Cell R12',
  );
  expect(() => expectFixtureIntegrity(wrongName)).toThrow();
  const repairedNegative = structuredClone(fixture);
  const negative = repairedNegative.examples.find(
    (row) => row.kind === 'wrong_lead_time',
  )!;
  negative.text = negative.text.replace(
    'lead time: 9 days',
    'lead time: 90 days',
  );
  expect(() => expectFixtureIntegrity(repairedNegative)).toThrow();
});
