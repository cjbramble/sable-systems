import { expect } from 'vitest';
import fixture from '../fixtures/judge/live-support-scenarios.json';
import { expectClaimsToComeFromContext } from './context-claims';
import { unsupportedSableResources } from '@/lib/support-response';

export const liveSupportScenarios = fixture.scenarios;
export type LiveSupportScenario = (typeof liveSupportScenarios)[number];

export function expectLiveSupportContext(
  scenario: LiveSupportScenario,
  context: string,
) {
  for (const fact of scenario.contextIncludes) expect(context).toContain(fact);
  for (const excluded of scenario.contextExcludes)
    expect(context).not.toContain(excluded);
}

export function expectLiveSupportAnswer(
  scenario: LiveSupportScenario,
  answer: string,
  context: string,
) {
  const normalized = answer.replace(/[*`]/g, '').replace(/’/g, "'");
  for (const pattern of scenario.answerRequired)
    expect(
      normalized,
      `Missing required response fact for ${scenario.id}: ${pattern}`,
    ).toMatch(new RegExp(pattern, 'i'));
  for (const pattern of scenario.answerForbidden)
    expect(
      normalized,
      `Forbidden response claim for ${scenario.id}: ${pattern}`,
    ).not.toMatch(new RegExp(pattern, 'i'));
  if (scenario.refusedActions.length) {
    const clauses = normalized
      .replace(/[;,]\s*nor\s+(?:can|could|will)\s+I\s+/gi, ', cannot ')
      .split(/[.!?;\n]|\b(?:but|however|yet|although)\b/i);
    for (const action of scenario.refusedActions) {
      const refusal = new RegExp(
        `\\b(?:cannot|can't|unable to|not (?:able|authorized|permitted) to)\\b[\\s\\S]{0,100}\\b${action}\\b`,
        'i',
      );
      expect(
        clauses.some((clause) => refusal.test(clause)),
        `Each action must be refused: ${action}`,
      ).toBe(true);
    }
  }
  // Status checks belong to the requested record, not every linked record.
  const requestedKind = scenario.contextIncludes[0]
    .match(/^(Order|Shipment|Return):/i)?.[1]
    ?.toLowerCase();
  if (requestedKind && scenario.expectedStatus !== null) {
    for (const sentence of normalized.split(/[.!?;\n]/)) {
      const namedKinds = [
        ...sentence.matchAll(
          /\b(order|shipment|return)\b|\b(SBL-\d{4}-\d{6}|SHP-\d{4}-\d{6}|RTN-\d{4}-\d{6})\b/gi,
        ),
      ].map(
        (match) =>
          match[1]?.toLowerCase() ??
          { SBL: 'order', SHP: 'shipment', RTN: 'return' }[
            match[2].slice(0, 3) as 'SBL' | 'SHP' | 'RTN'
          ],
      );
      if (namedKinds.length && !namedKinds.includes(requestedKind)) continue;
      const statusClaims = sentence.matchAll(
        /\b(?:current\s+status|status|(?:order|shipment|return|it|SBL-\d{4}-\d{6}|SHP-\d{4}-\d{6}|RTN-\d{4}-\d{6})\s+(?:is|was|has been|is now))\s*(?:is\s*|:\s*)?(partially[_ -]shipped|in[_ -]transit|delivered|shipped|delayed|backordered|closed|authorized|cancelled|canceled|received)\b/gi,
      );
      for (const claim of statusClaims) {
        const subject = claim[0].match(
          /^(order|shipment|return|SBL-\d{4}-\d{6}|SHP-\d{4}-\d{6}|RTN-\d{4}-\d{6})\b/i,
        )?.[1];
        const subjectKind = subject?.includes('-')
          ? { SBL: 'order', SHP: 'shipment', RTN: 'return' }[
              subject.slice(0, 3).toUpperCase() as 'SBL' | 'SHP' | 'RTN'
            ]
          : subject?.toLowerCase();
        if (subjectKind && subjectKind !== requestedKind) continue;
        if (
          subject?.includes('-') &&
          !scenario.contextIncludes[0].includes(subject.toUpperCase())
        )
          continue;
        expect(
          claim[1].toLowerCase().replace(/[_ -]/g, '_'),
          `Conflicting status: ${claim[0]}`,
        ).toBe(scenario.expectedStatus);
      }
    }
  }
  if (scenario.expectedAvailable !== null) {
    const quantityClaims = normalized.matchAll(
      /\b(?:available(?:[- ]to[- ]promise)?(?:\s+(?:quantity|stock|units))?\s*(?:is|of|:|=)?\s*([+-]?\d[\d,]*(?:\.\d+)?)|([+-]?\d[\d,]*(?:\.\d+)?)\s+(?:units?|cells?)\s+(?:are\s+)?available)\b/gi,
    );
    for (const claim of quantityClaims) {
      expect(
        Number((claim[1] ?? claim[2]).replaceAll(',', '')),
        `Conflicting availability: ${claim[0]}`,
      ).toBe(scenario.expectedAvailable);
    }
  }
  expectClaimsToComeFromContext(answer, context);
  expect(unsupportedSableResources(answer, context)).toEqual([]);
}
