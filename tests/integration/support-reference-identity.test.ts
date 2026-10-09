import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import { buildAuthorizedContext, buildSupportContext } from '@/db/support';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

const orderId = 'SBL-2099-910001';
const poOrderId = 'SBL-2099-910002';
const sameOrderId = 'SBL-2099-910003';
const foreignOrderId = 'SBL-2099-910004';
const shipmentId = 'SHP-2099-910001';
const trackingShipmentId = 'SHP-2099-910002';
const sameShipmentId = 'SHP-2099-910003';
const foreignShipmentId = 'AST-2099910001';

const ask = (content: string) => [{ role: 'user' as const, content }];

// Clone only temporary parents; leave every seeded row unchanged.
async function identityRecords(database: D1Database) {
  const orderIds = [orderId, poOrderId, sameOrderId, foreignOrderId];
  expect(
    (
      await database
        .prepare(`SELECT order_id FROM orders WHERE order_id IN (?, ?, ?, ?)`)
        .bind(...orderIds)
        .all()
    ).results,
  ).toEqual([]);
  onTestFinished(async () => {
    await database
      .prepare('DELETE FROM orders WHERE order_id IN (?, ?, ?, ?)')
      .bind(...orderIds)
      .run();
  });
  const cloneOrder = `INSERT INTO orders (
    order_id, customer_id, placed_by_user_id, customer_po_number, created_on,
    requested_ship_date, status, currency, order_total_cents, shipping_region
  ) SELECT ?, customer_id, placed_by_user_id, ?, created_on,
    requested_ship_date, status, currency, order_total_cents, shipping_region
    FROM orders WHERE order_id = ?`;
  await database.batch([
    database
      .prepare(cloneOrder)
      .bind(orderId, 'IDENTITY-FIRST-PO', 'SBL-2026-000417'),
    database.prepare(cloneOrder).bind(poOrderId, orderId, 'SBL-2026-000418'),
    database
      .prepare(cloneOrder)
      .bind(sameOrderId, sameOrderId, 'SBL-2026-000417'),
    database
      .prepare(cloneOrder)
      .bind(foreignOrderId, orderId, 'SBL-2021-500000'),
  ]);
  const insertShipment = `INSERT INTO shipments (
    shipment_id, order_id, status, carrier_name, tracking_reference,
    shipped_on, estimated_delivery_date, delivered_on
  ) VALUES (?, ?, 'in_transit', 'Identity test carrier', ?, NULL, NULL, NULL)`;
  await database.batch([
    database
      .prepare(insertShipment)
      .bind(shipmentId, orderId, foreignShipmentId),
    database
      .prepare(insertShipment)
      .bind(trackingShipmentId, poOrderId, shipmentId),
    database
      .prepare(insertShipment)
      .bind(sameShipmentId, sameOrderId, sameShipmentId),
    database
      .prepare(insertShipment)
      .bind(foreignShipmentId, foreignOrderId, 'IDENTITY-FOREIGN-TRACKING'),
  ]);
}

