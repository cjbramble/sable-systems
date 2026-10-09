import { describe, expect, it } from 'vitest';

import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';

const unavailable = {
  kind: 'order' as const,
  outcome: 'unavailable' as const,
  reference: {
    kind: 'order' as const,
    namespace: 'customer_po' as const,
    identifier: 'REVIEW-MISSING-PO',
  },
  scope: { customerId: 'WHS-0427', displayName: 'Calder Pike Distribution' },
};

describe('typed support outcomes', () => {
  it.each([
    [
      'Shipment: SHP-2099-960001; tracking: CUSTOM-TRACKING.',
      'Tracking reference CUSTOM-TRACKING.',
    ],
    ['Return: CUSTOM-RETURN, received.', 'Return ID: CUSTOM-RETURN.'],
  ])(
    'retains custom references from legacy record fields: %s',
    (records, answer) => {
      expect(
        hasGroundedSupportIdentifiers(answer, {
          kind: 'records',
          records: '',
          parts: [unavailable, { kind: 'legacy', records }],
        }),
      ).toBe(true);
    },
  );

  it.each(['SHP-2099-960001', 'LEGACY-SHIPMENT-960001'])(
    'keeps independently retrieved legacy shipment %s available in a mixed request',
    (identifier) => {
      const context = {
        kind: 'records' as const,
        records: '',
        parts: [
          {
            ...unavailable,
            reference: { ...unavailable.reference, identifier },
          },
          {
            kind: 'legacy' as const,
            records: `Shipment: ${identifier}; status: delivered.`,
          },
        ],
      };
      expect(
        hasGroundedSupportIdentifiers(
          `Shipment ID: ${identifier} was delivered.`,
          context,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ['SHP-2099-960001', 'Shipment SHP-2099-960001 was delivered.'],
    ['AST-2099-960001', 'Tracking reference AST-2099-960001 was delivered.'],
    ['RTN-2099-960001', 'Return RTN-2099-960001 was received.'],
  ])(
    'does not authorize another record kind from a missing PO %s',
    (identifier, answer) => {
      const context = {
        kind: 'records' as const,
        records: '',
        parts: [
          {
            ...unavailable,
            reference: { ...unavailable.reference, identifier },
          },
        ],
      };
      expect(hasGroundedSupportIdentifiers(answer, context)).toBe(false);
      expect(
        hasGroundedSupportIdentifiers(
          `Customer PO ${identifier} was not found.`,
          context,
        ),
      ).toBe(true);
    },
  );

  it.each([
    'Shipment ID: FORGED-CUSTOM-960001.',
    'Tracking reference FORGED-CUSTOM-960001.',
    'Return ID: FORGED-CUSTOM-960001.',
  ])('requires typed evidence for already parsed references: %s', (answer) => {
    expect(
      hasGroundedSupportIdentifiers(answer, {
        kind: 'records',
        records: '',
        parts: [unavailable],
      }),
    ).toBe(false);
  });

  it('matches a complete missing PO containing a patterned suffix', () => {
    const context = {
      kind: 'records' as const,
      records: '',
      parts: [
        {
          ...unavailable,
          reference: { ...unavailable.reference, identifier: 'MY-SBL-1234' },
        },
      ],
    };
    expect(
      hasGroundedSupportIdentifiers(
        'Customer PO MY-SBL-1234 was not found.',
        context,
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'Customer PO MY-SBL-1234-X was not found.',
        context,
      ),
    ).toBe(false);
  });

  it.each(['', '\n<authorized_records>\n\nDifferent presentation.\n'])(
    'answers an unavailable order independently of rendered records: %j',
    (records) => {
      expect(
        unavailableRecordReply({
          kind: 'records',
          records,
          parts: [unavailable],
        }),
      ).toBe(
        "I cannot locate REVIEW-MISSING-PO within Calder Pike Distribution's authorization scope. Please verify the order ID or provide an account PO number.",
      );
    },
  );

  it('retains unavailable references for namespace-aware echo only', () => {
    const context = {
      kind: 'records' as const,
      records: '',
      parts: [unavailable],
    };
    expect(
      hasGroundedSupportIdentifiers(
        'Customer PO: REVIEW-MISSING-PO was not found.',
        context,
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'Order ID: REVIEW-MISSING-PO was not found.',
        context,
      ),
    ).toBe(false);
    expect(
      hasGroundedSupportIdentifiers(
        'Customer PO: REVIEW-MISSING-PO-X was not found.',
        context,
      ),
    ).toBe(false);
  });

  it('does not turn a compound unavailable result into a single-record reply', () => {
    expect(
      unavailableRecordReply({
        kind: 'records',
        records: '',
        parts: [
          unavailable,
          { kind: 'legacy', records: 'Product: SBL-RPC-12' },
        ],
      }),
    ).toBeNull();
  });
});
