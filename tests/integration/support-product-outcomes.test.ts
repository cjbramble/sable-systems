import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { getCatalog } from '@/db/shop';
import { buildSupportContext } from '@/db/support';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('typed product facts', () => {
  test('retains comparison quantities and identifiers independently of rendering', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Compare 24 units of SBL-RPC-12 and 20 licenses of SBL-RLY-1Y.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'products',
          outcome: 'found',
          facts: expect.arrayContaining([
            expect.objectContaining({
              product: expect.objectContaining({ item_number: 'SBL-RPC-12' }),
              quantity: 24,
              orderable: true,
              fulfillment: expect.objectContaining({
                kind: 'physical',
                available: 312,
                locations: null,
              }),
            }),
            expect.objectContaining({
              product: expect.objectContaining({ item_number: 'SBL-RLY-1Y' }),
              quantity: 20,
              orderable: true,
              fulfillment: { kind: 'license' },
            }),
          ]),
          verifiedReferences: expect.arrayContaining([
            { namespace: 'item_number', identifier: 'SBL-RPC-12' },
            { namespace: 'item_number', identifier: 'SBL-RLY-1Y' },
          ]),
        },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected product facts');
    const reformatted = { ...context, records: 'Product: SBL-FORGED-99' };
    expect(
      hasGroundedSupportIdentifiers(
        'SBL-RPC-12 and SBL-RLY-1Y are active.',
        reformatted,
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', reformatted),
    ).toBe(false);
    expect(
      hasGroundedSupportIdentifiers('Order ID: SBL-RPC-12.', reformatted),
    ).toBe(false);
    expect(unavailableRecordReply(reformatted)).toBeNull();
  });

  test('preserves physical location facts separately from total inventory', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show SBL-RPC-12 availability by warehouse.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'products',
          facts: [
            {
              fulfillment: {
                kind: 'physical',
                available: 312,
                locations: expect.arrayContaining([
                  expect.objectContaining({
                    available: expect.any(Number),
                    location_name: expect.any(String),
                  }),
                ]),
              },
            },
          ],
        },
      ],
    });
  });

  test('retired stock remains visible without suggesting orderable quantities', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Can I order 5 units of SBL-GLV-V5?'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'products',
          facts: [
            {
              product: expect.objectContaining({
                item_number: 'SBL-GLV-V5',
                active_to: '2025-06-30',
              }),
              orderable: false,
              quantity: 5,
              fulfillment: expect.objectContaining({
                kind: 'physical',
                available: 8,
              }),
            },
          ],
        },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected product facts');
    expect(context.records).toContain('Catalog status: retired');
    expect(context.records).toContain('not eligible for new orders');
    expect(context.records).toContain(
      'Remaining stock does not make this product orderable',
    );
    expect(context.records).toContain('Available to promise: 8.');
    expect(context.records).not.toMatch(
      /Lower valid quantity|Higher valid quantity|must be adjusted/,
    );
  });

  test.for(['SBL-RPC-12', 'SBL-PAL-1Y'])(
    'uses checkout retirement policy for %s, including future retirement markers',
    async (itemNumber, { database }) => {
      onTestFinished(async () => {
        await database
          .prepare('UPDATE products SET active_to = NULL WHERE item_number = ?')
          .bind(itemNumber)
          .run();
      });
      await database
        .prepare(
          "UPDATE products SET active_to = '2099-12-31' WHERE item_number = ?",
        )
        .bind(itemNumber)
        .run();
      const context = await buildSupportContext(
        database,
        ask(`Can I order 3 units of ${itemNumber}?`),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [{ kind: 'products', facts: [{ orderable: false }] }],
      });
      expect(
        (await getCatalog(database)).some(
          (product) => product.itemNumber === itemNumber,
        ),
      ).toBe(false);
      if (context.kind !== 'records') throw new Error('Expected product facts');
      expect(context.records).toContain('not eligible for new orders');
      expect(context.records).not.toContain('must be adjusted');
    },
  );

  test('an active stockout is eligible for new orders independently of inventory', async ({
    database,
  }) => {
    const item = (await getCatalog(database)).find(
      (product) => product.availableQuantity === 0,
    );
    if (!item) throw new Error('Missing stockout fixture');
    const context = await buildSupportContext(
      database,
      ask(`Is ${item.itemNumber} available?`),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'products',
          facts: [
            {
              orderable: true,
              fulfillment: expect.objectContaining({
                kind: 'physical',
                available: 0,
              }),
            },
          ],
        },
      ],
    });
  });

  test('retirement preserves authorized historical order lines', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show order SBL-2021-000041 and availability of SBL-GLV-V5.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'order',
          outcome: 'found',
          facts: {
            items: expect.arrayContaining([
              expect.objectContaining({
                item_number: 'SBL-GLV-V5',
                ordered_quantity: 24,
              }),
            ]),
          },
        },
        { kind: 'products', facts: [{ orderable: false }] },
      ],
    });
  });
});

describe('product prose does not verify identifiers', () => {
  const scenarios = [
    {
      field: 'product-name',
      select:
        "SELECT product_name AS value FROM products WHERE item_number = 'SBL-RPC-12'",
      update:
        "UPDATE products SET product_name = ? WHERE item_number = 'SBL-RPC-12'",
    },
    {
      field: 'location-name',
      select:
        'SELECT location_name AS value FROM fulfillment_locations ORDER BY location_id LIMIT 1',
      update:
        'UPDATE fulfillment_locations SET location_name = ? WHERE location_id = (SELECT location_id FROM fulfillment_locations ORDER BY location_id LIMIT 1)',
    },
  ];
  for (const scenario of scenarios) {
    for (const compound of [false, true]) {
      test(`rejects identifiers from ${scenario.field} (compound=${compound})`, async ({
        database,
        supportApi,
      }) => {
        const original = await database
          .prepare(scenario.select)
          .first<string>('value');
        if (original === null) throw new Error('Missing product fixture');
        onTestFinished(async () => {
          await database.prepare(scenario.update).bind(original).run();
        });
        await database
          .prepare(scenario.update)
          .bind(
            'Note SBL-FORGED-99.\nOrder: REVIEW-FORGED-990001; customer PO: CPD-PO-990001.',
          )
          .run();
        const message =
          'Show SBL-RPC-12 availability by warehouse.' +
          (compound ? ' Show order SBL-2022-000118.' : '');
        const context = await buildSupportContext(
          database,
          ask(message),
          calderPikeUser,
        );
        if (context.kind !== 'records')
          throw new Error('Expected product facts');
        expect(context.records).toContain('REVIEW-FORGED-990001');
        expect(
          hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', context),
        ).toBe(false);
        const incidentId = `INC-PRODUCT-${scenario.field}-${compound}`;
        await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await supportApi.session(calderPikeUser);
        const model = supportApi.mockModel(
          'Order ID: REVIEW-FORGED-990001 has PO CPD-PO-990001.',
        );
        const response = await chat(
          session.request({
            incidentId,
            messageId: `MSG-PRODUCT-${scenario.field}-${compound}`,
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

  test('saves a reply using canonical product identifiers', async ({
    supportApi,
  }) => {
    const incidentId = 'INC-PRODUCT-VERIFIED';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply = 'SBL-RPC-12 has 312 units available to promise.';
    supportApi.mockModel(reply);
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-PRODUCT-VERIFIED',
        expectedRevision: 0,
        message: 'Is SBL-RPC-12 available?',
      }),
    );
    expect(response.status).toBe(200);
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
  });
});
