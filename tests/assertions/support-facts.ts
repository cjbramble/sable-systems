import { expect } from 'vitest';

// Bounded wording checks for the stock and account-summary live cases. These
// are not general semantic validators; every recognized quantity is checked.
export function expectPositiveStockResponse(answer: string, available: number) {
  const text = answer.replace(/[*`]/g, '').replace(/’/g, "'");
  expect(available, 'Seed has stock').toBeGreaterThan(0);
  expect(text, 'Positive availability').toMatch(
    /\bin stock\b|\b(?:is|are)\s+(?:currently\s+)?available\b|\bavailable(?:[- ]to[- ]promise)?(?:\s+(?:quantity|stock))?\s*:\s*\d|\bavailability\s*:\s*\d|\b\d[\d,]*(?:\.\d+)?\s+(?:units?|cells?)\s+(?:are\s+)?available\b/i,
  );
  expect(text, 'No contradictory stock denial').not.toMatch(
    /\b(?:not|out of)\s+(?:currently\s+)?(?:in\s+)?stock\b|\b(?:not|isn't|aren't)\s+(?:currently\s+)?available\b|\bunavailable\b|\b(?:no|zero)\s+(?:current\s+)?stock\b/i,
  );
  for (const pattern of [
    /(\d[\d,]*(?:\.\d+)?)\s+(?:units?\s+|cells?\s+)?(?:are\s+)?(?:available|in stock)\b/gi,
    /\b(?:available(?:[- ]to[- ]promise)?(?:\s+(?:quantity|stock))?|availability|stock)\s*(?::|is|of)?\s*(\d[\d,]*(?:\.\d+)?)/gi,
  ])
    for (const [, quantity] of text.matchAll(pattern))
      expect(Number(quantity.replace(/,/g, '')), 'Stated quantity').toBe(
        available,
      );
}

export function expectNoChargeAccountAuthorizations(answer: string) {
  const text = answer.replace(/[*`]/g, '');
  const subject = /\b(?:recent\s+)?charge[ -]account authorizations?\b/i;
  const claims = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((clause) => subject.test(clause));
  expect(
    claims.length,
    'Charge-account authorization statement',
  ).toBeGreaterThan(0);
  for (const clause of claims) {
    expect(clause, 'No recorded charge-account authorizations').toMatch(
      /\b(?:recent\s+)?charge[ -]account authorizations?\s*:\s*none\s+(?:are\s+)?recorded\b|\bno\s+(?:recent\s+)?charge[ -]account authorizations?\s+(?:(?:are|were|have been|has been)\s+)?recorded\b|\bno\s+recorded\s+(?:recent\s+)?charge[ -]account authorizations?\b/i,
    );
    expect(clause, 'No contradictory authorization claim').not.toMatch(
      /\bauthorizations?\s+(?:(?:is|are|was|were|has been|have been)\s+)?(?:approved|pending|active|granted|issued)\b/i,
    );
  }
}
