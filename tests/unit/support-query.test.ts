import { expect, it } from 'vitest';
import { classifySupportQuery } from '@/lib/support-query';

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
