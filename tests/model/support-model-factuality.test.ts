import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';
import { calderPikeUser } from '../fixtures/users';

function claimsMatching(value: string, pattern: RegExp) {
  return new Set(value.match(pattern) ?? []);
}

const orderIdPattern = /\bSBL-\d{4}-\d{6}\b/g;
const itemNumberPattern = /\bSBL-(?!\d{4}-\d{6}\b)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const shipmentIdPattern = /\bSHP-\d{4}-\d{6}\b/g;
const trackingReferencePattern = /\bAST-\d{10}\b/g;
const factualClaimPatterns = [
  orderIdPattern,
  itemNumberPattern,
  shipmentIdPattern,
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
  messages: Array<{ role: 'user'; content: string }>,
  seed: number,
) {
  const database = await getDatabase();
  const authorizedContext = await buildAuthorizedContext(
    database,
    messages,
    calderPikeUser,
  );
  const [modelUrl, modelRequest] = createSupportModelRequest({
    distributorName: calderPikeUser.distributorDisplayName,
    distributorId: calderPikeUser.distributorId,
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
});
