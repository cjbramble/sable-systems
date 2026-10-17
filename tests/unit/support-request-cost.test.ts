import { expect, it } from 'vitest';

import { classifySupportQueries } from '@/lib/support-query';
import { parseQuantityOccurrences } from '@/lib/support-quantities';

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
