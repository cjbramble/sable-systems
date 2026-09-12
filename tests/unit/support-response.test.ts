import { describe, expect, it } from 'vitest';

import { hasGroundedSupportIdentifiers } from '@/lib/support-response';

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
  ])('%s', (_label, answer, expected) => {
    expect(hasGroundedSupportIdentifiers(answer, context)).toBe(expected);
  });
});
