import { expect, it } from 'vitest';
import {
  expectLiveSupportAnswer,
  liveSupportScenarios,
} from '../assertions/live-support';

// Independently authored controls. These exercise the bounded checker, not live
// model quality, and cease to be holdouts once used to improve that checker.
const controls = [
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The order is not partially shipped.',
  ],
  [
    'order-status',
    "SBL-2026-000417 is partially shipped, but it isn't partially shipped.",
  ],
  ['order-status', 'SBL-2026-000417: status: not partially_shipped.'],
  ['order-status', 'SBL-2026-000417 is not partially shipped.'],
  [
    'order-status',
    'SBL-2026-000417 is delivered; SBL-2022-000118 is partially shipped.',
  ],
  [
    'order-status',
    'SBL-2026-000417 is listed. SHP-2026-000417 is partially shipped.',
  ],
  [
    'order-status',
    'SBL-2026-000417. Requested status words: partially shipped.',
  ],
  [
    'shipment-status',
    'SHP-2026-000417 is delayed. It is not delayed. Carrier Astra Freight Systems; tracking AST-2026000417.',
  ],
  [
    'shipment-status',
    'SHP-2026-000417 is listed. The order is delayed. Carrier Astra Freight Systems; tracking AST-2026000417.',
  ],
  [
    'return-status',
    'RTN-2022-000014 is closed; reason sealed surplus. The return is not closed.',
  ],
  [
    'return-status',
    'RTN-2022-000014 is listed. The order is closed; reason sealed surplus.',
  ],
  [
    'return-action-refusal',
    'The return is not closed. I cannot reopen or authorize it.',
  ],
  [
    'order-action-refusal',
    'The order is not backordered. I cannot cancel it or release reserved inventory.',
  ],
  ['missing-record', 'I cannot locate RTN-2031-999999. The return is closed.'],
  [
    'account-authorization',
    'I cannot locate SBL-2021-500000 within your authorization scope. The order is delivered.',
  ],
  [
    'compound-request',
    'SBL-2022-000118 is delivered. SBL-RPC-12 has 312 units reserved.',
  ],
  [
    'compound-request',
    'SBL-2022-000118 is delivered. SBL-RPC-12 has 312 units available, but the product is unavailable.',
  ],
  [
    'compound-request',
    'SBL-2022-000118 is delivered with 312 units available. SBL-RPC-12 is listed.',
  ],
  ['topic-switch', 'SBL-RPC-12 has 312 units reserved.'],
  ['topic-switch', 'SBL-RPC-12 is in stock. Requested quantity: 312.'],
  ['topic-switch', 'SBL-RPC-12 has 312 units available. Available: 311 units.'],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. Available: not 312 units.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. SBL-CSR-R2 has 312 units available. SBL-RPC-12 has 0 units available.',
  ],
];

it.each(controls)(
  'rejects a contradictory, misplaced, or omitted fact for %s: %s',
  (id, answer) => {
    const scenario = liveSupportScenarios.find(
      (candidate) => candidate.id === id,
    )!;
    const context =
      scenario.contextIncludes.join('\n') +
      '\nOrder: SBL-2022-000118; status: delivered.\nShipment: SHP-2026-000417; status: delayed.\nProduct: SBL-CSR-R2; Available to promise: 0.';
    expect(() => expectLiveSupportAnswer(scenario, answer, context)).toThrow();
  },
);

it.each([
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The order is not delivered.',
  ],
  ['order-status', '**SBL-2026-000417** — **Status:** _partially shipped_.'],
  [
    'order-status',
    '| Order | Status |\n| SBL-2026-000417 | partially_shipped |',
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped, while SHP-2026-000417 is delayed.',
  ],
  [
    'order-status',
    'SHP-2026-000417 is delayed; SBL-2026-000417 is partially shipped.',
  ],
  [
    'shipment-status',
    'SHP-2026-000417 is delayed; carrier Astra Freight Systems; tracking AST-2026000417. The order is partially shipped.',
  ],
  [
    'return-status',
    '**RTN-2022-000014**: status: **closed**; reason sealed_surplus.',
  ],
  ['topic-switch', '**SBL-RPC-12**\nAvailable to promise: **312**.'],
  ['topic-switch', 'SBL-RPC-12: 312 units are available. Reserved: 24 units.'],
  [
    'compound-request',
    'SBL-2022-000118 is delivered. SBL-RPC-12 has 312 units available.',
  ],
])(
  'accepts supported scoped facts and presentation for %s: %s',
  (id, answer) => {
    const scenario = liveSupportScenarios.find(
      (candidate) => candidate.id === id,
    )!;
    expectLiveSupportAnswer(
      scenario,
      answer,
      scenario.contextIncludes.join('\n') +
        '\nShipment: SHP-2026-000417; status: delayed.',
    );
  },
);

