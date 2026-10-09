import { describe, expect, it } from 'vitest';
import {
  bindProductQuantities,
  parseQuantityOccurrences,
  type ProductMention,
} from '@/lib/support-quantities';

function mentions(
  message: string,
  products: [string, string][],
): ProductMention[] {
  return products.flatMap(([itemNumber, text]) =>
    Array.from(message.matchAll(new RegExp(text, 'g')), (match) => ({
      itemNumber,
      start: match.index,
      end: match.index + match[0].length,
    })),
  );
}

const products: [string, string][] = [
  ['A', 'SBL-RPC-12'],
  ['B', 'SBL-SWC-12'],
];
const bind = (message: string, targets = products) =>
  bindProductQuantities(
    message,
    parseQuantityOccurrences(message),
    mentions(message, targets),
  );
const assigned = (entries: [string, number][]) => ({
  kind: 'assigned',
  quantities: new Map(entries),
});

describe('complete numeric quantity expressions', () => {
  it.each([
    ['8', 8],
    ['1000', 1000],
    ['1,000', 1000],
    ['999,999', 999999],
  ])('reads %s without changing its magnitude', (raw, value) => {
    const message = `Are ${raw} units of SBL-RPC-12 available?`;
    expect(parseQuantityOccurrences(message)).toEqual([
      {
        start: 4,
        end: 4 + raw.length + ' units'.length,
        raw,
        quantity: { kind: 'valid', value },
      },
    ]);
  });

  it.each([
    '1.5',
    '.5',
    '-8',
    '+8',
    '−8',
    '8-12',
    '8—12',
    '8 to 12',
    '8 - 12',
    '1/2',
    '1e3',
    '1e+3',
    '1,00',
    '1,000,',
    '1 000',
  ])('rejects the whole unsupported expression %s', (raw) => {
    expect(parseQuantityOccurrences(`${raw} units of SBL-RPC-12`)).toEqual([
      {
        start: 0,
        end: raw.length + ' units'.length,
        raw,
        quantity: { kind: 'invalid', reason: 'syntax' },
      },
    ]);
  });

  it.each(['0', '000', '1000000', '1,000,000', '9999999999999999999999999999'])(
    'keeps out-of-range quantity %s explicit',
    (raw) => {
      expect(
        parseQuantityOccurrences(`${raw} units of SBL-RPC-12`),
      ).toMatchObject([
        { raw, quantity: { kind: 'invalid', reason: 'range' } },
      ]);
    },
  );

  it.each([
    'SBL-RPC-12 units',
    'SBL-ABC-123 units',
    'R12 units',
    '16 TB arrays',
    '16TB arrays',
    '32 GB modules',
    '512MB modules',
    '12 m cables',
  ])(
    'does not interpret model or capacity notation as a quantity: %s',
    (label) => {
      expect(parseQuantityOccurrences(`Are ${label} available?`)).toEqual([]);
      expect(
        parseQuantityOccurrences(`Are ${label} available for 24 units?`),
      ).toMatchObject([{ raw: '24', quantity: { kind: 'valid', value: 24 } }]);
    },
  );
});

describe('quantity assignment to product mentions', () => {
  it('represents absence separately from a numeric value', () => {
    expect(bind('Compare SBL-RPC-12 and SBL-SWC-12 availability.')).toEqual(
      assigned([]),
    );
  });

  it.each([
    'Compare 8 units of SBL-RPC-12 and 12 units of SBL-SWC-12.',
    'Are 12 units of SBL-SWC-12 and 8 units of SBL-RPC-12 available?',
    'SBL-RPC-12 (8 units) and SBL-SWC-12 (12 units): availability?',
  ])('attaches each quantity to its own product: %s', (message) => {
    expect(bind(message)).toEqual(
      assigned([
        ['A', 8],
        ['B', 12],
      ]),
    );
  });

  it.each([
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units each.',
    'Compare both SBL-RPC-12 and SBL-SWC-12 for 24 units.',
    'Are 24 units of both SBL-RPC-12 and SBL-SWC-12 available?',
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units per item.',
    'Compare both for 24 units SBL-RPC-12 SBL-SWC-12',
  ])('recognizes an explicit shared quantity: %s', (message) => {
    expect(bind(message)).toEqual(
      assigned([
        ['A', 24],
        ['B', 24],
      ]),
    );
  });

  it.each([
    'Are 8 units of SBL-RPC-12 available; what is SBL-SWC-12 pricing?',
    'Compare SBL-RPC-12 (8 units) with SBL-SWC-12.',
  ])(
    'leaves separately requested product facts without a quantity: %s',
    (message) => {
      expect(bind(message)).toEqual(assigned([['A', 8]]));
    },
  );

  it('binds quantities to full names, aliases, and repeated SKU mentions', () => {
    const message =
      '8 units of Redline Power Cell R12 (SBL-RPC-12) and 12 Switchwire units.';
    expect(
      bind(message, [
        ...products,
        ['A', 'Redline Power Cell R12'],
        ['B', 'Switchwire'],
      ]),
    ).toEqual(
      assigned([
        ['A', 8],
        ['B', 12],
      ]),
    );
  });

  it.each([
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units.',
    'Compare 8 units of SBL-RPC-12 versus SBL-SWC-12.',
    'Are 8 units total of both SBL-RPC-12 and SBL-SWC-12 available?',
    'Compare 8 units and 12 units of SBL-RPC-12.',
    'Compare 8 units of SBL-RPC-12 versus 12 units of SBL-RPC-12.',
    'Compare SBL-RPC-12 and SBL-SWC-12. Can we get 24 units?',
  ])('clarifies ambiguous or conflicting ownership: %s', (message) => {
    expect(bind(message)).toEqual({
      kind: 'clarification',
      reason: 'ambiguous',
    });
  });

  it('asks for a product when a quantity has no matched target', () => {
    expect(bind('Are 8 units available?')).toEqual({
      kind: 'clarification',
      reason: 'missing_target',
    });
  });

  it('never hides invalid quantities behind missing targets', () => {
    expect(bind('Are 1.5 units available?')).toEqual({
      kind: 'clarification',
      reason: 'syntax',
    });
  });
});

it.each([
  'Are 8 units of SBL-RPC-12 available, and what is the price for each SBL-SWC-12?',
  'Compare 8 units of SBL-RPC-12 and the price per item of SBL-SWC-12.',
])(
  'does not share a quantity because of unrelated later wording: %s',
  (message) => {
    expect(bind(message)).toEqual(assigned([['A', 8]]));
  },
);

it.each([
  'Compare 8 units of SBL-RPC-12 and SBL-SWC-12; show each item price.',
  'Compare both SBL-RPC-12 and SBL-SWC-12; can I get 8 units of SBL-RPC-12?',
])(
  'does not use a different clause to invent shared quantities: %s',
  (message) => {
    expect(bind(message)).toEqual({
      kind: 'clarification',
      reason: 'ambiguous',
    });
  },
);

it('limits an explicit shared quantity to the products in its clause', () => {
  expect(
    bind(
      'Are 8 units of both SBL-RPC-12 and SBL-SWC-12 available, and what is SBL-CSR-R2 pricing?',
      [...products, ['C', 'SBL-CSR-R2']],
    ),
  ).toEqual(
    assigned([
      ['A', 8],
      ['B', 8],
    ]),
  );
});
