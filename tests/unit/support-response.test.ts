import {
  orderSearchOutcome,
  shipmentOutcome,
  returnOutcome,
  supportRecords,
} from '../fixtures/support-outcomes';
import type { SupportRecordsContext } from '@/lib/support-outcomes';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  hasGroundedSupportIdentifiers,
  hasUnsupportedSableResource,
  unavailableRecordReply,
  unsupportedSableResources,
} from '@/lib/support-response';

const context = supportRecords([
  shipmentOutcome('SHP-2022-000012', 'AST-1234567890'),
  returnOutcome('RTN-2022-000014'),
  {
    kind: 'catalog_category',
    outcome: 'found',
    category: 'Cybernetics',
    retrievedAt: '2026-01-01T00:00:00Z',
    facts: [
      {
        item_number: 'SBL-DMK-A9',
        product_name: 'Fixture product',
        fulfillment_type: 'physical',
        unit_price_cents: 100,
        unit_label: 'unit',
        case_pack: 1,
        lead_time_days: 1,
        available: 8,
        inbound: 0,
      },
    ],
    verifiedReferences: [
      { namespace: 'item_number', identifier: 'SBL-DMK-A9' },
    ],
  },
]);

describe('support response identifier validation', () => {
  it('requires typed evidence at the validation boundary', () => {
    expectTypeOf(hasGroundedSupportIdentifiers)
      .parameter(1)
      .toEqualTypeOf<SupportRecordsContext>();
  });
  const customOrderContext = supportRecords([
    orderSearchOutcome('REVIEW-CUSTOM-PO', 'SOME-PO'),
  ]);

  it.each([
    'Order: REVIEW-CUSTOM-PO is delivered.',
    'Order ID: **review-custom-po** is delivered.',
    'Order number REVIEW-CUSTOM-PO; customer PO: SOME-PO.',
  ])('accepts the verified custom order ID in %s', (answer) => {
    expect(hasGroundedSupportIdentifiers(answer, customOrderContext)).toBe(
      true,
    );
  });

  it.each([
    'Order: REVIEW-CUSTOM-PO-X is delivered.',
    'Order ID: SOME-PO is delivered.',
    'Customer PO: REVIEW-CUSTOM-PO is delivered.',
    'Order ID: REVIEW-CUSTOM-PO; order ID: OTHER-CUSTOM-ID.',
  ])('rejects altered or misidentified custom references in %s', (answer) => {
    expect(hasGroundedSupportIdentifiers(answer, customOrderContext)).toBe(
      false,
    );
  });

  it('does not authorize a custom ID merely mentioned in event prose', () => {
    expect(
      hasGroundedSupportIdentifiers('Order ID: OTHER-CUSTOM-ID.', {
        ...customOrderContext,
        records:
          'Recent customer-safe events:\n- 2026-01-01: Discussed order OTHER-CUSTOM-ID.',
      }),
    ).toBe(false);
  });

  it('keeps patterned order IDs and POs in their recorded namespaces', () => {
    for (const answer of [
      'Customer PO: SBL-2022-000118.',
      'Order ID: CPD-PO-220118.',
    ])
      expect(hasGroundedSupportIdentifiers(answer, context)).toBe(false);
  });

  it.each([
    'Order: `REVIEW-CUSTOM-PO`; customer PO: `SOME-PO`.',
    'Order search: 1 matching order; listing all 1.\n- REVIEW-CUSTOM-PO / SOME-PO: delivered; created 2026-01-01; requested 2026-01-01; $1.00.',
    'Recent charge-account authorizations:\n- REVIEW-CUSTOM-PO: authorized; $1.00; authorization AUTH-CUSTOM; 2026-01-01.',
  ])('accepts typed custom IDs independently of prompt format', (records) => {
    expect(
      hasGroundedSupportIdentifiers('Order ID: REVIEW-CUSTOM-PO.', {
        ...customOrderContext,
        records,
      }),
    ).toBe(true);
  });

  it('checks custom PO references against complete authorized tokens', () => {
    const customContext = supportRecords([
      orderSearchOutcome('SBL-2026-000417', 'REVIEW-CUSTOM-PO'),
    ]);
    for (const content of [
      'Customer PO: **REVIEW-CUSTOM-PO**.',
      'Purchase order number REVIEW-CUSTOM-PO.',
    ])
      expect(hasGroundedSupportIdentifiers(content, customContext)).toBe(true);
    for (const content of [
      'Customer PO: REVIEW-CUSTOM-PO-X.',
      'PO: REVIEW-CUSTOM.',
      'Purchase order number OTHER-REFERENCE.',
    ])
      expect(hasGroundedSupportIdentifiers(content, customContext)).toBe(false);
    expect(
      hasGroundedSupportIdentifiers('What is your PO number?', customContext),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'PO: ABCD.',
        supportRecords([
          orderSearchOutcome('SBL-2026-000417', 'ABCD-EXTENDED'),
        ]),
      ),
    ).toBe(false);
    expect(hasGroundedSupportIdentifiers('PO: STATUS.', customContext)).toBe(
      false,
    );
    expect(
      hasGroundedSupportIdentifiers(
        'PO: STATUS.',
        supportRecords([orderSearchOutcome('SBL-2026-000417', 'STATUS')]),
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'PO: REVIEW-UNKNOWN-PO was not found.',
        supportRecords([
          {
            kind: 'order',
            outcome: 'unavailable',
            scope: {
              customerId: 'WHS-0427',
              displayName: 'Calder Pike Distribution',
            },
            reference: {
              kind: 'order',
              namespace: 'customer_po',
              identifier: 'REVIEW-UNKNOWN-PO',
            },
          },
        ]),
      ),
    ).toBe(true);
  });
  it.each([
    [
      'exact identifiers',
      'Return RTN-2022-000014 links to **SBL-2022-000118**, PO CPD-PO-220118.',
      true,
    ],
    ['extra zero regression', 'Linked order: SBL-2022-0000118', false],
    ['missing zero', 'Linked order: SBL-2022-00118', false],
    ['different valid order', 'Linked order: SBL-2022-000119', false],
    ['substring of an identifier', 'Item: SBL-DMK', false],
    ['altered customer PO', 'Customer PO: CPD-PO-220119', false],
    [
      'exact product and shipment',
      'SBL-DMK-A9 via SHP-2022-000012 (AST-1234567890).',
      true,
    ],
    ['no record claims', 'Which order would you like me to look up?', true],
    [
      'authorized identifiers in lowercase',
      'Return rtn-2022-000014 links to sbl-2022-000118 via shp-2022-000012.',
      true,
    ],
    ['altered identifier in lowercase', 'Linked order: sbl-2022-000119', false],
  ])('%s', (_label, answer, expected) => {
    expect(hasGroundedSupportIdentifiers(answer, context)).toBe(expected);
  });
});

