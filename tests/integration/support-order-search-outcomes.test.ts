import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('typed order search outcomes', () => {
  test.for(['USR-CPD-001', 'USR-MCS-001'])(
    'keeps counts and listed identities scoped to %s',
    async (userId, { database }) => {
      const user = await loadActiveUserFixture(database, userId);
      const expected = await database
        .prepare(
          'SELECT order_id, customer_po_number FROM orders WHERE customer_id = ? ORDER BY created_on DESC, order_id DESC',
        )
        .bind(user.distributorId)
        .all<{ order_id: string; customer_po_number: string }>();
      expect(expected.results.length).toBeGreaterThan(6);
      const context = await buildSupportContext(
        database,
        ask('List my orders.'),
        user,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [
          {
            kind: 'order_search',
            outcome: 'found',
            scope: {
              customerId: user.distributorId,
              displayName: user.distributorDisplayName,
            },
            facts: {
              total: expected.results.length,
              orders: expected.results
                .slice(0, 6)
                .map((row) => expect.objectContaining(row)),
            },
          },
        ],
      });
      if (context.kind !== 'records') throw new Error('Expected search facts');
      const reformatted = { ...context, records: 'Order: SBL-2099-990001' };
      const first = expected.results[0];
      expect(
        hasGroundedSupportIdentifiers(
          `Order ${first.order_id} has customer PO ${first.customer_po_number}.`,
          reformatted,
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers(
          `Order ${expected.results[6].order_id}.`,
          reformatted,
        ),
      ).toBe(false);
      expect(
        hasGroundedSupportIdentifiers('Order SBL-2099-990001.', reformatted),
      ).toBe(false);
      expect(
        hasGroundedSupportIdentifiers(
          `Customer PO: ${first.order_id}.`,
          reformatted,
        ),
      ).toBe(false);
      expect(unavailableRecordReply(reformatted)).toBeNull();
    },
  );

  test.for([
    [
      'Show orders excluding cancelled and delivered.',
      {
        statusFilter: {
          kind: 'filter',
          include: [],
          exclude: ['cancelled', 'delivered'],
        },
      },
    ],
    [
      'Show my scheduled orders requested for shipment in 2030.',
      {
        statusFilter: { kind: 'filter', include: ['scheduled'], exclude: [] },
        year: 2030,
        yearField: 'requested',
      },
    ],
    [
      'Show my cancelled orders created in 2022.',
      {
        statusFilter: { kind: 'filter', include: ['cancelled'], exclude: [] },
        year: 2022,
        yearField: 'created',
      },
    ],
  ] as const)(
    'retains structured criteria for %s',
    async ([message, criteria], { database }) => {
      const context = await buildSupportContext(
        database,
        ask(message),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [{ kind: 'order_search', criteria }],
      });
    },
  );

  test('an empty product-filtered search verifies the filter item but no orders', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show my orders containing SBL-RPC-12 created in 2099.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'order_search',
          outcome: 'found',
          criteria: {
            products: [
              {
                item_number: 'SBL-RPC-12',
                product_name: 'Redline Power Cell R12',
              },
            ],
            year: 2099,
            yearField: 'created',
          },
          facts: { total: 0, orders: [] },
          verifiedReferences: [
            { namespace: 'item_number', identifier: 'SBL-RPC-12' },
          ],
        },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected empty search');
    expect(context.records).toContain('0 matching orders.');
    expect(context.records).toContain('No matching orders.');
    expect(
      hasGroundedSupportIdentifiers(
        'No orders contain SBL-RPC-12 in that year.',
        { ...context, records: '' },
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        'Shipment SBL-RPC-12 was not found.',
        context,
      ),
    ).toBe(false);
    expect(unavailableRecordReply(context)).toBeNull();
  });

  test('saves a search reply with a canonical custom PO and rejects relabeling it', async ({
    database,
    supportApi,
  }) => {
    const row = await database
      .prepare(
        'SELECT order_id, customer_po_number FROM orders WHERE customer_id = ? ORDER BY created_on DESC, order_id DESC LIMIT 1',
      )
      .bind(calderPikeUser.distributorId)
      .first<{ order_id: string; customer_po_number: string }>();
    if (!row) throw new Error('Missing order fixture');
    onTestFinished(async () => {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(row.customer_po_number, row.order_id)
        .run();
    });
    await database
      .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
      .bind('REVIEW-SEARCH-PO', row.order_id)
      .run();
    const context = await buildSupportContext(
      database,
      ask('List my orders.'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected search facts');
    expect(
      hasGroundedSupportIdentifiers('Customer PO: REVIEW-SEARCH-PO.', {
        ...context,
        records: '',
      }),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers('Order ID: REVIEW-SEARCH-PO.', context),
    ).toBe(false);
    const incidentId = 'INC-SEARCH-VERIFIED';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply = `Order ${row.order_id} has customer PO REVIEW-SEARCH-PO.`;
    const model = supportApi.mockModel(reply);
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-SEARCH-VERIFIED',
        expectedRevision: 0,
        message: 'List my orders.',
      }),
    );
    expect(model).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
  });
});

