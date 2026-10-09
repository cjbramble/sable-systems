import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const customOrderId = 'REVIEW-CUSTOM-PO';
const foreignOrderId = 'REVIEW-FOREIGN-ORDER';

async function customOrders(database: D1Database) {
  expect(
    (
      await database
        .prepare('SELECT order_id FROM orders WHERE order_id IN (?, ?)')
        .bind(customOrderId, foreignOrderId)
        .all()
    ).results,
  ).toEqual([]);
  onTestFinished(async () => {
    await database
      .prepare('DELETE FROM orders WHERE order_id IN (?, ?)')
      .bind(customOrderId, foreignOrderId)
      .run();
  });
  const clone = `INSERT INTO orders (
    order_id, customer_id, placed_by_user_id, customer_po_number, created_on,
    requested_ship_date, status, currency, order_total_cents, shipping_region
  ) SELECT ?, customer_id, placed_by_user_id, ?, created_on,
    requested_ship_date, status, currency, order_total_cents, shipping_region
    FROM orders WHERE order_id = ?`;
  await database.batch([
    database.prepare(clone).bind(customOrderId, 'SOME-PO', 'SBL-2022-000118'),
    database
      .prepare(clone)
      .bind(foreignOrderId, 'FOREIGN-CUSTOM-PO', 'SBL-2021-500000'),
  ]);
}

describe('custom order response grounding', () => {
  test('returns and saves a verified custom order ID from a scoped lookup', async ({
    database,
    supportApi,
  }) => {
    await customOrders(database);
    const incidentId = 'INC-CUSTOM-ORDER-GROUNDING';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply = `Order: ${customOrderId} is delivered.`;
    const model = supportApi.mockModel(reply);
    const response = await chat(
      session.request({
        expectedRevision: 0,
        incidentId,
        messageId: 'MSG-CUSTOM-ORDER-GROUNDING',
        message: `Show order ID: ${customOrderId}.`,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: reply,
      revision: 1,
    });
    expect(model).toHaveBeenCalledOnce();
    const request = JSON.parse(model.mock.calls[0][1]?.body as string);
    const { records } = JSON.parse(request.messages[1].content);
    expect(records).toContain(
      `Order: ${customOrderId}; customer PO: SOME-PO; status: delivered.`,
    );
    expect(records).not.toContain(foreignOrderId);
    expect(
      (await supportApi.messageContents(incidentId)).results,
    ).toMatchObject([
      { role: 'user', content: `Show order ID: ${customOrderId}.` },
      { role: 'assistant', content: reply },
    ]);
  });

  test.for([
    ['altered ID', `${customOrderId}-X`],
    ['foreign ID', foreignOrderId],
    ['PO used as an ID', 'SOME-PO'],
  ])(
    'refuses %s without saving the exchange',
    async ([_label, claimedId], { database, supportApi }) => {
      await customOrders(database);
      const incidentId = 'INC-CUSTOM-ORDER-REJECTED';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const model = supportApi.mockModel(
        `Order ID: ${claimedId} is delivered.`,
      );
      const response = await chat(
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId: 'MSG-CUSTOM-ORDER-REJECTED',
          message: `Show order ID: ${customOrderId}.`,
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        code: 'request_not_saved',
        error:
          'The response contained an unverified record reference. Please try again.',
      });
      expect((await supportApi.messageContents(incidentId)).results).toEqual(
        [],
      );
      expect(await supportApi.findIncident(incidentId)).toBeNull();
    },
  );
});
