import { describe, expect } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

type SearchScenario = {
  content: string;
  predicate: string;
  params?: unknown[];
  criteria: string;
  moreThanSix?: boolean;
};

async function expectOrderSearch(
  database: D1Database,
  { content, predicate, params = [], criteria, moreThanSix }: SearchScenario,
) {
  // Independently retrieve every eligible seed row. The prompt's total must
  // agree with the complete set while its preview remains capped at six rows.
  const expected = await database
    .prepare(`SELECT o.order_id, o.status FROM orders o
      WHERE o.customer_id = ? AND (${predicate})
      ORDER BY o.created_on DESC, o.order_id DESC`)
    .bind(calderPikeUser.distributorId, ...params)
    .all<{ order_id: string; status: string }>();
  const context = await buildSupportContext(
    database,
    ask(content),
    calderPikeUser,
  );
  expect(context.kind, content).toBe('records');
  if (context.kind !== 'records') throw new Error(context.message);
  const { records } = context;
  const total = expected.results.length;
  if (moreThanSix) expect(total).toBeGreaterThan(6);
  const listing =
    total === 0
      ? '.'
      : total > 6
        ? '; listing the 6 most recent.'
        : `; listing all ${total}.`;
  expect(records).toContain(
    `Order search${criteria ? ` for ${criteria}` : ''}: ${total} matching ${total === 1 ? 'order' : 'orders'}${listing}`,
  );
  const listed = Array.from(
    records.matchAll(/^- ([A-Z0-9-]+) \/ [^:]+: ([a-z_]+);/gm),
    ([, orderId, status]) => ({ order_id: orderId, status }),
  );
  expect(listed).toEqual(expected.results.slice(0, 6));
  expect(records.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
  return records;
}

function modelRecords(model: { mock: { calls: unknown[][] } }) {
  const request = model.mock.calls[0][1] as RequestInit;
  const { messages } = JSON.parse(request.body as string) as {
    messages: { content: string }[];
  };
  return (JSON.parse(messages[1].content) as { records: string }).records;
}

describe('support order status filters', () => {
  const scenarios: SearchScenario[] = [
    {
      content: 'Show orders that are not cancelled.',
      predicate: "o.status <> 'cancelled'",
      criteria: 'excluding status cancelled',
      moreThanSix: true,
    },
    {
      content: 'Show orders excluding cancelled and delivered.',
      predicate: "o.status NOT IN ('cancelled', 'delivered')",
      criteria: 'excluding statuses cancelled and delivered',
      moreThanSix: true,
    },
    {
      content: 'Show shipped or partially shipped orders.',
      predicate: "o.status IN ('shipped', 'partially_shipped')",
      criteria: 'status shipped or partially shipped',
      moreThanSix: true,
    },
    {
      content: 'Show active orders excluding on hold.',
      predicate:
        "o.status NOT IN ('scheduled', 'delivered', 'cancelled', 'on_hold')",
      criteria: 'status active, excluding status on hold',
      moreThanSix: true,
    },
    {
      content: 'Show orders that are not active.',
      predicate: "o.status IN ('scheduled', 'delivered', 'cancelled')",
      criteria: 'excluding status active',
      moreThanSix: true,
    },
    {
      content:
        'Show my orders from 2026 containing SBL-RPC-12 that are not cancelled.',
      predicate: `o.status <> 'cancelled'
        AND o.created_on >= '2026-01-01' AND o.created_on < '2027-01-01'
        AND EXISTS (SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.order_id AND oi.item_number = ?)`,
      params: ['SBL-RPC-12'],
      criteria:
        'excluding status cancelled, created in 2026, containing product Redline Power Cell R12 (SBL-RPC-12)',
      moreThanSix: true,
    },
    {
      content:
        'Show scheduled orders requested for shipment in 2030 excluding cancelled.',
      predicate: `o.status = 'scheduled'
        AND o.requested_ship_date >= '2030-01-01' AND o.requested_ship_date < '2031-01-01'`,
      criteria:
        'status scheduled, excluding status cancelled, requested in 2030',
      moreThanSix: true,
    },
    {
      content: 'Show orders from 2026 that are not scheduled.',
      predicate: `o.status <> 'scheduled'
        AND o.created_on >= '2026-01-01' AND o.created_on < '2027-01-01'`,
      criteria: 'excluding status scheduled, created in 2026',
      moreThanSix: true,
    },
    {
      content: 'Show cancelled orders from 2030.',
      predicate: `o.status = 'cancelled'
        AND o.created_on >= '2030-01-01' AND o.created_on < '2031-01-01'`,
      criteria: 'status cancelled, created in 2030',
    },
    {
      content: 'Show my orders.',
      predicate: '1 = 1',
      criteria: '',
      moreThanSix: true,
    },
  ];
  for (const scenario of scenarios) {
    test(`keeps scoped count and preview consistent: ${scenario.content}`, async ({
      database,
    }) => {
      await expectOrderSearch(database, scenario);
    });
  }

  for (const content of [
    'Show cancelled orders that are not cancelled.',
    'Show active orders excluding active.',
    'Show orders with status pending.',
    'Show orders that are not not cancelled.',
    'Show orders that are not cancelled or delivered.',
  ]) {
    test(`clarifies an unsupported or contradictory filter: ${content}`, async ({
      database,
    }) => {
      const context = await buildSupportContext(
        database,
        ask(content),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'clarification',
        message: expect.stringMatching(/status|statuses/i),
      });
    });
  }

  test('clarifies an unsupported status before considering an unknown product', async ({
    database,
  }) => {
    expect(
      await buildSupportContext(
        database,
        ask('Show orders with status pending containing SBL-UNKNOWN-999.'),
        calderPikeUser,
      ),
    ).toMatchObject({ kind: 'clarification' });
  });

  test('retains a separately requested filtered list alongside an explicit order', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask(
        'Show order SBL-2022-000118 and also show orders excluding cancelled.',
      ),
      calderPikeUser,
    );
    expect(context.kind).toBe('records');
    if (context.kind !== 'records') throw new Error(context.message);
    expect(context.records).toContain('Part 1 of 2: order SBL-2022-000118');
    expect(context.records).toContain('Order: SBL-2022-000118;');
    const list = context.records.split('Part 2 of 2: order search\n')[1];
    expect(list).toBeDefined();
    expect(list).toContain('Order search for excluding status cancelled:');
    expect(list).not.toMatch(/: cancelled;/);
    expect(list.match(/^- SBL-/gm)).toHaveLength(6);
  });
});

