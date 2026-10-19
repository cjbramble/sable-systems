import { expect, it } from 'vitest';

import { classifySupportQueries } from '@/lib/support-query';
import { parseQuantityOccurrences } from '@/lib/support-quantities';
import { parseSupportReferences } from '@/lib/support-references';

type Message = { role: 'user' | 'assistant'; content: string };

// Long runs of numbers with no unit made the quantity regex quadratic, and
// classification re-read the whole history for every clause of the latest
// message. Generous bounds keep these tests stable on slow CI runners.
const numericRun = Array(2000).fill('1').join(' ');

function elapsed(run: () => unknown) {
  const start = performance.now();
  run();
  return performance.now() - start;
}

it('classifies a worst-case conversation within a fixed time', () => {
  const history: Message[] = Array.from({ length: 5 }, () => [
    { role: 'user' as const, content: numericRun },
    { role: 'assistant' as const, content: 'Which item?' },
  ]).flat();
  const latest = 'what is the price? '.repeat(210).slice(0, 4000);
  expect(
    elapsed(() =>
      classifySupportQueries([...history, { role: 'user', content: latest }]),
    ),
  ).toBeLessThan(3000);
});

it('parses a long run of number words within a fixed time', () => {
  const message = `${'twenty '.repeat(700)}units ${'two '.repeat(700)}`;
  expect(elapsed(() => parseQuantityOccurrences(message))).toBeLessThan(1000);
});

it('returns independent copies of cached quantity results', () => {
  const message = 'Can you supply 1,000 units of SBL-RPC-12?';
  const first = parseQuantityOccurrences(message);
  first[0].raw = 'changed';
  first.pop();
  expect(parseQuantityOccurrences(message)).toEqual([
    expect.objectContaining({
      raw: '1,000',
      quantity: { kind: 'valid', value: 1000 },
    }),
  ]);
});

it('still reports a long numeric run before a unit as invalid', () => {
  const message = `${Array.from({ length: 20 }, (_, index) => index + 1).join(' ')} units`;
  expect(parseQuantityOccurrences(message)).toEqual([
    expect.objectContaining({
      quantity: { kind: 'invalid', reason: 'syntax' },
    }),
  ]);
});

it('does not let callers change nested cached values', () => {
  const message = 'Can you supply 2,400 units of SBL-RPC-12?';
  const first = parseQuantityOccurrences(message);
  const quantity = first[0].quantity;
  if (quantity.kind !== 'valid') throw new Error('Expected a valid quantity');
  quantity.value = 1;
  expect(parseQuantityOccurrences(message)[0].quantity).toEqual({
    kind: 'valid',
    value: 2400,
  });
});

// The unbounded pattern before the cost fix, used as an oracle: the bounded
// pattern must report the same starts, ends, and raw text. Its tail matches
// the current one, including a number directly before an item number.
const UNBOUNDED =
  /(?<![\w.,/+\-−–—$])((?:[+\-−–—]\s*)?(?:\d|\.\d)[\d.,/e+\-−–—]*(?:[ \t]+(?:(?:to|through|and)[ \t]+)?[\d.,/+\-−–—][\d.,/e+\-−–—]*)*)(?![\w.,/+\-−–—])(?!\s*(?:tb|gb|mb|kb|m)\b)(?:(?:\s+[a-z-]+){0,2}\s+(?:units?|licenses?|controllers?|arrays?|modules?|hubs?|nodes?|packs?)\b|(?=\s+sbl-(?!\d{4}-)[a-z0-9][a-z0-9-]*(?![\w-])))/gi;

function unboundedSpans(message: string) {
  return Array.from(message.matchAll(UNBOUNDED))
    .filter((match) => !/\bper\b/i.test(match[0].slice(match[1].length)))
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[1],
    }));
}

it.each([
  'order 1000 1 2 3 4 5 6 7 8 9 units',
  'Supply 1 2 3 4 5 6 7 8 9 10 11 12 units of SBL-RPC-12.',
  'Supply 5 to 6 and 7 through 8 to 9 and 10 to 11 and 12 to 13 and 14 units.',
  'SBL-RPC-12 1 2 3 4 5 6 7 8 9 10 11 units',
  '8 units and then 1 2 3 4 5 6 7 8 9 10 11 12 13 units',
  'Ship -1 2 3 4 5 6 7 8 9 10 11 controllers',
  'Price 680.00 per unit; 1 2 3 4 5 6 7 8 9 10 11 nodes',
  'Can you supply 1,000 units of SBL-RPC-12 and 24 licenses of SBL-PAL-1Y?',
  'order 8 units',
  'Do you have 100 SBL-RPC-12 and 1 2 3 4 5 6 7 8 9 10 11 SBL-SWC-12?',
  'order 1 2 3 4 5 6 7 8 9 10 SBL-RPC-12',
])('matches the unbounded pattern for %j', (message) => {
  expect(
    parseQuantityOccurrences(message).map(({ start, end, raw }) => ({
      start,
      end,
      raw,
    })),
  ).toEqual(unboundedSpans(message));
});

it('keeps an overlong expression after "order" a quantity, not an order', () => {
  const message = 'order 1000 1 2 3 4 5 6 7 8 9 units';
  expect(parseQuantityOccurrences(message)).toEqual([
    expect.objectContaining({
      start: 6,
      quantity: { kind: 'invalid', reason: 'syntax' },
    }),
  ]);
  expect(parseSupportReferences(message).occurrences).toEqual([]);
});
