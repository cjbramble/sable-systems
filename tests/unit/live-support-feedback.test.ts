import { expect, it } from 'vitest';
import {
  expectLiveSupportAnswer,
  liveSupportScenarios,
} from '../assertions/live-support';

function check(id: string, answer: string) {
  const scenario = liveSupportScenarios.find(
    (candidate) => candidate.id === id,
  )!;
  const context =
    scenario.contextIncludes.join('\n') +
    '\nOrder: SBL-2022-000118; status: delivered.\nProduct: SBL-CSR-R2; Available to promise: 0.\nShipment: SHP-2026-000417; status: delayed.';
  expectLiveSupportAnswer(scenario, answer, context);
}

it.each([
  'It is never available.',
  'It is no longer available.',
  "It isn't in stock.",
  'It is NEVER currently available.',
  'It is no longer in stock.',
  "The cells aren't currently in stock.",
])('rejects a repeated stock denial: %s', (denial) => {
  expect(() =>
    check('topic-switch', `SBL-RPC-12 has 312 units available. ${denial}`),
  ).toThrow();
});

it.each([
  'It is not out of stock.',
  "It isn't unavailable.",
  'It is no longer unavailable.',
  'It was never out of stock.',
])('preserves a negated stock denial: %s', (affirmation) => {
  check('topic-switch', `SBL-RPC-12 has 312 units available. ${affirmation}`);
});

it.each([
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. You can order it, but it is unavailable.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. Order it today. It is unavailable.',
  ],
  [
    'topic-switch',
    "SBL-RPC-12 has 312 units available. You shouldn't return it. Available: 0.",
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. I cannot return it. It is delivered.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Please return it. It is not partially shipped.',
  ],
])('does not let an action verb hide a %s contradiction: %s', (id, answer) => {
  expect(() => check(id, answer)).toThrow();
});

it.each([
  ['topic-switch', 'SBL-RPC-12 has 312 units available. You can order it.'],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. The order is delivered.',
  ],
  ['order-status', 'SBL-2026-000417 is partially shipped. I cannot return it.'],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The return is closed.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Shipment status: delayed.',
  ],
])(
  'preserves action wording and real kind switches for %s: %s',
  (id, answer) => {
    check(id, answer);
  },
);

it.each([
  [
    'topic-switch',
    'SBL-RPC-12 is listed. 312 units are available for another product.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. Available: 312 for a different product.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. 312 units are available for product SBL-CSR-R2.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. Available: 312 units for SBL-CSR-R2.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. Another product has 312 units available.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for another order.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for order SBL-2022-000118.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for the shipment.',
  ],
])('does not credit a fact about another %s subject: %s', (id, answer) => {
  expect(() => check(id, answer)).toThrow();
});

it.each([
  [
    'topic-switch',
    'SBL-RPC-12 is listed. 312 units are available for this product.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. Available: 312 units for SBL-RPC-12.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. 0 units are available for SBL-CSR-R2.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. It is unavailable for another product.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. Available: 0 for another product.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for this order.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for SBL-2026-000417.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Status: delivered for SBL-2022-000118.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Status: not partially shipped for another order.',
  ],
])('accepts facts with explicit trailing %s subjects: %s', (id, answer) => {
  check(id, answer);
});

it.each([
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. Available: 0. For another product, ask separately.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. It is delivered; for another order, ask separately.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. It is delivered, but for another order I have no facts.',
  ],
])('does not let a later clause hide a %s contradiction: %s', (id, answer) => {
  expect(() => check(id, answer)).toThrow();
});

it.each([
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. 0 units are available for SBL-CSR-R2. It is unavailable.',
    true,
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. 312 units are available for another product. It has 312 units available.',
    false,
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Status: delivered for SBL-2022-000118. The order is delivered.',
    true,
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. Status: partially shipped for another order. The order is partially shipped.',
    false,
  ],
])(
  'carries a trailing %s subject into later references: %s',
  (id, answer, correct) => {
    const assertion = expect(() => check(id, answer));
    if (correct) assertion.not.toThrow();
    else assertion.toThrow();
  },
);

it.each([
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Shipment SHP-2026-000417 is delayed for this order.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The shipment is delayed for this order. It is delayed.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. SBL-CSR-R2 has 0 units available for this product. It is unavailable.',
  ],
])(
  'preserves an explicit subject before a relational qualifier: %s',
  (id, answer) => {
    check(id, answer);
  },
);
