import { describe, expect, it } from 'vitest';
import { classifySupportQueries } from '@/lib/support-query';

const ask = (content: string) =>
  classifySupportQueries([{ role: 'user', content }]);
const kinds = (content: string) => ask(content).map(({ kind }) => kind);

describe('compound review regressions', () => {
  it.each([
    'Show my payment terms and SBL-RPC-12 availability. Show order SBL-2022-000118.',
    'What are my payment terms and SBL-RPC-12 availability? Show order SBL-2022-000118.',
    'Show my payment terms and availability of SBL-RPC-12. Show order SBL-2022-000118.',
  ])('retains account and catalog parts sharing a cue: %s', (message) => {
    expect(kinds(message)).toEqual(['account', 'catalog', 'order']);
  });

  it.each([
    'What is the status of order SBL-2022-000118 and my account tier?',
    'Where is order SBL-2022-000118 and my billing currency?',
    'Tell me about order SBL-2022-000118 and my payment terms.',
  ])(
    'shares a question cue with the coordinated account phrase: %s',
    (message) => {
      expect(kinds(message)).toEqual(['order', 'account']);
    },
  );

  it.each([
    'Tell me my payment terms because I need them.',
    'What is my billing currency so I can enter it?',
    'Show my payment terms because they are needed.',
  ])(
    'keeps incidental pronouns in an independent account request: %s',
    (question) => {
      expect(kinds(`Show order SBL-2022-000118. ${question}`)).toEqual([
        'order',
        'account',
      ]);
    },
  );

  it.each(['status of', 'delivery status of', 'details on'])(
    'does not use the record %s as a catalog position',
    (description) => {
      expect(
        kinds(
          `Check the ${description} order SBL-2022-000118 and availability of SBL-RPC-12.`,
        ),
      ).toEqual(['order', 'catalog']);
      expect(
        kinds(
          `Check the ${description} order SBL-2022-000118 and availability of Coldstart Rack Controller R2.`,
        ),
      ).toEqual(['order', 'catalog']);
    },
  );

  it.each([
    'Can you compare',
    'Please compare',
    'Could you please compare',
    'Show a comparison of',
  ])(
    'keeps polite record comparisons out of catalog retrieval: %s',
    (prefix) => {
      expect(
        kinds(
          `${prefix} order SBL-2022-000118 with order SBL-2026-000417 and shipment SHP-2022-000012?`,
        ),
      ).toEqual(['order', 'order', 'shipment']);
    },
  );

  it('preserves all product filters inside a requested order search', () => {
    const intents = ask(
      'Show active orders containing SBL-RPC-12 and SBL-SWC-12. Show order SBL-2022-000118.',
    );
    expect(intents.map(({ kind }) => kind)).toEqual(['orders', 'order']);
    expect(intents[0]).toMatchObject({
      message: expect.stringContaining('sbl-rpc-12 and sbl-swc-12'),
    });
  });

  it.each([
    'What are its payment terms?',
    'What are the payment terms for it?',
    'What is the billing currency of that order?',
  ])('keeps record-dependent account descriptions attached: %s', (question) => {
    expect(kinds(`Show order SBL-2022-000118. ${question}`)).toEqual(['order']);
  });
});

it('keeps account vocabulary inside an order search filter', () => {
  expect(
    kinds(
      'Show active orders with billing currency USD and containing SBL-RPC-12. Show order SBL-2022-000118.',
    ),
  ).toEqual(['orders', 'order']);
});

it.each(['SBL-RPC-12', 'Coldstart Rack Controller R2'])(
  'retains a catalog question after a period: %s',
  (target) => {
    expect(
      kinds(`Show order SBL-2022-000118. Check ${target} availability.`),
    ).toEqual(['order', 'catalog']);
  },
);

it.each([
  'What billing currency is it in?',
  'Tell me what payment terms apply to it.',
])(
  'keeps pronouns that own account fields attached to the named record: %s',
  (question) => {
    expect(kinds(`Show order SBL-2022-000118. ${question}`)).toEqual(['order']);
  },
);

it.each([
  'Please, compare order SBL-2022-000118 with order SBL-2026-000417 and shipment SHP-2022-000012?',
  'Compare order SBL-2022-000118 with order SBL-2026-000417 and shipment SHP-2022-000012, please.',
])('does not use politeness as a catalog subject: %s', (message) => {
  expect(kinds(message)).toEqual(['order', 'order', 'shipment']);
});

it('keeps a pronoun referring to an explicitly requested account fact', () => {
  expect(
    kinds(
      'Show order SBL-2022-000118. Tell me my account tier and its benefits.',
    ),
  ).toEqual(['order', 'account']);
});