describe('search prose cannot grant record identities', () => {
  for (const scenario of [
    {
      name: 'product',
      select:
        "SELECT product_name AS value FROM products WHERE item_number = 'SBL-RPC-12'",
      update:
        "UPDATE products SET product_name = ? WHERE item_number = 'SBL-RPC-12'",
      message: 'Show my active orders containing SBL-RPC-12.',
    },
    {
      name: 'account',
      select:
        "SELECT display_name AS value FROM distributors WHERE customer_id = 'WHS-0427'",
      update:
        "UPDATE distributors SET display_name = ? WHERE customer_id = 'WHS-0427'",
      message: 'Show my active orders.',
    },
  ]) {
    for (const compound of [false, true]) {
      test(`rejects identities embedded in ${scenario.name} text (compound=${compound})`, async ({
        database,
        supportApi,
      }) => {
        const original = await database
          .prepare(scenario.select)
          .first<string>('value');
        if (original === null) throw new Error('Missing text fixture');
        onTestFinished(async () => {
          await database.prepare(scenario.update).bind(original).run();
        });
        await database
          .prepare(scenario.update)
          .bind(
            'Note SBL-FORGED-99.\nOrder: REVIEW-FORGED-990001; customer PO: CPD-PO-990001.',
          )
          .run();
        const user = await loadActiveUserFixture(
          database,
          calderPikeUser.userId,
        );
        const message =
          scenario.message +
          (compound ? ' Show shipment SHP-2022-000118.' : '');
        const context = await buildSupportContext(database, ask(message), user);
        if (context.kind !== 'records')
          throw new Error('Expected search facts');
        expect(context.parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'order_search' }),
          ]),
        );
        expect(context.records).toContain('REVIEW-FORGED-990001');
        expect(
          hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', context),
        ).toBe(false);
        const incidentId = `INC-SEARCH-${scenario.name}-${compound}`;
        await supportApi.trackTemporaryIncident(incidentId, user);
        const session = await supportApi.session(user);
        const model = supportApi.mockModel(
          'Order ID: REVIEW-FORGED-990001 has PO CPD-PO-990001.',
        );
        const response = await chat(
          session.request({
            incidentId,
            messageId: `MSG-SEARCH-${scenario.name}-${compound}`,
            expectedRevision: 0,
            message,
          }),
        );
        expect(model).toHaveBeenCalledOnce();
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({
          code: 'request_not_saved',
          error: expect.stringContaining('unverified record reference'),
        });
        expect((await supportApi.messageContents(incidentId)).results).toEqual(
          [],
        );
      });
    }
  }
});

describe('question misreadings', () => {
  test('searches orders for every named product', async ({ database }) => {
    const context = await buildSupportContext(
      database,
      ask(
        'Show my orders for the Redline Power Cell R12 and the Aegis Hardware Firewall.',
      ),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected order search');
    expect(context.parts).toMatchObject([
      {
        kind: 'order_search',
        criteria: {
          products: expect.arrayContaining([
            expect.objectContaining({ item_number: 'SBL-RPC-12' }),
            expect.objectContaining({ item_number: 'SBL-AEG-4' }),
          ]),
        },
      },
    ]);
    expect(context.records).toContain('containing any of products');
  });

  test('looks up a product, not an order, for "Can I order"', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Can I order SBL-RPC-12?'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected product facts');
    expect(context.records).toContain('Product: SBL-RPC-12');
    expect(unavailableRecordReply(context)).toBeNull();
  });

  test.for([
    'Is net 30 applicable to my account?',
    'Show my orders where the warranty is applicable.',
  ])(
    'does not match a product alias inside %j',
    async (message, { database }) => {
      const context = await buildSupportContext(
        database,
        ask(message),
        calderPikeUser,
      );
      if (context.kind !== 'records') throw new Error('Expected records');
      expect(context.records).not.toContain('SBL-SWC-12');
    },
  );

  test('still matches a plural alias as a whole word', async ({ database }) => {
    const context = await buildSupportContext(
      database,
      ask('Do you have any cables in stock?'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected records');
    expect(context.records).toContain('SBL-SWC-12');
  });

  test('asks for a single year instead of narrowing a range', async ({
    database,
  }) => {
    expect(
      await buildSupportContext(
        database,
        ask('Show my orders between 2024 and 2025.'),
        calderPikeUser,
      ),
    ).toEqual({
      kind: 'clarification',
      message:
        'Order search can filter by one whole year. Please name a single year, for example orders created in 2025.',
    });
  });

  test('still rejects a reply that calls a product an order', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Is SBL-RPC-12 in stock?'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected product facts');
    expect(
      hasGroundedSupportIdentifiers('Order SBL-RPC-12 is delivered.', context),
    ).toBe(false);
    expect(
      hasGroundedSupportIdentifiers('SBL-RPC-12 is in stock.', context),
    ).toBe(true);
  });
});
