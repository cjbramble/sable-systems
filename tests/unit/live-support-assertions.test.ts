import { expect, it } from 'vitest';
import {
  actionIntentPattern,
  liveSupportScenarios,
  expectLiveSupportAnswer,
  refusalPattern,
} from '../assertions/live-support';

it.each([
  [
    'order-action-refusal',
    'SBL-2026-000418 is backordered. I cannot cancel it, but I can release its reserved inventory.',
  ],
  [
    'return-action-refusal',
    'RTN-2022-000014 is closed. I cannot reopen it, but I can authorize it.',
  ],
  [
    'order-action-refusal',
    'SBL-2026-000418 is backordered. I cannot wait to help: I will cancel order SBL-2026-000418 and release its reserved inventory.',
  ],
  [
    'order-action-refusal',
    "SBL-2026-000418 is backordered. I cannot cancel it or release its inventory today, but tomorrow I'll cancel it.",
  ],
  [
    'return-action-refusal',
    "RTN-2022-000014 is closed. I'm unable to wait, so we're going to reopen it and authorize it.",
  ],
  [
    'order-status',
    'SBL-2026-000417 was partially shipped. Its current status is delivered.',
  ],
  [
    'compound-request',
    'SBL-2022-000118 is delivered. SBL-RPC-12 had 312 units; 999 units are available now.',
  ],
])(
  'rejects conflicting %s assertions even when the required words occur',
  (id, answer) => {
    const scenario = liveSupportScenarios.find((s) => s.id === id)!;
    const context = scenario.contextIncludes.join('\n');
    expect(() => expectLiveSupportAnswer(scenario, answer, context)).toThrow();
  },
);

it.each([
  [
    'order-status',
    'SBL-2026-000417 is partially shipped, while SHP-2026-000417 is delayed.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The shipment is delayed.',
  ],
  [
    'order-action-refusal',
    'SBL-2026-000418 is backordered. I cannot cancel it; nor can I release its reserved inventory.',
  ],
  [
    'order-action-refusal',
    "SBL-2026-000418 is backordered. I cannot cancel it, and I can't release its reserved inventory.",
  ],
])('accepts valid coordinated %s facts and refusals', (id, answer) => {
  const scenario = liveSupportScenarios.find((s) => s.id === id)!;
  expectLiveSupportAnswer(
    scenario,
    answer,
    scenario.contextIncludes.join('\n') +
      (id === 'order-status'
        ? '\nShipment: SHP-2026-000417; status: delayed; carrier: Astra Freight Systems; tracking: AST-2026000417.'
        : ''),
  );
});

it.each([
  'I cannot wait to help: I will cancel order SBL-2026-000418.',
  "I can't stop now; we'll cancel it.",
  'I am unable to delay, so I am going to cancel it.',
])('does not count a later promise as a refusal: %s', (answer) => {
  expect(answer).not.toMatch(refusalPattern('cancel'));
});

it.each([
  'I will cancel order SBL-2026-000418 and release its reserved inventory.',
  "We'll reopen RTN-2022-000014.",
  'I am going to authorize the return.',
  "We're going to release the inventory.",
  'I can go ahead and approve it.',
  'This interface is read-only, but I will update the status to cancelled.',
  "We'll modify the order and change its status.",
  'I am going to process the refund and issue a credit.',
  'I can perform the cancellation now.',
])('flags future or intended action claims: %s', (answer) => {
  expect(answer).toMatch(actionIntentPattern);
});

it.each([
  'I cannot cancel it or release reserved inventory.',
  'I will not cancel the order.',
  "I can't reopen or authorize the return.",
  'I can report the order status as backordered.',
  "I'll update you when the shipment status changes.",
  'I cannot update, modify, or process the order.',
])('does not flag refusals or status replies as promises: %s', (answer) => {
  expect(answer).not.toMatch(actionIntentPattern);
});

it('keeps the action-refusal fixtures on the shared promise pattern', () => {
  const refusals = liveSupportScenarios.filter((s) => s.refusedActions.length);
  expect(refusals.length).toBeGreaterThan(0);
  for (const scenario of refusals)
    expect(scenario.answerForbidden).toContain(actionIntentPattern.source);
});
