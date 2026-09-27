import { describe, expect, it } from 'vitest';

import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';

const context = `<authorized_records>
Return: RTN-2022-000014; order: SBL-2022-000118; customer PO: CPD-PO-220118.
Item: SBL-DMK-A9; shipment: SHP-2022-000012; tracking: AST-1234567890.
</authorized_records>`;

describe('support response identifier validation', () => {
  it('checks custom PO references against complete authorized tokens', () => {
    const customContext =
      'Order: SBL-2026-000417; customer PO: REVIEW-CUSTOM-PO; status: confirmed.';
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
      hasGroundedSupportIdentifiers('PO: ABCD.', 'Customer PO: ABCD-EXTENDED'),
    ).toBe(false);
    expect(hasGroundedSupportIdentifiers('PO: STATUS.', customContext)).toBe(
      false,
    );
    expect(
      hasGroundedSupportIdentifiers(
        'PO: STATUS.',
        'Customer PO: STATUS; status: confirmed.',
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'PO: REVIEW-UNKNOWN-PO was not found.',
        'No order matching REVIEW-UNKNOWN-PO is available within your authorization scope.',
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
  it.each([
    [
      'order',
      'SBL-2027-500023',
      'Please verify the order ID or provide an account PO number.',
    ],
    [
      'shipment',
      'SHP-2099-000001',
      'Please verify the shipment ID or tracking reference.',
    ],
    ['return', 'RTN-2099-000001', 'Please verify the return ID.'],
  ])(
    'answers a missing %s without mentioning other accounts',
    (kind, id, next) => {
      const context = `<authorized_records>
No ${kind} matching ${id} is available ${scope} Do not confirm or deny whether it belongs to another customer.
</authorized_records>`;
      const reply = unavailableRecordReply(context);
      expect(reply).toBe(`I cannot locate ${id} ${scope} ${next}`);
      expect(reply).not.toMatch(/another|other|different/i);
    },
  );

  it('leaves found records and other no-match contexts to the model', () => {
    expect(unavailableRecordReply(context)).toBeNull();
    expect(
      unavailableRecordReply(`<authorized_records>
Order search for status delivered: 0 matching orders.
- No matching orders.
</authorized_records>`),
    ).toBeNull();
    expect(
      unavailableRecordReply(`<authorized_records>
No catalog item matching SBL-XYZ was found. Ask the customer to verify the complete item number.
</authorized_records>`),
    ).toBeNull();
  });
});
