import { expect } from 'vitest';
import { findIncorrectNearestCasePackClaims } from './nearest-case-pack';
import { findPositiveStockShortfallClaims } from './stock-shortfall';
import { findPartialFulfillmentPromises } from './partial-fulfillment';
import { expectClaimsToComeFromContext } from './context-claims';
import { findCurrentStockOverclaims } from './stock-availability';

export function expectCasePackResponse(
  answer: string,
  authorizedContext: string,
) {
  expect(
    findCurrentStockOverclaims(answer, 312),
    'A fulfillment promise must not exceed the 312 units in current stock',
  ).toEqual([]);
  expect(
    findIncorrectNearestCasePackClaims(answer, 310, 8),
    'A nearest-quantity claim must use the closest valid case-pack multiple',
  ).toEqual([]);
  const normalizedAnswer = answer.replace(/[*`]/g, '').replace(/’/g, "'");
  expect(normalizedAnswer).toMatch(/\b310\b/);
  expect(normalizedAnswer).toMatch(
    /\b(?:available(?:[- ]to[- ]promise)?|availability|stock)\b[^.!?\n]{0,50}\b312\b|\b312\b[^.!?\n]{0,50}\b(?:available|availability|stock)\b/i,
  );
  expect(normalizedAnswer).toMatch(
    /\b(?:case[- ]pack|multiples?|packs?)\b[^.!?\n]{0,25}\b8\b|\beight to a pack\b/i,
  );
  expect(normalizedAnswer).toMatch(
    /\b(?:invalid|not (?:a )?(?:(?:valid|whole[- ]pack) )?multiple|not (?:a )?valid|not divisible|does not meet (?:that|the) rule|cannot fulfill exactly 310)\b|\bchange\b[^.!?\n]{0,70}\b310\b[^.!?\n]{0,70}\bmultiple of 8\b/i,
  );
  expect(normalizedAnswer).not.toMatch(
    /\b310\s+(?:units?\s+)?(?:is|are)\s+(?:a\s+)?(?:valid(?:\s+multiple)?|multiple of 8|divisible by 8)\b/i,
  );
  expect(
    findPositiveStockShortfallClaims(answer, 310),
    'An invalid case-pack quantity must not be described as a stock shortage',
  ).toEqual([]);
  expect(
    findPartialFulfillmentPromises(answer),
    `Unsupported partial-unit fulfillment promise: ${answer}`,
  ).toEqual([]);
  expect(
    normalizedAnswer,
    `Expected an ordering restriction or required quantity adjustment: ${answer}`,
  ).toMatch(
    /\b(?:must|needs? to|has to)\b[^.!?\n]{0,80}\b(?:adjust(?:ed|ment)?|chang(?:e|ed)|round(?:ed)?|multiples?|full[- ]case|whole[- ]case)\b|\b(?:adjust|change|round|revise|select)\b[^.!?\n]{0,60}\b(?:quantity|order|amount|multiple|full[- ]case|whole[- ]case|whole[- ]pack)\b|\b(?:cannot|can't|can not)\b[^.!?\n]{0,60}\b(?:ordered|fulfilled|shipped|processed|accepted)\b/i,
  );
  expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
  expectClaimsToComeFromContext(answer, authorizedContext);
}
