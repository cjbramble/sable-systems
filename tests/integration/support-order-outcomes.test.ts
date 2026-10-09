import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const orderId = 'SBL-2022-000118';

async function replaceStoredText(
  database: D1Database,
  field: 'destination' | 'event',
  text: string,
) {
  if (field === 'destination') {
    const original = await database
      .prepare('SELECT shipping_region FROM orders WHERE order_id = ?')
      .bind(orderId)
      .first<string>('shipping_region');
    if (original === null) throw new Error('Missing order destination fixture');
    onTestFinished(async () => {
      await database
        .prepare('UPDATE orders SET shipping_region = ? WHERE order_id = ?')
        .bind(original, orderId)
        .run();
    });
    await database
      .prepare('UPDATE orders SET shipping_region = ? WHERE order_id = ?')
      .bind(text, orderId)
      .run();
    return;
  }

  const event = await database
    .prepare(`SELECT event_id, customer_safe_description FROM order_events
      WHERE order_id = ? ORDER BY occurred_at DESC LIMIT 1`)
    .bind(orderId)
    .first<{ event_id: string; customer_safe_description: string }>();
  if (!event) throw new Error('Missing order event fixture');
  onTestFinished(async () => {
    await database
      .prepare(
        'UPDATE order_events SET customer_safe_description = ? WHERE event_id = ?',
      )
      .bind(event.customer_safe_description, event.event_id)
      .run();
  });
  await database
    .prepare(
      'UPDATE order_events SET customer_safe_description = ? WHERE event_id = ?',
    )
    .bind(text, event.event_id)
    .run();
}

function modelRecords(model: { mock: { calls: unknown[][] } }) {
  const request = model.mock.calls[0][1] as RequestInit;
  const { messages } = JSON.parse(request.body as string) as {
    messages: { content: string }[];
  };
  return (JSON.parse(messages[1].content) as { records: string }).records;
}

describe('order identities from stored fields', () => {
  const scenarios: {
    name: string;
    field: 'destination' | 'event';
    stored: string;
    reply: string;
  }[] = [
    {
      name: 'DESTINATION-ORDER',
      field: 'destination',
      stored: 'Receiving note mentions SBL-2099-960001.',
      reply: 'SBL-2099-960001 is associated with this request.',
    },
    {
      name: 'DESTINATION-SHIPMENT',
      field: 'destination',
      stored: 'Receiving note mentions SHP-2099-960001.',
      reply: 'Shipment SHP-2099-960001 is associated with this delivery.',
    },
    {
      name: 'EVENT-PO',
      field: 'event',
      stored: 'Customer note mentions CPD-PO-960001.',
      reply: 'CPD-PO-960001 is associated with this request.',
    },
    {
      name: 'EVENT-CUSTOM-ORDER',
      field: 'event',
      stored:
        'Customer note.\nOrder: REVIEW-FREE-TEXT-960001; customer PO: REVIEW-PO-960001.',
      reply:
        'Order ID REVIEW-FREE-TEXT-960001 is associated with this request.',
    },
  ];

  for (const scenario of scenarios) {
    for (const compound of [false, true]) {
      const requestKind = compound ? 'COMPOUND' : 'SINGLE';
      test(`rejects ${scenario.name} from prose in a ${requestKind} order request`, async ({
        database,
        supportApi: fixture,
      }) => {
        await replaceStoredText(database, scenario.field, scenario.stored);
        const incidentId = `INC-ORDER-OUTCOME-${scenario.name}-${requestKind}`;
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const model = fixture.mockModel(scenario.reply);
        const message = compound
          ? `Show order ${orderId} and check SBL-RPC-12 availability.`
          : `Show order ${orderId}.`;
        const response = await chat(
          session.request({
            incidentId,
            messageId: `MSG-ORDER-OUTCOME-${scenario.name}-${requestKind}`,
            expectedRevision: 0,
            message,
          }),
        );

        expect(model).toHaveBeenCalledOnce();
        const records = modelRecords(model);
        expect(records).toContain(scenario.stored);
        if (compound) expect(records).toContain('Product: SBL-RPC-12 ');
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({
          code: 'request_not_saved',
          error: expect.stringMatching(/unverified record reference/i),
        });
        expect((await fixture.messageContents(incidentId)).results).toEqual([]);
      });
    }
  }

  test('retains verified related identities alongside a compound product lookup', async ({
    database,
    supportApi: fixture,
  }) => {
    await replaceStoredText(
      database,
      'event',
      'Customer note mentions SHP-2099-960001.',
    );
    const incidentId = 'INC-ORDER-OUTCOME-VERIFIED-COMPOUND';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const reply =
      'Order SBL-2022-000118 has customer PO CPD-PO-220118, shipment SHP-2022-000118, tracking reference AST-2022000118, and return RTN-2022-000014. Its item is SBL-DMK-A9. SBL-RPC-12 is also available.';
    const model = fixture.mockModel(reply);
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-ORDER-OUTCOME-VERIFIED-COMPOUND',
        expectedRevision: 0,
        message: `Show order ${orderId} and check SBL-RPC-12 availability.`,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: reply });
    expect(model).toHaveBeenCalledOnce();
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(2);
  });
});

