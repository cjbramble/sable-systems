import { expect } from 'vitest';
import {
  claimsMatching,
  itemNumberPattern,
  expectClaimsToComeFromContext,
  usdCents,
} from './context-claims';

export type ComparisonProductFacts = {
  item: string;
  name: string;
  unit: string;
  priceCents: number;
  pack: number;
  lead: number;
  available: number;
};

export function expectProductComparisonResponse(
  answer: string,
  authorizedContext: string,
  expectedProducts: ComparisonProductFacts[],
) {
  expect([...claimsMatching(answer, itemNumberPattern)].sort()).toEqual(
    expectedProducts.map((product) => product.item).sort(),
  );

  // Anchor each product at its SKU-bearing line, retaining fields before the SKU
  // and legacy wrapped fields below it. The next SKU line ends the block.
  const sections: string[] = [];
  const labels =
    /\b(item number|price|case pack|lead time|available units)\s*:/gi;
  for (const line of answer.replace(/[*`]/g, '').split(/\r?\n/)) {
    const items = [...claimsMatching(line, itemNumberPattern)];
    if (items.length) {
      expect(items, `One product per SKU-bearing line: ${line}`).toHaveLength(
        1,
      );
      sections.push(line);
    } else if ([...line.matchAll(labels)].length) {
      expect(
        sections.length,
        `Unscoped comparison fields: ${line}`,
      ).toBeGreaterThan(0);
      sections[sections.length - 1] += `\n${line}`;
    }
  }
  for (const product of expectedProducts) {
    const productSections = sections.filter((section) =>
      claimsMatching(section, itemNumberPattern).has(product.item),
    );
    expect(
      productSections,
      `Expected one section for ${product.item}: ${answer}`,
    ).toHaveLength(1);
    const section = productSections[0] ?? '';
    const expectName = (text: string) =>
      expect(text.toLowerCase(), product.item).toContain(
        product.name.toLowerCase(),
      );
    for (const other of expectedProducts.filter(
      (candidate) => candidate.item !== product.item,
    ))
      expect(section.toLowerCase(), product.item).not.toContain(
        other.name.toLowerCase(),
      );
    const fields = [...section.matchAll(labels)];
    // A SKU is sufficient when names are omitted; any supplied name must agree.
    const prefix = section
      .slice(0, fields[0]?.index)
      .replace(/^\s*(?:[-+]|\d+[.)])\s*/, '');
    if (/[a-z]/i.test(prefix)) expectName(prefix);
    expect(
      new Set(fields.map((field) => field[1].toLowerCase())),
      section,
    ).toEqual(
      new Set([
        'item number',
        'price',
        'case pack',
        'lead time',
        'available units',
      ]),
    );
    for (const [index, field] of fields.entries()) {
      const value = section
        .slice(field.index + field[0].length, fields[index + 1]?.index)
        .trim();
      if (/\bfor\s+[a-z]/i.test(value)) expectName(value);
      switch (field[1].toLowerCase()) {
        case 'item number':
          expect(
            [...claimsMatching(value, itemNumberPattern)],
            section,
          ).toEqual([product.item]);
          if (/[a-z]/i.test(value.replace(product.item, ''))) expectName(value);
          break;
        case 'price': {
          const money = /^\$-?\d(?:[\d,]*\d)?(?:\.\d+)?/.exec(value)?.[0];
          expect(money, `Missing price: ${section}`).toBeDefined();
          expect(usdCents(money!), section).toBe(product.priceCents);
          const unit = /^\s+per\s+(\w+)/i.exec(value.slice(money!.length))?.[1];
          if (unit)
            expect(['unit', product.unit], section).toContain(
              unit.toLowerCase(),
            );
          break;
        }
        case 'lead time': {
          const days = /^(\d+(?:\.\d+)?)\s+days?\b/i.exec(value)?.[1];
          expect(Number(days), section).toBe(product.lead);
          break;
        }
        default: {
          const units =
            /^(\d+(?:\.\d+)?)(?:\s+(units?|controllers?|cells?|arrays?))?(?=\s*(?:[;|.()]|for\b|$))/i.exec(
              value,
            );
          const expected =
            field[1].toLowerCase() === 'case pack'
              ? product.pack
              : product.available;
          expect(Number(units?.[1]), section).toBe(expected);
          if (units?.[2])
            expect(['unit', product.unit], section).toContain(
              units[2].toLowerCase().replace(/s$/, ''),
            );
        }
      }
    }
  }

  expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
  expectClaimsToComeFromContext(answer, authorizedContext);
}

export function expectOverlappingComparisonResponse(
  answer: string,
  authorizedContext: string,
) {
  expectProductComparisonResponse(answer, authorizedContext, [
    {
      item: 'SBL-CSR-R2',
      name: 'Coldstart Rack Controller R2',
      unit: 'controller',
      priceCents: 225000,
      pack: 4,
      lead: 90,
      available: 0,
    },
    {
      item: 'SBL-RPC-12',
      name: 'Redline Power Cell R12',
      unit: 'cell',
      priceCents: 68000,
      pack: 8,
      lead: 18,
      available: 312,
    },
  ]);
  // Also catch the former collision if it appears only by name, without a SKU.
  expect(answer).not.toMatch(/Blackchannel|Haptic Controller/i);
}
