import { describe, expect } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { buildAuthorizedContext } from '@/db/support';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('compound support questions', () => {
  test('retrieves an order and a product for one question', async ({
    database,
  }) => {
    const context = await buildAuthorizedContext(
      database,
      ask('Where is SBL-2022-000118, and is SBL-RPC-12 in stock?'),
      calderPikeUser,
    );

    expect(context).toMatch(/^<authorized_records>\n/);
    expect(context.match(/<\/?authorized_records>/g)).toHaveLength(2);
    expect(context).toContain('Part 1 of 2: order SBL-2022-000118');
    expect(context).toContain(
      'Order: SBL-2022-000118; customer PO: CPD-PO-220118; status: delivered.',
    );
    expect(context).toContain('Part 2 of 2: catalog request');
    expect(context).toContain('Product: SBL-RPC-12 — Redline Power Cell R12');
    expect(context).toContain('Available to promise: 312.');
  });

  test('keeps a missing record scoped without dropping the authorized one', async ({
    database,
  }) => {
    const foreign = await database
      .prepare(`SELECT order_id, customer_po_number FROM orders
        WHERE customer_id = 'WHS-1098' ORDER BY order_id LIMIT 1`)
      .first<{ order_id: string; customer_po_number: string }>();
    expect(foreign).not.toBeNull();

    const context = await buildAuthorizedContext(
      database,
      ask(`Show order SBL-2022-000118 and order ${foreign!.order_id}.`),
      calderPikeUser,
    );

    expect(context).toContain('Order: SBL-2022-000118;');
    expect(context).toContain(
      `No order matching ${foreign!.order_id} is available within Calder Pike Distribution's authorization scope.`,
    );
    expect(context).not.toContain(foreign!.customer_po_number);
    expect(context.match(/\bWHS-\d{4}\b/g) ?? []).toEqual(
      expect.arrayContaining(['WHS-0427']),
    );
    expect(context).not.toMatch(/\bWHS-(?!0427)\d{4}\b/);
  });

  test('sends a partly unavailable compound question to the model', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-COMPOUND-QUESTION';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(
      'Order SBL-2022-000118 was delivered. I cannot locate SBL-2099-000001 within your authorization scope.',
    );

    const response = await chat(
      session.request({
        expectedRevision: 0,
        incidentId,
        messageId: 'MSG-COMPOUND-QUESTION',
        message: 'Show order SBL-2022-000118 and order SBL-2099-000001.',
      }),
    );

    expect(response.status).toBe(200);
    expect(model).toHaveBeenCalledOnce();
    const body = JSON.parse(model.mock.calls[0][1]?.body as string) as {
      messages: { content: string }[];
    };
    const { records } = JSON.parse(body.messages[1].content) as {
      records: string;
    };
    expect(records).toContain('Order: SBL-2022-000118;');
    expect(records).toContain('No order matching SBL-2099-000001');
  });
});