describe('unavailable record replies', () => {
  const scope = "within Calder Pike Distribution's authorization scope.";
  const targets = [
    {
      kind: 'order',
      reference: {
        kind: 'order',
        namespace: 'order_id',
        identifier: 'SBL-2027-500023',
      },
      next: 'verify the order ID or provide an account PO number',
    },
    {
      kind: 'shipment',
      reference: {
        kind: 'shipment',
        namespace: 'shipment_id',
        identifier: 'SHP-2099-000001',
      },
      next: 'verify the shipment ID or tracking reference',
    },
    {
      kind: 'return',
      reference: {
        kind: 'return',
        namespace: 'return_id',
        identifier: 'RTN-2099-000001',
      },
      next: 'verify the return ID',
    },
  ] as const;
  it.each(targets)(
    'answers a missing $kind without mentioning other accounts',
    (target) => {
      const reply = unavailableRecordReply({
        kind: 'records',
        records: '',
        parts: [
          {
            ...target,
            outcome: 'unavailable',
            scope: {
              customerId: 'WHS-0427',
              displayName: 'Calder Pike Distribution',
            },
          },
        ],
      });
      expect(reply).toBe(
        `I cannot locate ${target.reference.identifier} ${scope} Please ${target.next}.`,
      );
      expect(reply).not.toMatch(/another|other|different/i);
    },
  );

  it.each([
    'Return: RTN-2022-000014; order: SBL-2022-000118.',
    'Order search for status delivered: 0 matching orders.',
    'No catalog item matching SBL-XYZ was found.',
    'No order matching SBL-2099-000001 is available within your authorization scope.',
  ])('does not infer a missing record from prompt text: %s', (records) => {
    expect(
      unavailableRecordReply({
        kind: 'records',
        records,
        parts: [],
      }),
    ).toBeNull();
  });
});

