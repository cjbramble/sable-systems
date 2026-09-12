import { expect, it } from 'vitest';
import { classifySupportQuery } from '@/lib/support-query';
import { parseCustomerPo } from '@/lib/support-references';

it('shares the checkout PO contract and recognizes explicitly supplied references', () => {
  for (const po of [
    'abcd',
    '2026',
    'review-custom-po',
    'A--B',
    'Z'.repeat(40),
    'STATUS',
    'NUMBER',
  ]) {
    expect(parseCustomerPo(` ${po} `)).toBe(po.toUpperCase());
    expect(
      classifySupportQuery([
        { role: 'user', content: `Find customer PO: **${po}**.` },
      ]),
    ).toEqual({ kind: 'order', identifier: po.toUpperCase() });
  }
  for (const po of [
    '',
    'abc',
    'A'.repeat(41),
    '-ABC',
    'PO_123',
    'PO/123',
    'two words',
  ])
    expect(parseCustomerPo(po)).toBeNull();
  for (const content of [
    'Find order REVIEW-CUSTOM-PO.',
    'Find purchase order number "REVIEW-CUSTOM-PO".',
    'Customer PO is REVIEW-CUSTOM-PO.',
  ])
    expect(classifySupportQuery([{ role: 'user', content }])).toEqual({
      kind: 'order',
      identifier: 'REVIEW-CUSTOM-PO',
    });
  for (const content of [
    'What is my PO number?',
    'What is the order status?',
    'Tell me about this warehouse.',
  ])
    expect(classifySupportQuery([{ role: 'user', content }]).kind).not.toBe(
      'order',
    );
});

it('prioritizes current targets and keeps genuinely referential follow-ups', () => {
  const previous = [
    { role: 'user' as const, content: 'Show SBL-2026-000417.' },
  ];
  for (const content of [
    'Is SBL-RPC-12 available at this warehouse?',
    'Tell me about sbl-rpc-123.',
    'Is Redline Power Cell R12 available at this warehouse?',
  ])
    expect(
      classifySupportQuery([...previous, { role: 'user', content }]).kind,
    ).toBe('catalog');
  for (const content of [
    'What is its status?',
    'What is the total for that order?',
    'What currency is that order billed in?',
  ])
    expect(
      classifySupportQuery([...previous, { role: 'user', content }]),
    ).toEqual({ kind: 'order', identifier: 'SBL-2026-000417' });
  expect(
    classifySupportQuery([
      ...previous,
      { role: 'user', content: 'Tell me about SBL-RPC-12.' },
      { role: 'user', content: 'Is it available at this warehouse?' },
    ]),
  ).toMatchObject({
    kind: 'catalog',
    message: 'is it available at this warehouse? sbl-rpc-12',
    includeLocations: true,
  });
  expect(
    classifySupportQuery([
      ...previous,
      { role: 'user', content: 'Find order SBL-2026-000417-X.' },
    ]),
  ).toEqual({ kind: 'order', identifier: 'SBL-2026-000417-X' });
});

it('ignores numeric item-number suffixes while retaining explicit catalog quantities', () => {
  const scenarios: [content: string, quantity: number | undefined][] = [
    ['How many SBL-RPC-12 units are available?', undefined],
    ['Are SBL-HXB-09 modules available?', undefined],
    ['Are SBL-AEG-4 security nodes in stock?', undefined],
    ['Are sbl-swc-12 interface units available?', undefined],
    // Parsing must not depend on whether the item exists in the catalog.
    ['Are SBL-ABC-123 units available?', undefined],
    ['How many Redline Power Cell R12 units are available?', undefined],
    ['Are 16 TB arrays available?', undefined],
    ['Are 16TB arrays available?', undefined],
    ['Are 16 units of SBL-RPC-12 available?', 16],
    ['Are 8 modules of SBL-HXB-09 available?', 8],
    // Skip the suffix and keep looking for a genuine quantity in the message.
    ['For SBL-RPC-12 units, are 24 units available?', 24],
    ['SBL-RPC-12 availability: 32 units?', 32],
    ['Is SBL-HXB-09 available (40 modules)?', 40],
    ['48 units of SBL-RPC-12: are they available?', 48],
    ['SBL-RPC-12 inventory:\n56 units available?', 56],
  ];

  for (const [content, quantity] of scenarios) {
    expect
      .soft(classifySupportQuery([{ role: 'user', content }]), content)
      .toMatchObject({
        kind: 'catalog',
        // Product matching still needs the intact normalized message.
        message: content.toLowerCase(),
        quantity,
      });
  }
});
