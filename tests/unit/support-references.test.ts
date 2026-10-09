import { describe, expect, it } from 'vitest';
import { parseSupportReferences } from '@/lib/support-references';

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
