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
