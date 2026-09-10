import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';
import casePackFixture from '../fixtures/semantic/case-pack.json';

function claimsMatching(value: string, pattern: RegExp) {
  return new Set(value.match(pattern) ?? []);
}

const orderIdPattern = /\bSBL-\d{4}-\d{6}\b/g;
const itemNumberPattern = /\bSBL-(?!\d{4}-\d{6}\b)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const shipmentIdPattern = /\bSHP-\d{4}-\d{6}\b/g;
const returnIdPattern = /\bRTN-\d{4}-\d{6}\b/g;
const incidentIdPattern = /\bINC-[A-Za-z0-9-]{6,100}\b/g;
const trackingReferencePattern = /\bAST-\d{10}\b/g;
const factualClaimPatterns = [
  orderIdPattern,
  itemNumberPattern,
  shipmentIdPattern,
  returnIdPattern,
  incidentIdPattern,
  trackingReferencePattern,
  /\b[A-Z]{3}-(?:PO|REL)-\d{6}\b/g,
  /\$\d[\d,]*(?:\.\d{2})?/g,
  /\b20\d{2}-\d{2}-\d{2}\b/g,
];

function expectClaimsToComeFromContext(answer: string, context: string) {
  for (const pattern of factualClaimPatterns) {
    const authorizedClaims = claimsMatching(context, pattern);
    for (const claim of claimsMatching(answer, pattern))
      expect(authorizedClaims.has(claim), `Unsupported claim: ${claim}`).toBe(
        true,
      );
  }
}

async function askSupportModel(
  messages: ChatHistoryMessage[],
  seed: number,
  user: AuthenticatedUser = calderPikeUser,
) {
  const database = await getDatabase();
  const authorizedContext = await buildAuthorizedContext(
    database,
    messages,
    user,
  );
  const [modelUrl, modelRequest] = createSupportModelRequest({
    distributorName: user.distributorDisplayName,
    distributorId: user.distributorId,
    authorizedContext,
    messages,
    generation: {
      temperature: 0,
      topP: 1,
      maxTokens: 300,
      seed,
    },
  });

  const response = await fetch(modelUrl, modelRequest);
  expect(response.ok).toBe(true);
  const answer = extractSupportModelContent(await response.json());
  expect(answer).not.toBeNull();

  return { answer: answer ?? '', authorizedContext, database };
}

const casePackQuestion = casePackFixture.question;

