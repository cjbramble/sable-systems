import { describe, expect, it } from 'vitest';
import {
  classifySupportQueries,
  classifySupportQuery,
} from '@/lib/support-query';

const ask = (content: string) => [{ role: 'user' as const, content }];
const classify = (content: string) => classifySupportQuery(ask(content));
const filter = (include: string[], exclude: string[] = []) => ({
  kind: 'filter',
  include,
  exclude,
});

describe('order status filters', () => {
  it.each([
    ['scheduled', 'scheduled'],
    ['future', 'scheduled'],
    ['upcoming', 'scheduled'],
    ['confirmed', 'confirmed'],
    ['allocating', 'allocating'],
    ['backordered', 'backordered'],
    ['partially shipped', 'partially_shipped'],
    ['shipped', 'shipped'],
    ['delivered', 'delivered'],
    ['on-hold', 'on_hold'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['active', 'active'],
    ['open', 'active'],
  ])('keeps the positive %s filter', (wording, status) => {
    expect(classify(`Show my ${wording} orders.`)).toMatchObject({
      kind: 'orders',
      statusFilter: filter([status]),
    });
  });

  it.each([
    'Show orders that are delivered.',
    'Show orders with status delivered.',
  ])('recognizes an explicit status clause: %s', (message) => {
    expect(classify(message)).toMatchObject({
      statusFilter: filter(['delivered']),
    });
  });

  it.each([
    'Show orders that are not cancelled.',
    'Show my not cancelled orders.',
    'Show orders excluding cancelled.',
    'Show orders except cancelled.',
    'Show orders without cancelled.',
    'Show orders from 2026 containing SBL-RPC-12 that are not cancelled.',
  ])('retains exclusion rather than the positive keyword: %s', (message) => {
    expect(classify(message)).toMatchObject({
      kind: 'orders',
      statusFilter: filter([], ['cancelled']),
    });
  });

  it.each([
    [
      'Show shipped or partially shipped orders.',
      ['shipped', 'partially_shipped'],
      [],
    ],
    ['Show cancelled and delivered orders.', ['cancelled', 'delivered'], []],
    ['Show cancelled,delivered orders.', ['cancelled', 'delivered'], []],
    [
      'Show orders excluding cancelled and delivered.',
      [],
      ['cancelled', 'delivered'],
    ],
    [
      'Show orders except cancelled or delivered.',
      [],
      ['cancelled', 'delivered'],
    ],
    ['Show active orders excluding on hold.', ['active'], ['on_hold']],
    [
      'Show orders excluding cancelled that are not delivered.',
      [],
      ['cancelled', 'delivered'],
    ],
    ['Show orders that are not active.', [], ['active']],
    ['Show delivered or delivered orders.', ['delivered'], []],
  ])('preserves supported set operations: %s', (message, include, exclude) => {
    expect(classify(message)).toMatchObject({
      kind: 'orders',
      statusFilter: filter(include, exclude),
    });
  });

  it.each([
    'Show orders that are not cancelled or delivered.',
    'Show orders that are not cancelled or not delivered.',
    'Show orders that are not not cancelled.',
    'Show orders that are not yet shipped.',
    'Show orders with status pending.',
    'Show orders with status shipped-late.',
    'Show orders excluding pending.',
    'Show not only cancelled orders.',
    'Show delivered and not cancelled orders.',
    'Show orders; do not include cancelled.',
    'Show orders do not include cancelled.',
    "Show orders aren't cancelled.",
    'Show orders not shipped yet.',
    'Show orders not cancelled but delivered.',
  ])('keeps unsupported meaning explicit: %s', (message) => {
    expect(classify(message)).toMatchObject({
      kind: 'orders',
      statusFilter: { kind: 'clarification', reason: 'unsupported' },
    });
  });

  it.each([
    'Show cancelled orders excluding cancelled.',
    'Show cancelled orders that are not cancelled.',
    'Show active orders excluding active.',
    'Show orders excluding cancelled with status cancelled.',
  ])('clarifies an empty contradictory status selection: %s', (message) => {
    expect(classify(message)).toMatchObject({
      kind: 'orders',
      statusFilter: { kind: 'clarification', reason: 'contradictory' },
    });
  });

  it.each([
    'Show my orders.',
    'Show orders containing Signal-Weave Active Cable, 12 m.',
  ])('does not invent a status filter: %s', (message) => {
    const intent = classify(message);
    expect(intent.kind).toBe('orders');
    expect(intent).not.toHaveProperty('status');
    expect(intent).toHaveProperty('statusFilter', undefined);
  });

  it.each([
    'Show delivered orders; explain cancelled orders.',
    'Show delivered orders; please explain cancelled orders.',
    'Show delivered orders and explain orders excluding cancelled.',
  ])('ignores status words in a separate explanatory clause: %s', (message) => {
    expect(classify(message)).toMatchObject({
      statusFilter: filter(['delivered']),
    });
  });

  it.each([
    ['Show scheduled orders in 2030.', 'requested'],
    ['Show orders that are not scheduled in 2026.', 'created'],
    ['Show scheduled or confirmed orders in 2026.', 'created'],
    [
      'Show scheduled or confirmed orders in 2026 excluding confirmed.',
      'created',
    ],
    ['Show releases excluding cancelled in 2030.', 'requested'],
  ])(
    'keeps date semantics separate from excluded statuses: %s',
    (message, yearField) => {
      expect(classify(message)).toMatchObject({ kind: 'orders', yearField });
    },
  );

  it('keeps explicit record lookup separate from a requested filtered order list', () => {
    expect(
      classifySupportQueries(
        ask('Show order SBL-2022-000118 and orders excluding cancelled.'),
      ),
    ).toMatchObject([
      { kind: 'order', identifier: 'SBL-2022-000118' },
      { kind: 'orders', statusFilter: filter([], ['cancelled']) },
    ]);
    expect(
      classifySupportQueries(
        ask('Show order SBL-2022-000118 and orders with status pending.'),
      ),
    ).toMatchObject([
      { kind: 'order', identifier: 'SBL-2022-000118' },
      {
        kind: 'orders',
        statusFilter: { kind: 'clarification', reason: 'unsupported' },
      },
    ]);
  });

  it('retains a separately introduced order list with an adjective status', () => {
    expect(
      classifySupportQueries(
        ask('Show order SBL-2022-000118 and show active orders.'),
      ),
    ).toMatchObject([
      { kind: 'order', identifier: 'SBL-2022-000118' },
      { kind: 'orders', statusFilter: filter(['active']) },
    ]);
  });

  it.each([
    ['Show active orders and show order SBL-2022-000118.', filter(['active'])],
    [
      'Show orders excluding cancelled and order SBL-2022-000118.',
      filter([], ['cancelled']),
    ],
  ])(
    'retains a separately requested order list before a record: %s',
    (message, statusFilter) => {
      expect(classifySupportQueries(ask(message))).toMatchObject([
        { kind: 'order', identifier: 'SBL-2022-000118' },
        { kind: 'orders', statusFilter },
      ]);
    },
  );

  it('does not turn a description of named records into a separate order search', () => {
    expect(
      classifySupportQueries(
        ask('Show cancelled orders SBL-2022-000118 and SBL-2026-000417.'),
      ),
    ).toHaveLength(2);
    expect(
      classifySupportQueries(
        ask('Show cancelled orders SBL-2022-000118 and SBL-2026-000417.'),
      ).every((intent) => intent.kind === 'order'),
    ).toBe(true);
  });

  it('preserves reference ownership when only one named record repeats the order label', () => {
    const intents = classifySupportQueries(
      ask('Show cancelled orders SBL-2022-000118 and order SBL-2026-000417.'),
    );
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.kind === 'order')).toBe(true);
  });

  it('keeps an unsupported exclusion continuation attached to its order search', () => {
    expect(
      classifySupportQueries(
        ask(
          'Show order SBL-2022-000118 and show orders; do not include cancelled.',
        ),
      ),
    ).toMatchObject([
      { kind: 'order', identifier: 'SBL-2022-000118' },
      {
        kind: 'orders',
        statusFilter: { kind: 'clarification', reason: 'unsupported' },
      },
    ]);
  });
});
