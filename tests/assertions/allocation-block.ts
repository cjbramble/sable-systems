import { expect } from 'vitest';

// A minimum alone does not establish a block increment. Labeled block sizes
// need an explicit whole-block multiple rule; every stated block must agree.
export function expectAllocationBlockRule(answer: string, block: number) {
  const text = answer.replace(/[*`]/g, '');
  const increments = [
    ...text.matchAll(
      /\b(?:multiples?|blocks?|increments?)\s+(?:of\s+)?(\d+)\b|\b(\d+)[- ](?:seat|license)\s+blocks?\b/gi,
    ),
  ].map((match) => Number(match[1] ?? match[2]));
  const sizes = [
    ...text.matchAll(
      /\b(?:minimum\s+|allocation\s+)?block(?:\s+size)?\s*(?:is\s+|of\s+|:\s*)?(\d+)\b/gi,
    ),
  ].map((match) => Number(match[1]));
  const wholeBlockMultiple = /\bwhole[- ](?:pack|block)\s+multiples?\b/i.test(
    text,
  );
  expect(
    increments.length > 0 || (sizes.length > 0 && wholeBlockMultiple),
    `Expected an explicit allocation-block increment: ${answer}`,
  ).toBe(true);
  expect(
    [...increments, ...sizes].every((value) => value === block),
    `Every stated allocation block must be ${block}: ${answer}`,
  ).toBe(true);
}