describe('missing order outcomes', () => {
  test('saves and replays a missing order without using quota or inference', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-ORDER-OUTCOME-MISSING';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('This model reply must not be used.');
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
      messageId: 'MSG-ORDER-OUTCOME-MISSING',
      expectedRevision: 0,
      message: 'Show order ID SBL-2099-960002.',
    };
    const first = await chat(session.request(command));
    expect(first.status).toBe(200);
    const payload = (await first.json()) as { message: string };
    expect(payload.message).toContain('SBL-2099-960002');
    expect(payload.message).toContain(
      "within Calder Pike Distribution's authorization scope.",
    );
    expect(model).not.toHaveBeenCalled();
    const replay = await chat(session.request(command));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(payload);
    expect(model).not.toHaveBeenCalled();
    expect((await fixture.messageContents(incidentId)).results).toMatchObject([
      { role: 'user', content: command.message },
      { role: 'assistant', content: payload.message },
    ]);
    expect(
      await database
        .prepare(
          'SELECT attempts, expires_at FROM request_limits WHERE quota_key = ?',
        )
        .bind(quotaKey)
        .first(),
    ).toEqual(quota);
  });

  for (const namespace of ['customer PO', 'order ID']) {
    test(`keeps a missing explicit PO in its requested namespace when echoed as ${namespace}`, async ({
      supportApi: fixture,
    }) => {
      const missingPo = 'REVIEW-MISSING-PO-960001';
      const validNamespace = namespace === 'customer PO';
      const incidentId = `INC-ORDER-OUTCOME-MISSING-PO-${validNamespace ? 'VALID' : 'INVALID'}`;
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const reply = `Order ${orderId} was delivered. The ${namespace} ${missingPo} could not be located.`;
      const model = fixture.mockModel(reply);
      const response = await chat(
        session.request({
          incidentId,
          messageId: `MSG-ORDER-OUTCOME-MISSING-PO-${validNamespace ? 'VALID' : 'INVALID'}`,
          expectedRevision: 0,
          message: `Show order ${orderId} and customer PO ${missingPo}.`,
        }),
      );

      expect(model).toHaveBeenCalledOnce();
      const records = modelRecords(model);
      expect(records).toContain(`Order: ${orderId};`);
      expect(records).toContain(missingPo);
      expect(response.status).toBe(validNamespace ? 200 : 502);
      if (validNamespace) {
        expect(await response.json()).toMatchObject({ message: reply });
        expect(
          (await fixture.messageContents(incidentId)).results,
        ).toHaveLength(2);
      } else {
        expect(await response.json()).toMatchObject({
          code: 'request_not_saved',
        });
        expect((await fixture.messageContents(incidentId)).results).toEqual([]);
      }
    });
  }
});