it.each([
  [
    'order-status',
    'SBL-2026-000417 is listed. SBL-2022-000118: the order is partially shipped.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. SBL-CSR-R2: the product has 312 units available.',
  ],
])(
  'does not let a generic label erase a different explicit %s target',
  (id, answer) => {
    const scenario = liveSupportScenarios.find(
      (candidate) => candidate.id === id,
    )!;
    expect(() =>
      expectLiveSupportAnswer(
        scenario,
        answer,
        scenario.contextIncludes.join('\n') +
          '\nOrder: SBL-2022-000118; status: delivered.\nProduct: SBL-CSR-R2; Available to promise: 0.',
      ),
    ).toThrow();
  },
);

it.each([
  'scheduled',
  'confirmed',
  'allocating',
  'on hold',
  'preparing',
  'returned',
  'requested',
  'denied',
  'credited',
])('rejects a conflicting supported status: %s', (status) => {
  const scenario = liveSupportScenarios.find(
    ({ id }) => id === 'order-status',
  )!;
  expect(() =>
    expectLiveSupportAnswer(
      scenario,
      `SBL-2026-000417 is partially shipped. The order is ${status}.`,
      scenario.contextIncludes.join('\n'),
    ),
  ).toThrow();
});

it.each([
  'SBL-2026-000417 is partially shipped. It is no longer partially shipped.',
  'SBL-2026-000417 is partially shipped. It is not currently partially shipped.',
])('rejects a qualified status denial: %s', (answer) => {
  const scenario = liveSupportScenarios.find(
    ({ id }) => id === 'order-status',
  )!;
  expect(() =>
    expectLiveSupportAnswer(
      scenario,
      answer,
      scenario.contextIncludes.join('\n'),
    ),
  ).toThrow();
});

it.each([
  'SBL-RPC-12 has -312 units available.',
  'SBL-RPC-12 has 312 units available. Available: 3,12.',
])('rejects signed or malformed available quantities: %s', (answer) => {
  const scenario = liveSupportScenarios.find(
    ({ id }) => id === 'topic-switch',
  )!;
  expect(() =>
    expectLiveSupportAnswer(
      scenario,
      answer,
      scenario.contextIncludes.join('\n'),
    ),
  ).toThrow();
});

it('accepts a current-status qualifier and preserves negative alternative statuses', () => {
  const scenario = liveSupportScenarios.find(
    ({ id }) => id === 'order-status',
  )!;
  expectLiveSupportAnswer(
    scenario,
    'SBL-2026-000417 is currently partially shipped. It is not currently delivered.',
    scenario.contextIncludes.join('\n'),
  );
});

it.each([
  ['order-status', 'SBL-2026-000417 is NOT partially shipped.', false],
  ['order-status', 'SBL-2026-000417 is NEVER partially shipped.', false],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. It is NOT delivered.',
    true,
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. It is not out of stock.',
    true,
  ],
  [
    'topic-switch',
    "SBL-RPC-12 has 312 units available. It isn't unavailable.",
    true,
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. It is not unavailable.',
    true,
  ],
  [
    'topic-switch',
    'SBL-RPC-12 has 312 units available. It is not out of stock, but it is unavailable.',
    false,
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. The shipment for this order is delayed.',
    true,
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Shipment SHP-2026-000417 for this order is delayed.',
    true,
  ],
  [
    'order-status',
    'SBL-2026-000417 is partially shipped. Shipment SHP-2026-000417 for order SBL-2026-000417 is delayed.',
    true,
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is available to order. Available to promise: 312.',
    true,
  ],
])(
  'preserves polarity and grammatical subjects for %s: %s',
  (id, answer, correct) => {
    const scenario = liveSupportScenarios.find(
      (candidate) => candidate.id === id,
    )!;
    const assertion = expect(() =>
      expectLiveSupportAnswer(
        scenario,
        answer,
        scenario.contextIncludes.join('\n') +
          '\nShipment: SHP-2026-000417; status: delayed.',
      ),
    );
    if (correct) assertion.not.toThrow();
    else assertion.toThrow();
  },
);

it.each([
  [
    'order-status',
    'SBL-2026-000417 is listed. For order SBL-2022-000118, status: partially shipped.',
  ],
  [
    'topic-switch',
    'SBL-RPC-12 is listed. For product SBL-CSR-R2, available: 312.',
  ],
])('keeps an initial for-phrase as the explicit %s subject', (id, answer) => {
  const scenario = liveSupportScenarios.find(
    (candidate) => candidate.id === id,
  )!;
  expect(() =>
    expectLiveSupportAnswer(
      scenario,
      answer,
      scenario.contextIncludes.join('\n') +
        '\nOrder: SBL-2022-000118; status: delivered.\nProduct: SBL-CSR-R2; available: 0.',
    ),
  ).toThrow();
});