describe('saved order status clarification', () => {
  test('saves and replays clarification before quota or inference, then uses the corrected exclusion', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-ORDER-STATUS-CLARIFICATION';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('These are your matching orders.');
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
      messageId: 'MSG-ORDER-STATUS-CLARIFICATION',
      expectedRevision: 0,
      message: 'Show cancelled orders that are not cancelled.',
    };
    const first = await chat(session.request(command));
    expect(first.status).toBe(200);
    const payload = (await first.json()) as {
      message: string;
      revision: number;
    };
    expect(payload.message).toMatch(/status|statuses/i);
    expect(model).not.toHaveBeenCalled();
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

    await database
      .prepare('DELETE FROM request_limits WHERE quota_key = ?')
      .bind(quotaKey)
      .run();
    const corrected = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-ORDER-STATUS-CORRECTED',
        expectedRevision: payload.revision,
        message: 'Show orders excluding cancelled.',
      }),
    );
    expect(corrected.status).toBe(200);
    expect(model).toHaveBeenCalledOnce();
    const records = modelRecords(model);
    expect(records).toContain('Order search for excluding status cancelled:');
    expect(records).not.toMatch(/: cancelled;/);
    expect(records.match(/^- SBL-/gm)).toHaveLength(6);
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(4);
  });

  test('clarifies an unsupported filter before sending any part of a compound request to the model', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-ORDER-STATUS-COMPOUND';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('The order was delivered.');
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-ORDER-STATUS-COMPOUND',
        expectedRevision: 0,
        message: 'Show order SBL-2022-000118 and orders with status pending.',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: expect.stringMatching(/status|statuses/i),
    });
    expect(model).not.toHaveBeenCalled();
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(2);
  });
});
