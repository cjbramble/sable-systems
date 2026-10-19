import { describe, expect, it } from 'vitest';
import {
  itemReferences,
  parseSupportReferences,
} from '@/lib/support-references';
import { parseQuantityOccurrences } from '@/lib/support-quantities';

describe('support reference parsing', () => {
  it('retains normalized references and exact value spans in appearance order', () => {
    const message =
      'PO: **status**, order SBL-2026-000417; tracking: "shp-1234".';
    const { occurrences } = parseSupportReferences(message);
    expect(occurrences.map(({ reference }) => reference)).toEqual([
      { kind: 'order', namespace: 'customer_po', identifier: 'STATUS' },
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2026-000417' },
      {
        kind: 'shipment',
        namespace: 'tracking_reference',
        identifier: 'SHP-1234',
      },
    ]);
    expect(
      occurrences.map(({ start, end }) => message.slice(start, end)),
    ).toEqual(['status', 'SBL-2026-000417', 'shp-1234']);
  });

  it.each([
    'SBL-2099-900001',
    'SHP-2099-900001',
    'RTN-2099-900001',
    'SBL-RPC-12',
  ])('an explicit PO owns the entire %s value', (identifier) => {
    expect(
      parseSupportReferences(`Customer PO: ${identifier}.`).occurrences.map(
        ({ reference }) => reference,
      ),
    ).toEqual([{ kind: 'order', namespace: 'customer_po', identifier }]);
  });

  it.each([
    'customer PO: (SBL-2099-900001)',
    'customer PO (SBL-2099-900001)',
    'customer PO: [SBL-2099-900001]',
    'customer PO: ["SBL-2099-900001"]',
  ])('preserves explicit namespace through value wrappers in %s', (message) => {
    expect(
      parseSupportReferences(message).occurrences.map(
        ({ reference }) => reference,
      ),
    ).toEqual([
      {
        kind: 'order',
        namespace: 'customer_po',
        identifier: 'SBL-2099-900001',
      },
    ]);
  });

  it.each([
    'PO: SHP-2099-900001/SBL-2099-900001',
    'PO: RTN-2099-900001_EXTENDED',
    `PO: SHP-${'1'.repeat(41)}`,
    'What is my PO number?',
    'What is the order status?',
    'Where is the shipment?',
    'ABCD',
    '2026',
    'Return: No return recorded.',
    'Shipment: None.',
    'Shipment: in-transit.',
    'Where is shipment 24?',
    'Can I return 8 units?',
    'Can I return SBL-RPC-12?',
    'Please specify the shipment you mean by its shipment ID or tracking reference.',
    'Please specify which order you mean by its order ID or customer PO number.',
    'Provide the return ID and order ID.',
  ])(
    'does not invent a namespace or guess an unlabeled value in %s',
    (message) => {
      expect(parseSupportReferences(message).occurrences).toEqual([]);
    },
  );

  it('does not apply checkout PO length limits to record IDs or tracking references', () => {
    for (const [label, prefix, kind, namespace] of [
      ['order ID', 'SBL-2099-', 'order', 'order_id'],
      ['shipment ID', 'SHP-', 'shipment', 'shipment_id'],
      ['tracking reference', 'AST-', 'shipment', 'tracking_reference'],
      ['return ID', 'RTN-', 'return', 'return_id'],
    ]) {
      const identifier = `${prefix}${'1'.repeat(41)}`;
      expect(
        parseSupportReferences(`${label}: ${identifier}`).occurrences.map(
          ({ reference }) => reference,
        ),
      ).toEqual([{ kind, namespace, identifier }]);
    }
  });

  it('retains ordinary-word POs and unresolved generic order references', () => {
    expect(
      parseSupportReferences(
        'PO: STATUS; purchase order number "NUMBER"; find order REVIEW-CUSTOM-PO.',
      ).occurrences.map(({ reference }) => reference),
    ).toEqual([
      { kind: 'order', namespace: 'customer_po', identifier: 'STATUS' },
      { kind: 'order', namespace: 'customer_po', identifier: 'NUMBER' },
      {
        kind: 'order',
        namespace: 'unresolved',
        identifier: 'REVIEW-CUSTOM-PO',
      },
    ]);
  });
});