describe('support reference identity', () => {
  for (const [namespace, identifier, answer, expected, excluded] of [
    [
      'order-id',
      orderId,
      'It’s the order ID.',
      `Order: ${orderId};`,
      `Order: ${poOrderId};`,
    ],
    [
      'customer-po',
      orderId,
      'the customer PO',
      `Order: ${poOrderId};`,
      `Order: ${orderId};`,
    ],
    [
      'shipment-id',
      shipmentId,
      "It's the shipment ID.",
      `Shipment: ${shipmentId};`,
      `Shipment: ${trackingShipmentId};`,
    ],
    [
      'tracking',
      shipmentId,
      'tracking reference',
      `Shipment: ${trackingShipmentId};`,
      `Shipment: ${shipmentId};`,
    ],
  ]) {
    test(`resolves a saved collision from a ${namespace} answer and keeps it through follow-up and replay`, async ({
      database,
      supportApi: fixture,
    }) => {
      await identityRecords(database);
      const incidentId = `INC-REFERENCE-NAMESPACE-${namespace.toUpperCase()}`;
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const model = fixture.mockModel('The requested record is available.');
      const first = await chat(
        session.request({
          incidentId,
          messageId: `${incidentId}-FIRST`,
          expectedRevision: 0,
          message: `Show ${identifier}.`,
        }),
      );
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        message: expect.stringMatching(/Please specify whether/),
      });
      expect(model).not.toHaveBeenCalled();

      const clarificationAnswer = {
        incidentId,
        messageId: `${incidentId}-ANSWER`,
        expectedRevision: 1,
        message: answer,
      };
      const resolved = await chat(session.request(clarificationAnswer));
      expect(resolved.status).toBe(200);
      const resolvedPayload = (await resolved.json()) as {
        message: string;
        revision: number;
      };
      expect(model).toHaveBeenCalledOnce();
      const followUp = await chat(
        session.request({
          incidentId,
          messageId: `${incidentId}-FOLLOW-UP`,
          expectedRevision: 2,
          message: 'What is its status?',
        }),
      );
      expect(followUp.status).toBe(200);
      expect(model).toHaveBeenCalledTimes(2);
      for (const call of model.mock.calls) {
        const request = JSON.parse(call[1]?.body as string) as {
          messages: { content: string }[];
        };
        const { records } = JSON.parse(request.messages[1].content) as {
          records: string;
        };
        expect(records).toContain(expected);
        expect(records).not.toContain(excluded);
      }
      const replay = await chat(session.request(clarificationAnswer));
      expect(replay.status).toBe(200);
      // A later exchange updates incidentUpdatedAt, but replay keeps the saved
      // answer and its own exchange revision without invoking the model again.
      expect(await replay.json()).toMatchObject({
        message: resolvedPayload.message,
        revision: resolvedPayload.revision,
      });
      expect(model).toHaveBeenCalledTimes(2);
      expect((await fixture.messageContents(incidentId)).results).toHaveLength(
        6,
      );
    });
  }

  test('selects explicitly named order and customer PO namespaces when they collide', async ({
    database,
  }) => {
    await identityRecords(database);
    for (const [question, expectedId, expectedTotal] of [
      [`Find order ${orderId}.`, orderId, '$78,320.00'],
      [
        `Find customer PO: "${orderId.toLowerCase()}".`,
        poOrderId,
        '$118,000.00',
      ],
    ]) {
      const context = await buildAuthorizedContext(
        database,
        ask(question),
        calderPikeUser,
      );
      expect(context).toContain(`Order: ${expectedId};`);
      expect(context).toContain(`Order total: ${expectedTotal}.`);
    }
  });

  test('does not fall back from an explicit order namespace to a customer PO', async ({
    database,
  }) => {
    await identityRecords(database);
    const context = await buildAuthorizedContext(
      database,
      ask('Find order ID IDENTITY-FIRST-PO.'),
      calderPikeUser,
    );
    expect(context).toContain(
      'No order matching IDENTITY-FIRST-PO is available within',
    );
    expect(context).not.toContain('Order total:');
    const poOnly = await buildAuthorizedContext(
      database,
      ask(`Find customer PO ${poOrderId}.`),
      calderPikeUser,
    );
    expect(poOnly).toContain(
      `No order matching ${poOrderId} is available within`,
    );
    expect(poOnly).not.toContain('Order total:');
  });

  test('selects explicitly named shipment and tracking namespaces when they collide', async ({
    database,
  }) => {
    await identityRecords(database);
    const byId = await buildAuthorizedContext(
      database,
      ask(`Show shipment ${shipmentId}.`),
      calderPikeUser,
    );
    const byTracking = await buildAuthorizedContext(
      database,
      ask(`Show tracking reference ${shipmentId}.`),
      calderPikeUser,
    );
    expect(byId).toContain(`Shipment: ${shipmentId};`);
    expect(byId).toContain(`Order: ${orderId};`);
    expect(byTracking).toContain(`Shipment: ${trackingShipmentId};`);
    expect(byTracking).toContain(`Order: ${poOrderId};`);
    const wrongNamespace = await buildAuthorizedContext(
      database,
      ask(`Show shipment ID ${foreignShipmentId}.`),
      calderPikeUser,
    );
    expect(wrongNamespace).toContain(
      `No shipment matching ${foreignShipmentId} is available within`,
    );
    expect(wrongNamespace).not.toContain(`Order: ${orderId};`);
    const trackingOnly = await buildAuthorizedContext(
      database,
      ask(`Show tracking reference ${trackingShipmentId}.`),
      calderPikeUser,
    );
    expect(trackingOnly).toContain(
      `No shipment matching ${trackingShipmentId} is available within`,
    );
    expect(trackingOnly).not.toContain(`Order: ${poOrderId};`);
  });

  test('clarifies bare collisions without selecting either authorized row', async ({
    database,
  }) => {
    await identityRecords(database);
    for (const identifier of [orderId, shipmentId]) {
      const result = await buildSupportContext(
        database,
        ask(`Show ${identifier}.`),
        calderPikeUser,
      );
      expect(result).toMatchObject({
        kind: 'clarification',
        message: expect.stringMatching(/Please (?:specify|clarify)/),
      });
      const context = await buildAuthorizedContext(
        database,
        ask(`Show ${identifier}.`),
        calderPikeUser,
      );
      expect(context).toMatch(/Please (?:specify|clarify)/);
      expect(context).not.toMatch(/(?:^|\n)(?:Order|Shipment):|Order total:/);
    }
  });

  test('labels separate compound namespaces when the same value names two orders', async ({
    database,
  }) => {
    await identityRecords(database);
    const result = await buildSupportContext(
      database,
      ask(`Show order ${orderId} and customer PO ${orderId}.`),
      calderPikeUser,
    );
    expect(result.kind).toBe('records');
    if (result.kind !== 'records')
      throw new Error('Expected two authorized records');
    expect(result.records).toContain(
      `Part 1 of 2: order ${orderId} (order ID)`,
    );
    expect(result.records).toContain(
      `Part 2 of 2: order ${orderId} (customer PO)`,
    );
    expect(result.records).toContain(`Order: ${orderId};`);
    expect(result.records).toContain(`Order: ${poOrderId};`);
  });

  test('keeps same-row matches and scoped foreign collisions unambiguous', async ({
    database,
  }) => {
    await identityRecords(database);
    for (const [identifier, record] of [
      [sameOrderId, `Order: ${sameOrderId};`],
      [sameShipmentId, `Shipment: ${sameShipmentId};`],
      [foreignShipmentId, `Shipment: ${shipmentId};`],
    ]) {
      const context = await buildAuthorizedContext(
        database,
        ask(`Show ${identifier}.`),
        calderPikeUser,
      );
      expect(context).toContain(record);
      expect(context).not.toContain(foreignOrderId);
    }
    const meridian = await loadActiveUserFixture(database, 'USR-MCS-001');
    const sharedPo = await buildAuthorizedContext(
      database,
      ask(`Find customer PO ${orderId}.`),
      meridian,
    );
    expect(sharedPo).toContain(`Order: ${foreignOrderId};`);
    expect(sharedPo).not.toContain(poOrderId);
    const foreignId = await buildAuthorizedContext(
      database,
      ask(`Find order ID ${orderId}.`),
      meridian,
    );
    expect(foreignId).toContain(
      `No order matching ${orderId} is available within`,
    );
    expect(foreignId).not.toContain(foreignOrderId);
  });

  test('saves and replays a deterministic clarification before calling the model', async ({
    database,
    supportApi: fixture,
  }) => {
    await identityRecords(database);
    const incidentId = 'INC-REFERENCE-IDENTITY-COLLISION';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(`Order ${orderId} was delivered.`);
    const quotaKey = `chat:${calderPikeUser.userId}`;
    const quota = { attempts: 30, expires_at: Date.now() + 60_000 };
    await database
      .prepare(`INSERT INTO request_limits (quota_key, attempts, expires_at)
      VALUES (?, ?, ?) ON CONFLICT(quota_key) DO UPDATE SET attempts = excluded.attempts,
      expires_at = excluded.expires_at`)
      .bind(quotaKey, quota.attempts, quota.expires_at)
      .run();
    const command = {
      incidentId,
      messageId: 'MSG-REFERENCE-IDENTITY-COLLISION',
      expectedRevision: 0,
      message: `Show ${orderId}.`,
    };
    const first = await chat(session.request(command));
    const payload = (await first.json()) as { message: string };
    expect(first.status).toBe(200);
    expect(payload.message).toMatch(/Please (?:specify|clarify)/);
    expect(model).not.toHaveBeenCalled();
    expect(
      (await fixture.messageContents(incidentId)).results.at(-1),
    ).toMatchObject({ role: 'assistant', content: payload.message });
    const replay = await chat(session.request(command));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(payload);
    expect(model).not.toHaveBeenCalled();
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(2);
    expect(
      await database
        .prepare(
          'SELECT attempts, expires_at FROM request_limits WHERE quota_key = ?',
        )
        .bind(quotaKey)
        .first(),
    ).toEqual(quota);
  });

  test('clarifies a compound request before the model can select a colliding record', async ({
    database,
    supportApi: fixture,
  }) => {
    await identityRecords(database);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(`Order ${orderId} was delivered.`);
    const response = await chat(
      session.request({
        message: `Show ${orderId} and order SBL-2022-000118.`,
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toMatch(
      /Please (?:specify|clarify)/,
    );
    expect(model).not.toHaveBeenCalled();
  });

  test('resolves saved order, shipment and return follow-ups to the requested entity', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-REFERENCE-IDENTITY-FOLLOW-UP';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-REFERENCE-IDENTITY-FIRST',
      'Show order SBL-2022-000118.',
      'Order SBL-2022-000118 contains SBL-DMK-A9, shipment SHP-2022-000118, and return RTN-2022-000014.',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(
      'The requested details are in the account records.',
    );
    for (const [index, entity, expected] of [
      [0, 'order', 'Order total:'],
      [1, 'shipment', 'Shipment: SHP-2022-000118;'],
      [2, 'return', 'Return: RTN-2022-000014;'],
    ] as const) {
      const response = await chat(
        session.request({
          incidentId,
          messageId: `MSG-REFERENCE-IDENTITY-FOLLOW-${index}`,
          expectedRevision: index + 1,
          message: `What is the status of that ${entity}?`,
        }),
      );
      expect(response.status).toBe(200);
      const request = JSON.parse(
        model.mock.calls[index][1]?.body as string,
      ) as { messages: { content: string }[] };
      expect(JSON.parse(request.messages[1].content).records).toContain(
        expected,
      );
    }
  });

  test('clarifies multiple saved customer targets without using assistant selection', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-REFERENCE-IDENTITY-MULTIPLE';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-REFERENCE-IDENTITY-MULTIPLE-FIRST',
      'Compare order SBL-2026-000417 and order SBL-2026-000418.',
      'Order SBL-2026-000417 has a shipment.',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Please specify the order ID.');
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-REFERENCE-IDENTITY-MULTIPLE-NEXT',
        expectedRevision: 1,
        message: 'What is the total for that order?',
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toMatch(
      /Please (?:specify|clarify)/,
    );
    expect(model).not.toHaveBeenCalled();
  });

  test('keeps saved clarification replies from creating a new shipment target', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-REFERENCE-IDENTITY-CLARIFICATION';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-REFERENCE-IDENTITY-CLARIFICATION-FIRST',
      'Show order SBL-2022-000118.',
      'The order was delivered.',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Please specify the shipment ID.');
    let clarification: string | undefined;
    for (const [index, message] of [
      'Where is that shipment?',
      'What is its status?',
      'Where is that shipment?',
    ].entries()) {
      const response = await chat(
        session.request({
          incidentId,
          messageId: `MSG-REFERENCE-IDENTITY-CLARIFICATION-${index}`,
          expectedRevision: index + 1,
          message,
        }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { message: string };
      clarification ??= payload.message;
      expect(payload.message).toBe(clarification);
      expect(payload.message).toMatch(/Please specify the shipment/);
    }
    expect(model).not.toHaveBeenCalled();
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(8);
  });

  test('clarifies when the saved history window no longer contains the target', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-REFERENCE-IDENTITY-TRUNCATED';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-REFERENCE-IDENTITY-TRUNCATED-0',
      'Show order SBL-2026-000417.',
      'The order is partially shipped.',
      0,
    );
    for (let index = 1; index <= 6; index += 1)
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        `MSG-REFERENCE-IDENTITY-TRUNCATED-${index}`,
        'What support is available?',
        'You can ask about orders and shipments.',
        index,
      );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Please specify the order ID.');
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-REFERENCE-IDENTITY-TRUNCATED-NEXT',
        expectedRevision: 7,
        message: 'What is the total for that order?',
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { message: string };
    expect(payload.message).toMatch(/Please (?:specify|clarify).*order/);
    expect(payload.message).not.toContain('SBL-2026-000417');
    expect(model).not.toHaveBeenCalled();
  });
});
