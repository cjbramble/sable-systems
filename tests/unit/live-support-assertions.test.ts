import { expect, it } from 'vitest';
import {
  liveSupportScenarios,
  expectLiveSupportAnswer,
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