describe('order used as a verb', () => {
  const references = (message: string) =>
    parseSupportReferences(message).occurrences.map(
      ({ reference }) => reference,
    );

  it.each([
    'Can I order SBL-RPC-12?',
    'I want to order SBL-RPC-12 next week.',
    'Can I order 1000 of SBL-RPC-12?',
    'Please order SBL-RPC-12.',
    'Could we order 2400 of them?',
    'Did I order SBL-RPC-12 last year?',
    "I'd like to order SBL-AEG-4.",
    'What happens if I order SBL-RPC-12 today?',
    'Is order SBL-RPC-12 possible?',
  ])('does not read %j as an order record', (message) => {
    expect(
      references(message).filter((reference) => reference.kind === 'order'),
    ).toEqual([]);
  });

  it.each([
    [
      'Show order SBL-2026-000417.',
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2026-000417' },
    ],
    [
      'Can you check order ACME-7781?',
      { kind: 'order', namespace: 'unresolved', identifier: 'ACME-7781' },
    ],
    [
      'Can I see order number 4471?',
      { kind: 'order', namespace: 'order_id', identifier: '4471' },
    ],
    [
      'What happened to order ACME-7781?',
      { kind: 'order', namespace: 'unresolved', identifier: 'ACME-7781' },
    ],
    [
      'Can I order the items on order SBL-2026-000417 again?',
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2026-000417' },
    ],
  ])('still reads %j as an order record', (message, expected) => {
    expect(references(message)).toEqual([expected]);
  });
});

it('keeps a generic order label on a product during response validation', () => {
  expect(
    parseSupportReferences(
      'Order SBL-RPC-12 is delivered.',
      new Set(['SBL-RPC-12']),
    ).occurrences.map(({ reference }) => reference),
  ).toEqual([
    { kind: 'order', namespace: 'unresolved', identifier: 'SBL-RPC-12' },
  ]);
});

describe('reference labels on response evidence candidates', () => {
  const candidates = new Set([
    'SBL-MISSING-X',
    'SBL-RPC-12',
    'SHP-2099-900001',
  ]);

  it.each([
    [
      'Shipment SBL-MISSING-X was not found.',
      'shipment',
      'unresolved',
      'SBL-MISSING-X',
    ],
    [
      'Return SBL-MISSING-X was not found.',
      'return',
      'return_id',
      'SBL-MISSING-X',
    ],
    ['Shipment: **sbl-rpc-12**.', 'shipment', 'unresolved', 'SBL-RPC-12'],
    ['Return SHP-2099-900001.', 'return', 'return_id', 'SHP-2099-900001'],
    [
      'Please provide return ID SBL-MISSING-X.',
      'return',
      'return_id',
      'SBL-MISSING-X',
    ],
    [
      'Return SBL-MISSING-X to be processed tomorrow.',
      'return',
      'return_id',
      'SBL-MISSING-X',
    ],
  ])(
    'preserves the claimed namespace in %s',
    (message, kind, namespace, identifier) => {
      expect(
        parseSupportReferences(message, candidates).occurrences.map(
          ({ reference }) => reference,
        ),
      ).toEqual([{ kind, namespace, identifier }]);
    },
  );

  it.each([
    'Shipment: in-transit.',
    'Return: No return recorded.',
    'Can I return 8 units?',
    'The item SBL-MISSING-X was not found.',
    'To return SBL-RPC-12, please provide your order ID.',
    'If you want to return SBL-MISSING-X, please verify its item number.',
    'Please return SBL-RPC-12 to the warehouse.',
    'You can return SBL-RPC-12 in its original packaging.',
  ])('does not label ordinary prose or item echoes: %s', (message) => {
    expect(parseSupportReferences(message, candidates).occurrences).toEqual([]);
  });
});

describe('typographic hyphens in identifiers', () => {
  // U+2010 to U+2015 and U+2212, as pasted from PDFs and email.
  it.each([
    '\u2010',
    '\u2011',
    '\u2012',
    '\u2013',
    '\u2014',
    '\u2015',
    '\u2212',
  ])('reads an order ID typed with U+%s', (hyphen) => {
    const message = `Where is my order SBL${hyphen}2026${hyphen}0001?`;
    const { occurrences, remainder } = parseSupportReferences(message);
    expect(occurrences).toEqual([
      {
        reference: {
          kind: 'order',
          namespace: 'order_id',
          identifier: 'SBL-2026-0001',
        },
        start: 18,
        end: 31,
      },
    ]);
    expect(remainder).toHaveLength(message.length);
  });

  it('reads item numbers, shipment IDs, and return IDs', () => {
    expect(itemReferences('Is SBL\u2011RPC\u201112 in stock?')).toEqual([
      'SBL-RPC-12',
    ]);
    expect(
      parseSupportReferences(
        'Track SHP\u20132026\u2013000417 and RTN\u22120007.',
      ).occurrences.map(({ reference }) => reference.identifier),
    ).toEqual(['SHP-2026-000417', 'RTN-0007']);
  });

  it.each([
    'Ship \u22128 units',
    'Ship \u2013 8 units',
    'Ship 8\u201312 units',
  ])(
    'keeps a dash outside an identifier as part of the quantity: %s',
    (message) => {
      expect(parseQuantityOccurrences(message)).toEqual([
        expect.objectContaining({
          quantity: { kind: 'invalid', reason: 'syntax' },
        }),
      ]);
    },
  );
});
