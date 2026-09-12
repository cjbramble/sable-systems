import { expect } from 'vitest';
import { calderPikeUser } from '../fixtures/users';
import { expectNoForeignDistributorIdentity } from './distributor-scope';

export function claimsMatching(value: string, pattern: RegExp) {
  return new Set(value.match(pattern) ?? []);
}

export const orderIdPattern = /\bSBL-\d{4}-\d{6}\b/g;
export const itemNumberPattern =
  /\bSBL-(?!\d{4}-\d{6}\b)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
export const shipmentIdPattern = /\bSHP-\d{4}-\d{6}\b/g;
export const returnIdPattern = /\bRTN-\d{4}-\d{6}\b/g;
export const incidentIdPattern = /\bINC-[A-Za-z0-9-]{6,100}\b/g;
export const trackingReferencePattern = /\bAST-\d{10}\b/g;
const factualClaimPatterns = [
  orderIdPattern,
  itemNumberPattern,
  shipmentIdPattern,
  returnIdPattern,
  incidentIdPattern,
  trackingReferencePattern,
  /\b[A-Z]{3}-(?:PO|REL)-\d{6}\b/g,
  /\b20\d{2}-\d{2}-\d{2}\b/g,
];

const moneyPattern = /\$-?\d(?:[\d,]*\d)?(?:\.\d+)?/g;

export function usdCents(value: string) {
  const match = /^\$(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(value);
  expect(match, `Invalid currency claim: ${value}`).not.toBeNull();
  const cents =
    Number(match![1].replaceAll(',', '')) * 100 +
    Number((match![2] ?? '').padEnd(2, '0'));
  expect(Number.isSafeInteger(cents), `Unsafe currency amount: ${value}`).toBe(
    true,
  );
  return cents;
}

export function expectClaimsToComeFromContext(
  answer: string,
  context: string,
  authorizedId = calderPikeUser.distributorId,
) {
  expectNoForeignDistributorIdentity(answer, authorizedId);
  for (const pattern of factualClaimPatterns) {
    const authorizedClaims = claimsMatching(context, pattern);
    for (const claim of claimsMatching(answer, pattern))
      expect(authorizedClaims.has(claim), `Unsupported claim: ${claim}`).toBe(
        true,
      );
  }
  const amounts = new Set(
    [...claimsMatching(context, moneyPattern)].map(usdCents),
  );
  for (const claim of claimsMatching(answer, moneyPattern))
    expect(amounts.has(usdCents(claim)), `Unsupported amount: ${claim}`).toBe(
      true,
    );
}
