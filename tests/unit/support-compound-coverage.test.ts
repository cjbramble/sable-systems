import { describe, expect, it } from 'vitest';
import { classifySupportQueries } from '@/lib/support-query';

const ask = (content: string) =>
  classifySupportQueries([{ role: 'user', content }]);

const order = {
  kind: 'order',
  namespace: 'order_id',
  identifier: 'SBL-2022-000118',
};
const account = { kind: 'account', includeCharges: true };

describe('ordered compound request coverage', () => {
  it.each([
    [
      'What are my payment terms? Show order SBL-2022-000118.',
      [account, order],
    ],
    [
      'Show order SBL-2022-000118. What are my payment terms?',
      [order, account],
    ],
    ['Show my account tier and order SBL-2022-000118.', [account, order]],
    ['Show order SBL-2022-000118 and my account tier.', [order, account]],
    [
      'What is my billing currency, and where is order SBL-2022-000118?',
      [account, order],
    ],
  ])('retains an independent account question: %s', (message, expected) => {
    expect(ask(message)).toMatchObject(expected);
  });

  it.each([
    [
      'Is SBL-RPC-12 available? Show order SBL-2022-000118.',
      ['catalog', 'order'],
    ],
    ['Check SBL-RPC-12 and order SBL-2022-000118.', ['catalog', 'order']],
    ['Check order SBL-2022-000118 and SBL-RPC-12.', ['order', 'catalog']],
    ['Show active orders. Show order SBL-2022-000118.', ['orders', 'order']],
    [
      'What are my payment terms? Show order SBL-2022-000118. Is SBL-RPC-12 in stock?',
      ['account', 'order', 'catalog'],
    ],
    [
      'Is SBL-RPC-12 in stock? What are my payment terms? Show order SBL-2022-000118.',
      ['catalog', 'account', 'order'],
    ],
  ])('preserves source order: %s', (message, expected) => {
    expect(ask(message).map(({ kind }) => kind)).toEqual(expected);
  });

  it.each([
    'Show the payment status of order SBL-2022-000118.',
    'Show order SBL-2022-000118. Payment terms apply to all orders.',
    'Show order SBL-2022-000118 with its billing currency.',
  ])('keeps descriptions attached to the named record: %s', (message) => {
    expect(ask(message)).toEqual([order]);
  });

  it('deduplicates account requests without changing record identity', () => {
    expect(
      ask(
        'What are my payment terms? Show order SBL-2022-000118. What is my billing currency?',
      ),
    ).toEqual([account, order]);
  });

  it('keeps products in an order filter separate from a catalog request', () => {
    const intents = ask(
      'Show active orders containing SBL-RPC-12. What are my payment terms? Show order SBL-2022-000118.',
    );
    expect(intents).toMatchObject([
      { kind: 'orders', message: expect.stringContaining('sbl-rpc-12') },
      account,
      order,
    ]);
  });
});

it('does not count a comparison cue as a separate product request', () => {
  expect(
    ask('Compare order SBL-2022-000118 with order SBL-2026-000417.'),
  ).toEqual([
    order,
    { kind: 'order', namespace: 'order_id', identifier: 'SBL-2026-000417' },
  ]);
});

it.each([
  'Show order SBL-2022-000118 and is it one of the cancelled orders?',
  'Show order SBL-2022-000118 and what are its payment terms?',
  'Show order SBL-2022-000118 and what are the payment terms for that order?',
])('keeps a dependent question with its named record: %s', (message) => {
  expect(ask(message)).toEqual([order]);
});

it('positions a full-name product comparison after the preceding record', () => {
  const intents = ask(
    'Show order SBL-2022-000118 and compare Redline Power Cell R12 with Signal-Weave Active Cable, 12 m.',
  );
  expect(intents.map(({ kind }) => kind)).toEqual(['order', 'catalog']);
});

it('keeps billing questions about the named record out of account retrieval', () => {
  expect(
    ask('Show order SBL-2022-000118. What is its billing currency?'),
  ).toEqual([order]);
});

it.each([
  [
    'Show order SBL-2022-000118 and availability of Coldstart Rack Controller R2.',
    ['order', 'catalog'],
  ],
  [
    'Compare Coldstart Rack Controller R2 with order SBL-2022-000118 and SBL-RPC-12.',
    ['catalog', 'order'],
  ],
])(
  'orders named catalog subjects by first mention: %s',
  (message, expected) => {
    expect(ask(message).map(({ kind }) => kind)).toEqual(expected);
  },
);

it('preserves an explicitly requested list with a definite article', () => {
  expect(
    ask('Show order SBL-2022-000118. Show the orders excluding cancelled.'),
  ).toMatchObject([
    order,
    {
      kind: 'orders',
      statusFilter: { kind: 'filter', exclude: ['cancelled'] },
    },
  ]);
});
