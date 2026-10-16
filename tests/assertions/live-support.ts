import { expect } from 'vitest';
import fixture from '../fixtures/judge/live-support-scenarios.json';
import { expectClaimsToComeFromContext } from './context-claims';
import { unsupportedSableResources } from '@/lib/support-resource-claims';
import {
  expectScenarioFacts,
  normalizeAnswerPresentation,
} from './scenario-facts';

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
  const normalized = normalizeAnswerPresentation(answer);
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
  expectScenarioFacts(normalized, scenario);
  expectClaimsToComeFromContext(answer, context);
  // Production-guard consistency coverage, not an independent factual oracle.
  expect(unsupportedSableResources(answer)).toEqual([]);
}
