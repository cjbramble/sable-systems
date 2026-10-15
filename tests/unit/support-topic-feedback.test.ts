import { expect, it } from 'vitest';
import { classifySupportQueries } from '@/lib/support-query';

const ask = (message: string, previous = 'Show order SBL-2022-000118.') =>
  classifySupportQueries([
    { role: 'user', content: previous },
    { role: 'assistant', content: 'The requested records are available.' },
    { role: 'user', content: message },
  ]);

it.each([
  ['What is its status? Show my support incidents.', ['order', 'incidents']],
  ['Show my support incidents. What is its status?', ['incidents', 'order']],
  ['What is its status? Show my orders.', ['order', 'orders']],
  ['Show my orders. What is its status?', ['orders', 'order']],
  ['What is its status? What is my account tier?', ['order', 'account']],
  ['What is its status? Show shipment SHP-2022-000012.', ['order', 'shipment']],
])(
  'resolves the follow-up regardless of the other topic: %s',
  (message, kinds) => {
    const intents = ask(message);
    expect(intents.map(({ kind }) => kind)).toEqual(kinds);
    expect(intents.find(({ kind }) => kind === 'order')).toMatchObject({
      identifier: 'SBL-2022-000118',
      namespace: 'order_id',
    });
  },
);

it.each([
  ['Hello.', 'missing_target'],
  ['Show order SBL-2022-000118 and order SBL-2026-000417.', 'multiple_targets'],
])(
  'retains follow-up clarification with incident history: %s',
  (previous, reason) => {
    expect(
      ask('What is its status? Show my support incidents.', previous),
    ).toContainEqual(
      expect.objectContaining({ kind: 'clarification', reason }),
    );
  },
);

it('resolves a current-message target before falling back to older history', () => {
  expect(
    ask(
      'Show order SBL-2026-000417. What is its status? Show my support incidents.',
    ),
  ).toMatchObject([
    { kind: 'order', identifier: 'SBL-2026-000417' },
    { kind: 'incidents' },
  ]);
});

it('keeps an explicit account question despite a later incidental pronoun', () => {
  expect(
    ask(
      'What are my payment terms because I need them? Show my support incidents.',
    ).map(({ kind }) => kind),
  ).toEqual(['account', 'incidents']);
});

it.each([
  'Show my support incidents and my orders.',
  'Show our support incidents and our orders.',
  'Show my support incidents and my purchases.',
  'Show my support incidents and our releases from 2026.',
])('recognizes an owned order-search subject: %s', (message) => {
  expect(ask(message).map(({ kind }) => kind)).toEqual(['incidents', 'orders']);
});

it.each([
  'Show my support incidents for this year and SBL-RPC-12 availability.',
  'Show my support incidents with recent updates and availability of SBL-RPC-12.',
  'Show my support incidents about deliveries and SBL-RPC-12 stock.',
  'Show my support incidents for this year and Power availability.',
  'Show my support incidents regarding SBL-CSR-R2 and SBL-RPC-12 pricing.',
])(
  'keeps a separate catalog subject despite an incident qualifier: %s',
  (message) => {
    expect(ask(message).map(({ kind }) => kind)).toEqual([
      'incidents',
      'catalog',
    ]);
  },
);

it.each([
  'Show my support incidents about SBL-RPC-12 and SBL-CSR-R2.',
  'Show my support incidents for SBL-RPC-12 and SBL-CSR-R2.',
  'Show my support incidents regarding stock and availability.',
])('preserves coordinated incident product descriptions: %s', (message) => {
  expect(ask(message)).toEqual([{ kind: 'incidents' }]);
});