describe('unsupported SABLE resources', () => {
  const records = `<authorized_records>
Product: SBL-KTA-T7 — Kestrel Tendon Assembly T7; category Cybernetics.
</authorized_records>`;

  // Each sentence was generated by the live model in a retained baseline run.
  it.each([
    "Consult a certified medical or cybernetic technician authorized under SABLE's clinical guidelines.",
    "For authorized medical procedures, contact SABLE Systems' Clinical Integration Division directly.",
    'Refer to the official SABLE Systems Cybernetics Manual or contact a certified medical integrator.',
    "Consult a licensed medical professional or SABLE Systems' clinical support team.",
    'Please refer to the authorized support records for product specifications and safety guidelines.',
    'Any adjustment requires oversight by SABLE Systems’ clinical engineering team.',
    'It requires oversight by authorized healthcare providers and SABLE Systems’ medical integration team.',
    'Please contact SABLE Systems’ Medical Operations Division directly.',
    "It requires authorization from SABLE Systems' Medical Compliance Division and a certified clinical engineer.",
  ])('rejects %s', (sentence) => {
    expect(
      hasUnsupportedSableResource(
        `I cannot help with that. ${sentence}`,
        records,
      ),
    ).toBe(true);
  });

  it.each([
    'Consult a certified medical or bio-integration specialist.',
    'Consult a technician authorized under the device’s official medical guidelines.',
    'Such actions fall outside the scope of SABLE Systems support and may violate regulatory, safety, or ethical guidelines.',
    'Please consult a licensed medical professional or authorized healthcare provider.',
    "This is outside the scope of SABLE Systems' support or operational responsibilities.",
    'Order SBL-2022-000118 was delivered on 2022-07-01.',
  ])('allows %s', (sentence) => {
    expect(hasUnsupportedSableResource(sentence, records)).toBe(false);
  });

  it('lists each unsupported resource phrase for a corrective retry', () => {
    expect(
      unsupportedSableResources(
        "See the official SABLE Systems Cybernetics Manual or SABLE Systems' Medical Operations Division. Consult a licensed medical professional.",
        records,
      ),
    ).toEqual([
      'SABLE Systems Cybernetics Manual',
      "SABLE Systems' Medical Operations Division",
    ]);
    expect(
      unsupportedSableResources(
        'Consult a licensed medical professional.',
        records,
      ),
    ).toEqual([]);
  });

  it('allows a resource that the retrieved records name', () => {
    expect(
      hasUnsupportedSableResource(
        'See the SABLE Systems returns handbook for packing steps.',
        `${records}\nReturns handbook: pack each unit in its original case.`,
      ),
    ).toBe(false);
  });

  it('rejects unverified staff roles while allowing an explicitly named role', () => {
    for (const answer of [
      'Ask a SABLE Systems certified repair technician.',
      'Consult a SABLE-authorized specialist.',
      'Contact the COV-E service representative.',
      "Speak to SABLE Systems' clinical engineer.",
      "Ask SABLE Systems' returns liaison.",
      "Consult SABLE Systems' return policy.",
      'Follow the COV-E returns procedures.',
    ])
      expect(hasUnsupportedSableResource(answer, records), answer).toBe(true);
    expect(
      hasUnsupportedSableResource(
        'Consult a certified repair technician outside SABLE Systems.',
        records,
      ),
    ).toBe(false);
    const withRole = `${records}\nService technician: account repairs contact.`;
    expect(
      hasUnsupportedSableResource(
        'Contact the SABLE Systems service technician.',
        withRole,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedSableResource(
        'Contact the SABLE Systems clinical technician.',
        withRole,
      ),
    ).toBe(true);
    expect(
      hasUnsupportedSableResource(
        'See the SABLE Systems medical handbook.',
        `${records}\nReturns handbook: packing instructions.`,
      ),
    ).toBe(true);
    expect(
      hasUnsupportedSableResource(
        'See the SABLE Systems return policies.',
        `${records}\nReturn policy: returns stay closed.`,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedSableResource(
        'See the SABLE Systems medical policy.',
        `${records}\nReturn policy: returns stay closed.`,
      ),
    ).toBe(true);
  });
});
