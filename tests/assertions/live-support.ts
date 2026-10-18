import { expect } from 'vitest';
import fixture from '../fixtures/judge/live-support-scenarios.json';
import { expectClaimsToComeFromContext } from './context-claims';
import { unsupportedSableResources } from '@/lib/support-resource-claims';
import {
  expectScenarioFacts,
  normalizeAnswerPresentation,
} from './scenario-facts';

export const liveSupportScenarios = fixture.scenarios;
type LiveSupportScenario = (typeof liveSupportScenarios)[number];

// A new subject with a modal ("I will", "we'll") starts a different statement,
// so "I cannot wait to help: I will cancel" is not a refusal to cancel.
const refusalGap = String.raw`(?:(?!\b(?:I|we)(?:'ll|'m|'re|\s+(?:will|am|are|can|shall|would)\b))[\s\S]){0,100}`;

export function refusalPattern(actions: string) {
  return new RegExp(
    String.raw`\b(?:cannot|can't|unable to|not (?:able|authorized|permitted) to)\b${refusalGap}\b(?:${actions})\b`,
    'i',
  );
}

// Every change COV-E must neither claim nor promise. "update you" is a status
// courtesy, not a record change.
export const mutationActions = String.raw`cancel|release|reopen|authorize|approve|modify|update(?!\s+you\b)|change|process|issue|perform|execute`;

// Past-tense checks miss promises such as "I will cancel the order". The
// action-refusal answerForbidden fixture patterns must contain this source.
export const actionIntentPattern = new RegExp(
  String.raw`\b(?:I|we)(?:'ll|\s+will|(?:'m|'re|\s+(?:am|are))\s+going to|\s+can)\s+(?:(?:now|just|also|immediately|go ahead and)\s+)*(?:${mutationActions})\b`,
  'i',
);

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
      const refusal = refusalPattern(action);
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