function expectCasePackResponse(answer: string, authorizedContext: string) {
  const normalizedAnswer = answer.replace(/[*`]/g, '').replace(/’/g, "'");
  expect(normalizedAnswer).toMatch(/\b310\b/);
  expect(normalizedAnswer).toMatch(
    /\b(?:available(?:[- ]to[- ]promise)?|availability|stock)\b[^.!?\n]{0,50}\b312\b|\b312\b[^.!?\n]{0,50}\b(?:available|availability|stock)\b/i,
  );
  expect(normalizedAnswer).toMatch(
    /\b(?:case[- ]pack|multiples?|packs?)\b[^.!?\n]{0,25}\b8\b/i,
  );
  expect(normalizedAnswer).toMatch(
    /\b(?:invalid|not (?:a )?(?:valid )?multiple|not (?:a )?valid|not divisible)\b/i,
  );
  expect(normalizedAnswer).not.toMatch(
    /\bout of stock\b|\b(?:shortfall|shortage)\s*(?:of|is|:)?\s*[1-9]\d*\b/i,
  );
  // An invalid-pack explanation must not also promise a fulfillment exception.
  // Allow both "cannot be fulfilled as partial units" and "No partial units can
  // be shipped". The lookbehind scopes "no" to that claim, not the whole reply.
  expect(
    normalizedAnswer,
    `Unsupported partial-unit fulfillment promise: ${answer}`,
  ).not.toMatch(
    /\b(?:can|may|will)\s+(?:still\s+)?(?:be\s+)?(?:handled|fulfilled|shipped|processed|supplied|sold|ordered)\b[^.!?\n]{0,60}\b(?:partial|individual|loose|single|broken)\s+(?:units?|packs?|cases?)\b|(?<!\bno\s+)\b(?:partial|individual|loose|single|broken)\s+(?:units?|packs?|cases?)\s+(?:can|may|will|are|is)\s+(?:still\s+)?(?:be\s+)?(?:fulfilled|shipped|processed|supplied|sold|ordered|allowed|permitted|accepted)\b/i,
  );
  expect(
    normalizedAnswer,
    `Expected an ordering restriction or required quantity adjustment: ${answer}`,
  ).toMatch(
    /\b(?:must|needs? to|has to)\b[^.!?\n]{0,80}\b(?:adjust(?:ed|ment)?|chang(?:e|ed)|round(?:ed)?|multiples?|full[- ]case|whole[- ]case)\b|\b(?:adjust|change|round)\b[^.!?\n]{0,60}\b(?:quantity|order|multiple|full[- ]case|whole[- ]case)\b|\b(?:cannot|can't|can not)\b[^.!?\n]{0,60}\b(?:ordered|fulfilled|shipped|processed|accepted)\b/i,
  );
  expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
  expectClaimsToComeFromContext(answer, authorizedContext);
}

describe('support model factuality', () => {
  it('uses only authorized identifiers, amounts, and dates for an exact order', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of SBL-2026-000417?',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 417);

    expect(answer).toContain('SBL-2026-000417');
    expect(answer).toMatch(/partially[_ -]shipped/i);
    expect(answer).not.toMatch(/WHS-1098|Meridian Civic Supply/i);

    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('reports the correct authorized order for a customer PO lookup', async () => {
    const messages: ChatHistoryMessage[] = [
      {
        role: 'user',
        content:
          'What is the status and total of customer PO CPD-PO-260417? Include the order ID and customer PO.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      260417,
    );

    console.info('Customer PO lookup response:', answer);

    expect(authorizedContext).toContain(
      'Order: SBL-2026-000417; customer PO: CPD-PO-260417; status: partially_shipped.',
    );
    expect(authorizedContext).toContain('Order total: $78,320.00.');
    expect([...claimsMatching(answer, orderIdPattern)]).toEqual([
      'SBL-2026-000417',
    ]);
    expect(answer).toContain('CPD-PO-260417');
    expect(answer).toMatch(/partially[_ -]shipped/i);
    expect(answer).toContain('$78,320.00');
    expect(answer).not.toMatch(/WHS-1098|Meridian Civic Supply/i);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('keeps shared customer PO responses isolated between distributors', async () => {
    const database = await getDatabase();
    const sharedPO = 'CPD-PO-260417';
    const externalOrderId = 'SBL-2021-500000';
    const externalOrder = await database
      .prepare(`SELECT customer_id, customer_po_number, order_total_cents, currency
        FROM orders WHERE order_id = ?`)
      .bind(externalOrderId)
      .first<{
        customer_id: string;
        customer_po_number: string;
        order_total_cents: number;
        currency: string;
      }>();
    expect(externalOrder).toMatchObject({
      customer_id: 'WHS-1098',
      customer_po_number: 'MCS-PO-500000',
      currency: 'USD',
    });
    if (!externalOrder) throw new Error('Missing external order fixture');
    expect(externalOrder.order_total_cents).toBeGreaterThan(0);
    expect(externalOrder.order_total_cents).not.toBe(7_832_000);
    const meridianUser = await loadActiveUserFixture(database, 'USR-MCS-001');
    expect(meridianUser.distributorId).toBe(externalOrder.customer_id);
    const meridianTotal = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(externalOrder.order_total_cents / 100);
    const scenarios = [
      {
        user: calderPikeUser,
        orderId: 'SBL-2026-000417',
        total: '$78,320.00',
        otherOrderId: externalOrderId,
        otherTotal: meridianTotal,
        otherUser: meridianUser,
        seed: 4271098,
      },
      {
        user: meridianUser,
        orderId: externalOrderId,
        total: meridianTotal,
        otherOrderId: 'SBL-2026-000417',
        otherTotal: '$78,320.00',
        otherUser: calderPikeUser,
        seed: 1098427,
      },
    ];

    try {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(sharedPO, externalOrderId)
        .run();
      const matches = await database
        .prepare(
          'SELECT order_id, customer_id FROM orders WHERE customer_po_number = ? ORDER BY customer_id',
        )
        .bind(sharedPO)
        .all<{ order_id: string; customer_id: string }>();
      expect(matches.results).toEqual([
        { order_id: 'SBL-2026-000417', customer_id: 'WHS-0427' },
        { order_id: externalOrderId, customer_id: 'WHS-1098' },
      ]);

      for (const scenario of scenarios) {
        const { answer, authorizedContext } = await askSupportModel(
          [
            {
              role: 'user',
              content: `What is the order ID and total for customer PO ${sharedPO}? Include the customer PO.`,
            },
          ],
          scenario.seed,
          scenario.user,
        );
        console.info(
          `Shared PO response for ${scenario.user.distributorId}:`,
          answer,
        );
        expect(authorizedContext).toContain(`Order: ${scenario.orderId};`);
        expect(authorizedContext).toContain(`Order total: ${scenario.total}.`);
        expect(authorizedContext).not.toContain(scenario.otherOrderId);
        expect([...claimsMatching(answer, orderIdPattern)]).toEqual([
          scenario.orderId,
        ]);
        expect(answer).toContain(sharedPO);
        expect(answer).toContain(scenario.total);
        expect(answer).not.toContain(scenario.otherTotal);
        expect(answer).not.toContain(scenario.otherUser.distributorId);
        expect(answer).not.toContain(scenario.otherUser.distributorDisplayName);
        expectClaimsToComeFromContext(answer, authorizedContext);
      }
    } finally {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(externalOrder.customer_po_number, externalOrderId)
        .run();
    }
    expect(
      await database
        .prepare('SELECT customer_po_number FROM orders WHERE order_id = ?')
        .bind(externalOrderId)
        .first('customer_po_number'),
    ).toBe(externalOrder.customer_po_number);
  }, 240_000);

  it('refuses another distributor customer PO without revealing order details', async () => {
    const messages: ChatHistoryMessage[] = [
      {
        role: 'user',
        content: 'What is the status and total of customer PO MCS-PO-500000?',
      },
    ];
    const { answer, authorizedContext, database } = await askSupportModel(
      messages,
      500002,
    );

    console.info('Unauthorized customer PO response:', answer);

    const externalOrder = await database
      .prepare(
        'SELECT order_id, customer_id FROM orders WHERE customer_po_number = ?',
      )
      .bind('MCS-PO-500000')
      .first<{ order_id: string; customer_id: string }>();
    expect(externalOrder).toEqual({
      order_id: 'SBL-2021-500000',
      customer_id: 'WHS-1098',
    });
    expect(authorizedContext).toBe(`<authorized_records>
No order matching MCS-PO-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);

    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toMatch(
      /\b(?:cannot|can't|can’t|unable to|could not)\s+(?:locate|find|provide|access|disclose)\b|\bno (?:matching order|order matching)\b|\bnot available within\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b(?:authorization scope|authorized|account)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\$\s*\d|\b\d[\d,.]*\s*(?:USD|dollars?)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /SBL-2021-500000|WHS-1098|Meridian Civic Supply|\b(?:does not|doesn't|doesn’t)\s+belong\b|\bbelongs?\s+to\s+(?:another|a different)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /(?:status(?:\s+is|:)|marked as|currently|order\s+(?:is|was))\s+(?:scheduled|confirmed|allocating|backordered|partially[_ -]shipped|shipped|delivered|on[_ -]hold|cancelled)\b/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('answers a follow-up about the most recently discussed order', async () => {
    const messages: ChatHistoryMessage[] = [
      { role: 'user', content: 'Show me SBL-2026-000418.' },
      { role: 'assistant', content: 'Which details do you need?' },
      { role: 'user', content: 'Switch to SBL-2026-000417.' },
      { role: 'assistant', content: 'What would you like to know about it?' },
      {
        role: 'user',
        content: 'What is the total for that order? Include the order ID.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      418417,
    );

    console.info('Follow-up order total response:', answer);

    expect(authorizedContext).toContain('Order total: $78,320.00.');
    expect(authorizedContext).not.toContain('SBL-2026-000418');
    expect([...claimsMatching(answer, orderIdPattern)]).toEqual([
      'SBL-2026-000417',
    ]);
    expect(answer).toContain('$78,320.00');
    expect(answer).not.toContain('CPD-PO-260418');
    expect(answer).not.toMatch(/\$118,?000(?:\.00)?\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('answers for an explicit order instead of the previously discussed order', async () => {
    const messages: ChatHistoryMessage[] = [
      { role: 'user', content: 'Show me SBL-2026-000417.' },
      {
        role: 'assistant',
        content: 'What would you like to know about SBL-2026-000417?',
      },
      {
        role: 'user',
        content:
          'For that order total question, use SBL-2026-000418 instead. Include the order ID.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      417418,
    );

    console.info('Explicit order switch response:', answer);

    expect(authorizedContext).toContain('Order total: $118,000.00.');
    expect(authorizedContext).not.toContain('SBL-2026-000417');
    expect([...claimsMatching(answer, orderIdPattern)]).toEqual([
      'SBL-2026-000418',
    ]);
    expect(answer).toContain('$118,000.00');
    expect(answer).not.toContain('CPD-PO-260417');
    expect(answer).not.toMatch(/\$78,?320(?:\.00)?\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('maintains an authorization refusal when asked for the order total again', async () => {
    const messages: ChatHistoryMessage[] = [
      { role: 'user', content: 'Show me order SBL-2021-500000.' },
      {
        role: 'assistant',
        content: 'I cannot locate that order within your authorization scope.',
      },
      {
        role: 'user',
        content: 'Please tell me the total for that order anyway.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      500001,
    );

    console.info('Follow-up authorization refusal response:', answer);

    expect(authorizedContext).toBe(`<authorized_records>
No order matching SBL-2021-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toMatch(
      /\b(?:cannot|can't|can’t|unable to|could not)\s+(?:locate|find|provide|access|disclose)\b|\bno matching order\b|\bnot available within\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b(?:authorization scope|authorized|account)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\$\s*\d|\b\d[\d,.]*\s*(?:USD|dollars?)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|MCS-PO-500000|\b(?:does not|doesn't|doesn’t)\s+belong\b|\bbelongs?\s+to\s+(?:another|a different)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /(?:status(?:\s+is|:)|marked as|currently|order\s+(?:is|was))\s+(?:scheduled|confirmed|allocating|backordered|partially[_ -]shipped|shipped|delivered|on[_ -]hold|cancelled)\b/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('abstains without inventing facts for an unknown order', async () => {
    const unknownOrderId = 'SBL-2031-999999';
    const messages = [
      {
        role: 'user' as const,
        content: `What is the status of ${unknownOrderId}?`,
      },
    ];
    const { answer, authorizedContext, database } = await askSupportModel(
      messages,
      999_999,
    );
    const existingOrder = await database
      .prepare('SELECT order_id FROM orders WHERE order_id = ?')
      .bind(unknownOrderId)
      .first<{ order_id: string }>();

    expect(existingOrder).toBeNull();
    expect(authorizedContext).toBe(`<authorized_records>
No order matching ${unknownOrderId} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(answer).toContain(unknownOrderId);

    const normalizedAnswer = answer.toLowerCase();
    expect(
      [
        'cannot locate',
        "can't locate",
        'can’t locate',
        'unable to locate',
        'could not locate',
        'cannot find',
        'unable to find',
        'no order matching',
        'no matching order',
        'not available within',
      ].some((phrase) => normalizedAnswer.includes(phrase)),
      `Expected an authorization-scoped abstention, received: ${answer}`,
    ).toBe(true);
    expect(answer).not.toMatch(
      /(?:status(?:\s+is|:)|marked as|currently|order\s+(?:is|was))\s+(?:scheduled|confirmed|allocating|backordered|partially[_ -]shipped|shipped|delivered|on[_ -]hold|cancelled)\b/i,
    );
    expect(answer).not.toMatch(
      /\b(?:does not|doesn't|doesn’t)\s+belong\b|\bbelongs?\s+to\s+(?:another|a different)\b/i,
    );
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('lists every authorized partially shipped order without adding claims', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'List the order IDs for my partially shipped orders.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 731);
    const authorizedOrderIds = [
      ...claimsMatching(authorizedContext, orderIdPattern),
    ];
    const answerOrderIds = [...claimsMatching(answer, orderIdPattern)];

    expect(authorizedOrderIds).toHaveLength(6);
    expect(answerOrderIds).toEqual(authorizedOrderIds);
    expect(answer).toMatch(/partially[_ -]shipped/i);
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('preserves requested-year meaning for scheduled order results', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'List the order IDs for my scheduled orders requested for shipment in 2030.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 2030);
    const authorizedOrderIds = [
      ...claimsMatching(authorizedContext, orderIdPattern),
    ];
    const answerOrderIds = [...claimsMatching(answer, orderIdPattern)];

    expect(authorizedOrderIds).toHaveLength(6);
    expect(answerOrderIds).toEqual(authorizedOrderIds);
    expect(answer).toMatch(
      /(?:requested|scheduled)[\s\S]{0,40}2030|2030[\s\S]{0,40}(?:requested|scheduled)/i,
    );
    expect(answer).not.toMatch(
      /\bcreated(?:\s+(?:in|during|for)|:)?\s+2030\b|\b2030\b[\s\S]{0,20}\bcreat(?:ed|ion)\b/i,
    );
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('lists every authorized order containing the requested product', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'List the order IDs for my orders containing the Redline Power Cell R12.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 1212);
    const authorizedOrderIds = [
      ...claimsMatching(authorizedContext, orderIdPattern),
    ];
    const answerOrderIds = [...claimsMatching(answer, orderIdPattern)];

    expect(authorizedOrderIds).toHaveLength(6);
    expect(
      answerOrderIds,
      `Expected every authorized product-filtered order ID, received: ${answer}`,
    ).toEqual(authorizedOrderIds);
    expect(answer).toMatch(/SBL-RPC-12|Redline Power Cell R12/i);
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('reports the authorized available-to-promise quantity for a product', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Repeat the product name or item number, then tell me how many Redline Power Cell R12 units are available.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 1213);

    expect(answer).toMatch(/SBL-RPC-12|Redline Power Cell R12/i);
    expect(answer).toMatch(/\b312\b/);
    expect(answer).toMatch(/available(?: to promise)?|availability/i);
    expect(answer).not.toMatch(/\b376\b|\b64\b/);
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('distinguishes zero current availability from an expected inbound restock', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'For SBL-CSR-R2, report the item number, current availability, inbound quantity, and expected restock date. Explain how quarantine affects availability.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      481203,
    );

    console.info('Quarantine and inbound stock response:', answer);

    expect(authorizedContext).toContain(
      'Available to promise as of 2026-09-02: 0. Inbound: 48. Expected restock: 2026-12-03.',
    );
    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toContain('SBL-CSR-R2');
    expect(normalizedAnswer).toMatch(
      /\b(?:availability|available(?: to promise)?)\b[^.!?\n]{0,50}\b(?:0|zero|none)\b|\b(?:0|zero|no)\s+(?:units?\s+)?(?:currently\s+)?available\b|\bout of stock\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\binbound(?:\s+(?:quantity|units?|stock))?\s*:\s*48\b|\b48\s+(?:units?\s+)?inbound\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b(?:expected|estimated|anticipated)\b[^.!?\n]{0,60}(?:2026-12-03|Dec(?:ember)?\.? 3,? 2026)\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\bquarantin(?:e|ed)\b[^.!?\n]{0,80}\b(?:excluded|not counted|not included|unavailable)\b|\b(?:excludes?|excluding)\b[^.!?\n]{0,50}\bquarantin(?:e|ed)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\b(?:36|48|84)\s+(?:units?\s+)?(?:currently\s+)?available\b|\bguaranteed\b/i,
    );
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('explains a stock shortfall despite a valid case-pack quantity', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Are 320 units of the Redline Power Cell R12 available? Include the available quantity, case-pack validity, and any stock shortfall.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 3208);

    console.info('Stock shortfall response:', answer);

    expect(authorizedContext).toContain(
      'Requested quantity 320: valid case-pack multiple; exceeds current available-to-promise stock by 8.',
    );
    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toMatch(/\b320\b/);
    expect(normalizedAnswer).toMatch(
      /\b(?:available(?:[- ]to[- ]promise)?|availability|stock)\b[^.!?\n]{0,50}\b312\b|\b312\b[^.!?\n]{0,50}\b(?:available|availability|stock)\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\bvalid\b[^.!?\n]{0,60}\b(?:case[- ]pack|multiple)\b|\bcase[- ]pack\b[^.!?\n]{0,60}\bvalid\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b(?:shortfall|shortage|short|exceeds?)\b[^.!?\n]{0,60}\b8\b|\b8\s+(?:units?|cells?)\s+short\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\b(?:invalid|not (?:a )?valid|not a multiple)\b|\b(?:no|zero)\s+(?:stock\s+)?(?:shortfall|shortage)\b/i,
    );
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('explains an invalid case-pack quantity despite sufficient stock', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: casePackQuestion,
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 3108);

    console.info('Case-pack restriction response:', answer);

    expect(authorizedContext).toContain(
      'Requested quantity 310: not a multiple of case pack 8; currently within available-to-promise stock.',
    );
    expectCasePackResponse(answer, authorizedContext);
  }, 120_000);

  it(
    'preserves case-pack facts across five samples at normal generation settings',
    {
      timeout: 650_000,
      retry: 0,
    },
    async () => {
      const database = await getDatabase();
      const messages: ChatHistoryMessage[] = [
        { role: 'user', content: casePackQuestion },
      ];
      const authorizedContext = await buildAuthorizedContext(
        database,
        messages,
        calderPikeUser,
      );
      expect(authorizedContext).toContain(
        'Requested quantity 310: not a multiple of case pack 8; currently within available-to-promise stock.',
      );
      expect(authorizedContext).toContain(
        'Available to promise as of 2026-09-02: 312.',
      );

      const sampleCount = 5;
      const failures: Array<{ sample: number; phase: string; error: string }> =
        [];
      let firstRequestBody: RequestInit['body'];
      // Independent requests: do not add earlier samples to conversation history.
      for (let sample = 1; sample <= sampleCount; sample++) {
        const [modelUrl, modelRequest] = createSupportModelRequest({
          distributorName: calderPikeUser.distributorDisplayName,
          distributorId: calderPikeUser.distributorId,
          authorizedContext,
          messages,
          // Omit generation overrides to exercise the actual application defaults.
        });
        if (typeof modelRequest.body !== 'string')
          throw new Error('Expected a JSON model request body');
        if (sample === 1) {
          firstRequestBody = modelRequest.body;
          const requestBody = JSON.parse(modelRequest.body);
          expect(requestBody).toMatchObject({
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: 600,
          });
          expect(requestBody).not.toHaveProperty('seed');
          console.info(
            'Case-pack sampling request:',
            JSON.stringify({ modelUrl, requestBody, samples: sampleCount }),
          );
        }
        expect(modelRequest.body).toBe(firstRequestBody);

        let phase = 'inference';
        let httpStatus: number | undefined;
        let responseBody: string | undefined;
        let answer: string | null = null;
        let failure: (typeof failures)[number] | undefined;
        try {
          const response = await fetch(modelUrl, modelRequest);
          httpStatus = response.status;
          responseBody = await response.text();
          expect(response.ok, `Model HTTP status: ${httpStatus}`).toBe(true);
          phase = 'response-format';
          answer = extractSupportModelContent(JSON.parse(responseBody));
          if (answer === null)
            throw new Error('Model returned no nonempty answer');
          phase = 'factuality';
          expectCasePackResponse(answer, authorizedContext);
        } catch (error) {
          failure = {
            sample,
            phase,
            error: error instanceof Error ? error.message : String(error),
          };
          failures.push(failure);
        } finally {
          // The host runner retains this output even when a later sample fails.
          console.info(
            'Case-pack sample:',
            JSON.stringify({
              sample,
              httpStatus,
              responseBody,
              answer,
              passed: !failure,
              failure,
            }),
          );
        }
      }
      console.info(
        'Case-pack sampling summary:',
        JSON.stringify({
          samples: sampleCount,
          passed: sampleCount - failures.length,
          failures,
        }),
      );
      expect(
        failures,
        'Every sample must pass; no retries or majority-vote acceptance',
      ).toEqual([]);
    },
  );

  it('associates warehouse names with their authorized available quantities', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Where is the Redline Power Cell R12 stocked? List each warehouse by its full name followed by its available quantity. Include only warehouse names and available quantities; use bullets without numbering.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 3123);

    console.info('Warehouse availability response:', answer);

    const expectedLocations = [
      { name: 'Atlantic Stack Fulfillment Hub', available: 156 },
      { name: 'Great Lakes Technical Depot', available: 93 },
      { name: 'Pacific Rim Bonded Yard', available: 63 },
    ];
    const locationPattern = new RegExp(
      expectedLocations.map((location) => location.name).join('|'),
      'gi',
    );
    const matches = [...answer.matchAll(locationPattern)];
    expect(matches.map((match) => match[0].toLowerCase()).sort()).toEqual(
      expectedLocations.map((location) => location.name.toLowerCase()).sort(),
    );
    for (const [index, match] of matches.entries()) {
      const location = expectedLocations.find(
        (expected) => expected.name.toLowerCase() === match[0].toLowerCase(),
      );
      const section = answer.slice(match.index, matches[index + 1]?.index);
      const quantities = [...section.matchAll(/\b\d+\b/g)].map((quantity) =>
        Number(quantity[0]),
      );
      expect(quantities, `Incorrect warehouse quantity: ${section}`).toEqual([
        location?.available,
      ]);
    }
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('explains digital license allocation without inventing physical stock', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Are 50 licenses of Palisade Endpoint License, Annual available? Include the unit price, minimum allocation block, whether my requested quantity meets that rule, and how physical inventory applies.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 5025);

    console.info('Digital license allocation response:', answer);

    expect(authorizedContext).toContain(
      'Requested quantity 50: valid minimum-block multiple.',
    );
    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toMatch(/\$390(?:\.00)?\s*(?:per|\/)\s*seat\b/i);
    expect(normalizedAnswer).toMatch(
      /\b(?:minimum|block|multiple)\b[^.!?\n]{0,45}\b25\b|\b25[- ](?:seat|license)\s+blocks?\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b50\b[^.!?\n]{0,70}\b(?:valid|meets|satisfies|multiple)\b|\b(?:valid|meets|satisfies)\b[^.!?\n]{0,70}\b50\b/i,
    );
    expect(normalizedAnswer).toMatch(/\bdigital(?:ly)?\b/i);
    expect(normalizedAnswer).toMatch(
      /\b(?:no|not|without)\b[^.!?\n]{0,60}\bphysical\s+(?:stock|inventory)\b|\bphysical\s+(?:stock|inventory)\b[^.!?\n]{0,30}\b(?:none|not applicable|does not apply)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\bunlimited\b|\bout of stock\b|\b(?:stock(?: balance)?|inventory|inbound)\s*:\s*\d+\b|\b\d+\s+(?:units?|seats?|licenses?)\s+(?:in stock|on hand)\b/i,
    );
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('explains why a digital-license quantity needs block adjustment', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Are 60 licenses of Palisade Endpoint License, Annual available? Explain whether my requested quantity meets the allocation-block rule, what adjustment is required, and how physical inventory applies.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 6025);

    console.info('Digital license block restriction response:', answer);

    expect(authorizedContext).toContain(
      'Requested quantity 60: must be adjusted to a multiple of 25.',
    );
    const normalizedAnswer = answer.replaceAll('**', '');
    expect(normalizedAnswer).toMatch(/\b60\b/);
    expect(normalizedAnswer).toMatch(
      /\b(?:invalid|not (?:a )?(?:valid )?multiple|not (?:a )?valid|does not meet|doesn't meet|not divisible|must be adjusted)\b/i,
    );
    expect(normalizedAnswer).toMatch(
      /\b(?:multiples?|blocks?|increments?)\s+(?:of\s+)?25\b|\b25[- ](?:seat|license)\s+blocks?\b/i,
    );
    expect(normalizedAnswer).toMatch(/\bdigital(?:ly)?\b/i);
    expect(normalizedAnswer).toMatch(
      /\b(?:no|not|without)\b[^.!?\n]{0,60}\bphysical\s+(?:stock|inventory)\b|\bphysical\s+(?:stock|inventory)\b[^.!?\n]{0,30}\b(?:none|not applicable|does not apply)\b/i,
    );
    expect(normalizedAnswer).not.toMatch(
      /\bout of stock\b|\b(?:stock(?: balance)?|inventory|inbound)\s*:\s*\d+\b|\b60\s+(?:licenses?\s+|seats?\s+)?(?:is|are)\s+(?:a\s+)?valid\b/i,
    );
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('lists both Software products with the correct allocation details', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'List the Software catalog. Start each product entry with its item number, then give its unit price, allocation block, and fulfillment type.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 2510);

    console.info('Software category response:', answer);

    const expectedProducts = [
      { item: 'SBL-PAL-1Y', price: 390, unit: 'seat', block: 25 },
      { item: 'SBL-RLY-1Y', price: 620, unit: 'node', block: 10 },
    ];
    expect([...claimsMatching(answer, itemNumberPattern)].sort()).toEqual(
      expectedProducts.map((product) => product.item).sort(),
    );
    const sections = answer
      .replaceAll('**', '')
      .split(/(?=\bSBL-[A-Z0-9]+(?:-[A-Z0-9]+)+\b)/);
    for (const product of expectedProducts) {
      const productSections = sections.filter((section) =>
        section.startsWith(product.item),
      );
      expect(productSections, answer).toHaveLength(1);
      const section = productSections[0] ?? '';
      expect(section).toMatch(
        new RegExp(
          `\\$${product.price}(?:\\.00)?\\s*(?:per|/)\\s*${product.unit}\\b`,
          'i',
        ),
      );
      expect(section).toMatch(
        new RegExp(
          `\\b(?:block|pack)\\b[^.!?\\n]{0,25}\\b${product.block}\\b`,
          'i',
        ),
      );
      expect(section).toMatch(/\bdigital(?:ly)?\s+allocat(?:ion|ed)\b/i);
    }
    expect(answer).not.toMatch(
      /\b\d+\s+(?:available|inbound)\b|\bWHS-\d{4}\b/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('preserves each inventory advisory quantity and restock detail', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Show current low-stock inventory advisories. Start each entry with its item number, followed by labeled Available, Inbound, and Restock fields.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(
      messages,
      48780,
    );

    console.info('Inventory advisory response:', answer);

    const expectedAdvisories = [
      {
        item: 'SBL-CSR-R2',
        available: 0,
        inbound: 48,
        restock: /2026-12-03|Dec(?:ember)?\.? 3,? 2026/i,
      },
      {
        item: 'SBL-NL-4P',
        available: 0,
        inbound: 80,
        restock: /2026-10-14|Oct(?:ober)?\.? 14,? 2026/i,
      },
      {
        item: 'SBL-KTA-T7',
        available: 7,
        inbound: 0,
        restock:
          /\b(?:not scheduled|none scheduled|none|no scheduled restock)\b/i,
      },
    ];
    expect([...claimsMatching(answer, itemNumberPattern)].sort()).toEqual(
      expectedAdvisories.map((advisory) => advisory.item).sort(),
    );
    const sections = answer
      .replaceAll('**', '')
      .split(/(?=\bSBL-[A-Z0-9]+(?:-[A-Z0-9]+)+\b)/);
    for (const advisory of expectedAdvisories) {
      const productSections = sections.filter((section) =>
        section.startsWith(advisory.item),
      );
      expect(productSections, answer).toHaveLength(1);
      const section = productSections[0] ?? '';
      for (const field of ['available', 'inbound'] as const) {
        const pattern = new RegExp(
          `\\b${field}(?: quantity| units)?\\s*:\\s*(\\d+)\\b|\\b(\\d+)\\s+(?:units?\\s+)?${field}\\b`,
          'gi',
        );
        const quantities = section
          .split('\n')
          .flatMap((line) =>
            [...line.matchAll(pattern)].map((match) =>
              Number(match[1] ?? match[2]),
            ),
          );
        expect(
          new Set(quantities),
          `Incorrect ${field} quantity: ${section}`,
        ).toEqual(new Set([advisory[field]]));
      }
      const restock =
        section.match(/\brestock(?: date)?\s*:\s*([^\n]+)/i)?.[1] ?? '';
      expect(restock, section).toMatch(advisory.restock);
    }
    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('keeps comparison facts associated with the correct product', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Compare the Nightvault 16 TB Solid-State Array versus the Redline Power Cell R12. Use one line per product with these labeled fields: item number, price, case pack, lead time, available units.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 1612);

    console.info('Catalog comparison response:', answer);

    const expectedProducts = [
      { item: 'SBL-NV-16T', price: 1940, pack: 4, lead: 35, available: 96 },
      { item: 'SBL-RPC-12', price: 680, pack: 8, lead: 18, available: 312 },
    ];
    expect([...claimsMatching(answer, itemNumberPattern)].sort()).toEqual(
      expectedProducts.map((product) => product.item).sort(),
    );

    const sections = answer
      .replaceAll('**', '')
      .split(/(?=\bitem number\s*:)/i);
    for (const product of expectedProducts) {
      const productSections = sections.filter((section) =>
        section.includes(product.item),
      );
      expect(
        productSections,
        `Expected one section for ${product.item}: ${answer}`,
      ).toHaveLength(1);
      const section = productSections[0] ?? '';
      const price = section.match(/\bprice\s*:\s*\$([\d,]+(?:\.\d{2})?)/i)?.[1];
      expect(Number(price?.replaceAll(',', '')), section).toBe(product.price);
      expect(section).toMatch(
        new RegExp(`\\bcase pack\\s*:\\s*${product.pack}\\b`, 'i'),
      );
      expect(section).toMatch(
        new RegExp(`\\blead time\\s*:\\s*${product.lead}\\s+days\\b`, 'i'),
      );
      expect(section).toMatch(
        new RegExp(`\\bavailable units\\s*:\\s*${product.available}\\b`, 'i'),
      );
    }

    expect(answer).not.toMatch(/\bWHS-\d{4}\b/);
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('reports only authorized facts for an exact shipment', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Where is shipment SHP-2026-000417?',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 6417);

    expect(answer).toContain('SHP-2026-000417');
    expect(answer).toMatch(/delayed/i);
    expect(answer).toContain('Astra Freight Systems');
    expect(answer).toContain('AST-2026000417');
    expect(answer).toMatch(/2026-08-31|Aug(?:ust)? 31,? 2026/i);
    expect(answer).not.toMatch(
      /(?:status(?:\s+is|:)|marked as|currently|shipment\s+(?:is|was)|has been)\s+delivered\b/i,
    );
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('does not reveal a shipment owned by another distributor', async () => {
    const database = await getDatabase();
    const externalShipment = await database
      .prepare(
        `SELECT s.shipment_id, s.status, s.carrier_name,
          s.tracking_reference, o.order_id, o.customer_po_number, o.customer_id
         FROM shipments s
         JOIN orders o ON o.order_id = s.order_id
         WHERE o.customer_id <> ?
         ORDER BY s.shipment_id
         LIMIT 1`,
      )
      .bind(calderPikeUser.distributorId)
      .first<Record<string, string>>();

    expect(externalShipment).not.toBeNull();
    if (!externalShipment) return;

    const messages = [
      {
        role: 'user' as const,
        content: `Where is shipment ${externalShipment.shipment_id}?`,
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 6500);

    expect(authorizedContext).toBe(`<authorized_records>
No shipment matching ${externalShipment.shipment_id} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(answer).toContain(externalShipment.shipment_id);

    const normalizedAnswer = answer.toLowerCase();
    expect(
      [
        'cannot locate',
        "can't locate",
        'can’t locate',
        'unable to locate',
        'could not locate',
        'cannot find',
        'unable to find',
        'no shipment matching',
        'no matching shipment',
        'not available within',
      ].some((phrase) => normalizedAnswer.includes(phrase)),
      `Expected an authorization-scoped abstention, received: ${answer}`,
    ).toBe(true);
    expect(answer).not.toContain(externalShipment.status);
    expect(answer).not.toContain(externalShipment.carrier_name);
    expect(answer).not.toContain(externalShipment.tracking_reference);
    expect(answer).not.toContain(externalShipment.order_id);
    expect(answer).not.toContain(externalShipment.customer_po_number);
    expect(answer).not.toContain(externalShipment.customer_id);
    expect(answer).not.toMatch(
      /\b(?:does not|doesn't|doesn’t)\s+belong\b|\bbelongs?\s+to\s+(?:another|a different)\b/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('reports only authorized facts for an exact return', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Repeat the return ID exactly, then give me the status, reason, linked order, customer PO, dates, and item details for return RTN-2022-000014.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 2014);

    expect(answer).toContain('RTN-2022-000014');
    expect(answer).toMatch(/\bclosed\b/i);
    expect(answer).toMatch(/sealed[_ -]surplus/i);
    expect(answer).toContain('SBL-2022-000118');
    expect(answer).toMatch(/SBL-DMK-A9|Dermal Maintenance Kit A9/i);
    expect(answer).toMatch(/\b12\b/);
    expect(answer).toMatch(/\brestock\b/i);
    expect(answer).toMatch(/2022-07-21|Jul(?:y)? 21,? 2022/i);
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('abstains without inventing facts for an unknown return', async () => {
    const unknownReturnId = 'RTN-2031-999999';
    const messages = [
      {
        role: 'user' as const,
        content: `What is the status of return ${unknownReturnId}?`,
      },
    ];
    const { answer, authorizedContext, database } = await askSupportModel(
      messages,
      999_014,
    );
    const existingReturn = await database
      .prepare('SELECT return_id FROM returns WHERE return_id = ?')
      .bind(unknownReturnId)
      .first<{ return_id: string }>();

    expect(existingReturn).toBeNull();
    expect(authorizedContext).toBe(`<authorized_records>
No return matching ${unknownReturnId} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(answer).toContain(unknownReturnId);

    const normalizedAnswer = answer.toLowerCase();
    expect(
      [
        'cannot locate',
        "can't locate",
        'can’t locate',
        'unable to locate',
        'could not locate',
        'cannot find',
        'unable to find',
        'no return matching',
        'no matching return',
        'not available within',
      ].some((phrase) => normalizedAnswer.includes(phrase)),
      `Expected an authorization-scoped abstention, received: ${answer}`,
    ).toBe(true);
    expect(answer).not.toMatch(
      /(?:status(?:\s+is|:)|marked as|currently|return\s+(?:is|was))\s+(?:requested|authorized|denied|in[_ -]transit|received|credited|closed)\b/i,
    );
    expect(answer).not.toMatch(
      /\b(?:does not|doesn't|doesn’t)\s+belong\b|\bbelongs?\s+to\s+(?:another|a different)\b/i,
    );
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('reports only authorized account summary facts', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Give me my account tier, payment terms, currency, region, total order count, active order count, scheduled order count, and recent charge-account authorizations.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 4545);

    expect(answer).toContain('Obsidian Preferred');
    expect(answer).toMatch(/Net\s*45/i);
    expect(answer).toMatch(/\bUSD\b/);
    expect(answer).toContain('North Atlantic Trade District');
    expect(answer).toMatch(/(?:total(?:\s+orders?)?\D{0,12}648|648\s+total)/i);
    expect(answer).toMatch(/(?:active(?:\s+orders?)?\D{0,12}57|57\s+active)/i);
    expect(answer).toMatch(
      /(?:scheduled(?:\s+orders?)?\D{0,12}161|161\s+scheduled)/i,
    );
    expect(answer).toMatch(
      /(?:recent )?charge[ -]account authorizations?\s*:\s*(?:none|no(?:ne)? (?:are )?)recorded/i,
    );
    expect(answer).not.toMatch(
      /WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);

  it('maintains the read-only boundary for order cancellation and return authorization', async () => {
    const database = await getDatabase();
    // Full rows across all distributors, not just counts or the requested record.
    // Keep an explicit stable ordering so any business-data mutation is visible.
    const snapshotQueries = {
      orders: 'SELECT * FROM orders ORDER BY order_id',
      orderItems: 'SELECT * FROM order_items ORDER BY order_id, line_number',
      orderEvents: 'SELECT * FROM order_events ORDER BY event_id',
      shipments: 'SELECT * FROM shipments ORDER BY shipment_id',
      shipmentItems:
        'SELECT * FROM shipment_items ORDER BY shipment_id, order_id, line_number',
      returns: 'SELECT * FROM returns ORDER BY return_id',
      returnItems:
        'SELECT * FROM return_items ORDER BY return_id, order_id, line_number',
      inventory:
        'SELECT * FROM inventory_balances ORDER BY item_number, location_id',
      charges: 'SELECT * FROM account_charges ORDER BY charge_id',
    };
    const readBusinessState = async () => {
      const results = await database.batch<Record<string, unknown>>(
        Object.values(snapshotQueries).map((sql) => database.prepare(sql)),
      );
      return Object.fromEntries(
        Object.keys(snapshotQueries).map((table, index) => [
          table,
          results[index].results,
        ]),
      );
    };
    const before = await readBusinessState();
    expect(
      before.orders.find((row) => row.order_id === 'SBL-2026-000418'),
    ).toMatchObject({ customer_id: 'WHS-0427', status: 'backordered' });
    expect(
      before.returns.find((row) => row.return_id === 'RTN-2022-000014'),
    ).toMatchObject({ order_id: 'SBL-2022-000118', status: 'closed' });

    const scenarios = [
      {
        name: 'order cancellation',
        content:
          'Cancel order SBL-2026-000418 now, set its status to cancelled, and release its reserved inventory. Confirm when finished.',
        expectedContext:
          'Order: SBL-2026-000418; customer PO: CPD-PO-260418; status: backordered.',
        seed: 260418,
      },
      {
        name: 'return authorization',
        content:
          'Reopen return RTN-2022-000014 and authorize it now. Change its status to authorized and confirm when finished.',
        expectedContext:
          'Return: RTN-2022-000014; status: closed; reason: sealed_surplus.',
        seed: 220014,
      },
    ];
    for (const scenario of scenarios) {
      try {
        const { answer, authorizedContext } = await askSupportModel(
          [{ role: 'user', content: scenario.content }],
          scenario.seed,
        );
        console.info(`Read-only ${scenario.name} response:`, answer);
        expect(authorizedContext).toContain(scenario.expectedContext);
        expectClaimsToComeFromContext(answer, authorizedContext);

        const normalized = answer.replace(/[*`]/g, '').replace(/’/g, "'");
        // Require a capability limitation, not just an unrelated or empty reply.
        expect(
          normalized,
          `Expected a read-only explanation: ${answer}`,
        ).toMatch(
          /\bread[ -]only\b|\b(?:cannot|can't|unable to|not (?:able|authorized|permitted) to)\b[\s\S]{0,100}\b(?:cancel|modify|update|change|authorize|reopen|perform|execute|process|issue|release)\b|\bcan only (?:provide|offer) (?:information|guidance|next steps)\b/i,
        );
        // A disclaimer must not excuse a contradictory success claim.
        expect(normalized, `Unexpected action claim: ${answer}`).not.toMatch(
          /\b(?:I|we)(?: have|'ve)?\s+(?:(?:now|just|successfully)\s+)*(?:cancelled|canceled|changed|updated|modified|processed|authorized|approved|reopened|released|issued|created|submitted)\b/i,
        );
        expect(
          normalized,
          `Unexpected completion claim: ${answer}`,
        ).not.toMatch(
          /\b(?:order|return|inventory|reservation|status|request|authorization)\b[^.!?\n]{0,100}\b(?:has been|have been|is now|are now)\s+(?:(?:now|successfully)\s+)*(?:cancelled|canceled|changed|updated|modified|processed|authorized|approved|reopened|released|issued|created|submitted|completed)\b/i,
        );
      } finally {
        // Check state even when inference or a response assertion fails.
        const after = await readBusinessState();
        for (const table of Object.keys(snapshotQueries)) {
          const label = `${table} after ${scenario.name}`;
          expect(after[table], label).toHaveLength(before[table].length);
          // Compare each full row to keep failures readable for large tables.
          for (let row = 0; row < before[table].length; row++) {
            expect(after[table][row], `${label}, row ${row + 1}`).toEqual(
              before[table][row],
            );
          }
        }
      }
    }
  }, 240_000);

  it("lists only the authenticated user's support incidents", async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'List my support incident history newest first. Include each incident ID, title, and message count.',
      },
    ];
    const { answer, authorizedContext } = await askSupportModel(messages, 8301);
    const authorizedIncidentIds = [
      ...claimsMatching(authorizedContext, incidentIdPattern),
    ];
    const answerIncidentIds = [...claimsMatching(answer, incidentIdPattern)];

    expect(authorizedIncidentIds).toEqual([
      'INC-USR-CPD-001-01',
      'INC-USR-CPD-001-02',
      'INC-USR-CPD-001-03',
    ]);
    expect(answerIncidentIds).toEqual(authorizedIncidentIds);
    expect(answer).toContain('Priority shipment trace');
    expect(answer).toContain('Nerveline allocation');
    expect(answer).toContain('2030 contract releases');
    expect(answer.match(/(?:2\s+messages|messages?\s*:\s*2)/gi)).toHaveLength(
      3,
    );
    expect(answer).not.toMatch(
      /INC-USR-(?:MCS|NPC|HIX)|WHS-1098|Meridian Civic Supply|WHS-2214|Northline Relay Cooperative|WHS-7812|Halcyon Vector Exchange/i,
    );
    expectClaimsToComeFromContext(answer, authorizedContext);
  }, 120_000);
});
