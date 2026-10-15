import { expect, it } from 'vitest';
import { classifySupportQueries } from '@/lib/support-query';

const ask = (content: string) =>
  classifySupportQueries([{ role: 'user', content }]);

it.each([
  [
    'What are my payment terms? Is SBL-RPC-12 available?',
    ['account', 'catalog'],
  ],
  [
    'Is SBL-RPC-12 available? What are my payment terms?',
    ['catalog', 'account'],
  ],
  [
    'Show my payment terms and SBL-RPC-12 availability.',
    ['account', 'catalog'],
  ],
  ['Show SBL-RPC-12 availability and my account tier.', ['catalog', 'account']],
  ['Show active orders. What are my payment terms?', ['orders', 'account']],
  ['What are my payment terms? Show my orders.', ['account', 'orders']],
  ['Show orders from 2026. Is SBL-RPC-12 in stock?', ['orders', 'catalog']],
  [
    'Show my support incidents. What are my payment terms?',
    ['incidents', 'account'],
  ],
  [
    'What are my payment terms? Show my support incidents.',
    ['account', 'incidents'],
  ],
  [
    'Show my support incidents and SBL-RPC-12 availability.',
    ['incidents', 'catalog'],
  ],
  [
    'Show SBL-RPC-12 availability and my support incidents.',
    ['catalog', 'incidents'],
  ],
  ['Show my payment terms and my support incidents.', ['account', 'incidents']],
  ['Show my orders and my support incidents.', ['orders', 'incidents']],
  [
    'Show my support incidents. Show active orders. What are my payment terms? Is SBL-RPC-12 available?',
    ['incidents', 'orders', 'account', 'catalog'],
  ],
  [
    'Show order SBL-2022-000118. Show my support incidents.',
    ['order', 'incidents'],
  ],
  ['Show order SBL-2022-000118. Show my orders.', ['order', 'orders']],
])('retains independent topics in source order: %s', (message, kinds) => {
  expect(ask(message).map(({ kind }) => kind)).toEqual(kinds);
});

it('deduplicates account and incident requests while preserving distinct searches', () => {
  expect(
    ask(
      'What are my payment terms? Show my support incidents. What is my account tier? Show my incident history. Show active orders. Show cancelled orders.',
    ).map(({ kind }) => kind),
  ).toEqual(['account', 'incidents', 'orders', 'orders']);
});

it('keeps products in an order filter separate from catalog quantities', () => {
  const intents = ask(
    'Show active orders containing SBL-RPC-12 and SBL-CSR-R2. What are my payment terms? Are 16 units of SBL-RPC-12 available?',
  );
  expect(intents).toMatchObject([
    { kind: 'orders', message: expect.stringContaining('sbl-csr-r2') },
    { kind: 'account' },
    { kind: 'catalog' },
  ]);
  const catalog = intents[2];
  if (catalog.kind !== 'catalog') throw new Error('Missing catalog intent');
  expect(catalog.message).not.toContain('sbl-csr-r2');
  expect(catalog.message).not.toContain('payment terms');
  expect(catalog.quantities).toHaveLength(1);
});

it.each([
  ['Show my support incidents about SBL-RPC-12.', 'incidents'],
  ['Show orders containing SBL-RPC-12 and SBL-CSR-R2.', 'orders'],
  ['What are my payment terms and billing currency?', 'account'],
  ['Compare SBL-RPC-12 with SBL-CSR-R2.', 'catalog'],
  ['Show active orders. Inventory changes daily.', 'orders'],
])('keeps single-topic descriptions together: %s', (message, kind) => {
  expect(ask(message).map((intent) => intent.kind)).toEqual([kind]);
});

it.each([
  'Show my support incidents about SBL-RPC-12 and SBL-CSR-R2.',
  'Show my support incidents regarding stock and availability.',
  'Show my support incidents for SBL-RPC-12 and SBL-CSR-R2.',
])('retains incident descriptions as one request: %s', (message) => {
  expect(ask(message)).toEqual([{ kind: 'incidents' }]);
});

it('preserves missing-target clarification in a mixed follow-up', () => {
  expect(ask('What are my payment terms? Is it available?')).toMatchObject([
    { kind: 'clarification', reason: 'missing_target' },
  ]);
});

it('retains a resolved product target across an independent account request', () => {
  const intents = classifySupportQueries([
    { role: 'user', content: 'Show SBL-RPC-12.' },
    { role: 'assistant', content: 'The item has stock available.' },
    {
      role: 'user',
      content: 'What are my payment terms? Are 16 units of it available?',
    },
  ]);
  expect(intents).toMatchObject([
    { kind: 'account' },
    { kind: 'catalog', message: expect.stringContaining('sbl-rpc-12') },
  ]);
});

it('retains a resolved order follow-up alongside an independent account request', () => {
  const intents = classifySupportQueries([
    { role: 'user', content: 'Show order SBL-2022-000118.' },
    { role: 'assistant', content: 'The order was delivered.' },
    { role: 'user', content: 'What are my payment terms? What is its status?' },
  ]);
  expect(intents).toMatchObject([
    { kind: 'account' },
    { kind: 'order', identifier: 'SBL-2022-000118' },
  ]);
});
