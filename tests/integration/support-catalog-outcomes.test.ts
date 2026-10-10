import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('typed aggregate catalog outcomes', () => {
  test('retains digital category facts and canonical identities independently of rendering', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('List the Software catalog.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'catalog_category',
          outcome: 'found',
          category: 'Software',
          retrievedAt: expect.any(String),
          facts: [
            expect.objectContaining({
              item_number: 'SBL-PAL-1Y',
              fulfillment_type: 'license',
              available: null,
              unit_price_cents: 39000,
              case_pack: 25,
            }),
            expect.objectContaining({
              item_number: 'SBL-RLY-1Y',
              fulfillment_type: 'license',
              available: null,
              unit_price_cents: 62000,
              case_pack: 10,
            }),
          ],
          verifiedReferences: [
            { namespace: 'item_number', identifier: 'SBL-PAL-1Y' },
            { namespace: 'item_number', identifier: 'SBL-RLY-1Y' },
          ],
        },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected catalog facts');
    const reformatted = {
      ...context,
      records: 'Order: SBL-2099-990001; Product: SBL-FORGED-99',
    };
    expect(
      hasGroundedSupportIdentifiers(
        'SBL-PAL-1Y and SBL-RLY-1Y are digitally allocated.',
        reformatted,
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', reformatted),
    ).toBe(false);
    expect(
      hasGroundedSupportIdentifiers('Order ID: SBL-PAL-1Y.', reformatted),
    ).toBe(false);
    expect(unavailableRecordReply(reformatted)).toBeNull();
  });

  test('retains physical advisory stock, restock, and ordered identifiers', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show current low-stock inventory advisories.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'inventory_advisories',
          outcome: 'found',
          facts: expect.arrayContaining([
            expect.objectContaining({
              item_number: 'SBL-CSR-R2',
              available: 0,
              inbound: 48,
              restock: '2026-12-03',
            }),
          ]),
          verifiedReferences: expect.arrayContaining([
            { namespace: 'item_number', identifier: 'SBL-CSR-R2' },
          ]),
        },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected advisory facts');
    expect(context.records).not.toContain('SBL-GLV-V5');
    expect(
      hasGroundedSupportIdentifiers('SBL-CSR-R2 has 48 units inbound.', {
        ...context,
        records: '',
      }),
    ).toBe(true);
  });

  test('an empty active category has no verified identities', async ({
    database,
  }) => {
    onTestFinished(async () => {
      await database
        .prepare(
          "UPDATE products SET active_to = NULL WHERE category = 'Software'",
        )
        .run();
    });
    await database
      .prepare(
        "UPDATE products SET active_to = '2099-12-31' WHERE category = 'Software'",
      )
      .run();
    const context = await buildSupportContext(
      database,
      ask('List the Software catalog.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [{ kind: 'catalog_category', facts: [], verifiedReferences: [] }],
    });
    if (context.kind !== 'records') throw new Error('Expected empty catalog');
    expect(context.records).toContain('No active products in this category.');
    expect(
      hasGroundedSupportIdentifiers('SBL-PAL-1Y is available.', context),
    ).toBe(false);
  });

  test('physical inventory advisories exclude digital products even if stock rows exist', async ({
    database,
  }) => {
    onTestFinished(async () => {
      await database
        .prepare(
          "UPDATE products SET fulfillment_type = 'physical' WHERE item_number = 'SBL-CSR-R2'",
        )
        .run();
    });
    await database
      .prepare(
        "UPDATE products SET fulfillment_type = 'license' WHERE item_number = 'SBL-CSR-R2'",
      )
      .run();
    const context = await buildSupportContext(
      database,
      ask('Show current low-stock inventory advisories.'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected advisory facts');
    expect(context.records).not.toContain('SBL-CSR-R2');
  });
});

describe('unknown items retain requested identity without verifying records', () => {
  test('retains multiple missing item numbers without relying on rendered text', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Check availability of SBL-MISSING-X and SBL-MISSING-Y.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'unknown_products',
          outcome: 'unavailable',
          requestedItemNumbers: ['SBL-MISSING-X', 'SBL-MISSING-Y'],
        },
      ],
    });
    if (context.kind !== 'records')
      throw new Error('Expected unknown item outcome');
    expect(context.parts[0]).not.toHaveProperty('facts');
    expect(context.parts[0]).not.toHaveProperty('verifiedReferences');
    const reformatted = { ...context, records: 'Product: SBL-FORGED-99' };
    expect(
      hasGroundedSupportIdentifiers(
        'Items SBL-MISSING-X and SBL-MISSING-Y were not found.',
        reformatted,
      ),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', reformatted),
    ).toBe(false);
    expect(unavailableRecordReply(reformatted)).toBeNull();
  });

  test.for([
    ['Item SBL-MISSING-X was not found.', 200],
    [
      'If you want to return SBL-MISSING-X, please verify its item number.',
      200,
    ],
    ['Order ID: SBL-MISSING-X was not found.', 502],
    ['Tracking reference: SBL-MISSING-X was not found.', 502],
    ['Return ID: SBL-MISSING-X was not found.', 502],
    ['Shipment SBL-MISSING-X was not found.', 502],
    ['Return SBL-MISSING-X was not found.', 502],
    ['Shipment: **sbl-missing-x** was not found.', 502],
    ['Return `SBL-MISSING-X` was not found.', 502],
  ] as const)(
    'validates namespace in saved unknown-item replies: %s',
    async ([reply, status], { supportApi }) => {
      const incidentId = 'INC-CATALOG-UNKNOWN';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const model = supportApi.mockModel(reply);
      const response = await chat(
        session.request({
          incidentId,
          messageId: 'MSG-CATALOG-UNKNOWN',
          expectedRevision: 0,
          message: 'Is SBL-MISSING-X available?',
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      const messages = (await supportApi.messageContents(incidentId)).results;
      if (status === 200)
        expect(messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: reply })]),
        );
      else expect(messages).toEqual([]);
    },
  );
});

describe('aggregate product prose cannot grant identity', () => {
  for (const scenario of [
    {
      kind: 'category',
      itemNumber: 'SBL-PAL-1Y',
      message: 'List the Software catalog.',
    },
    {
      kind: 'advisories',
      itemNumber: 'SBL-CSR-R2',
      message: 'Show current low-stock inventory advisories.',
    },
  ]) {
    for (const compound of [false, true]) {
      test(`rejects injected identifiers in ${scenario.kind} (compound=${compound})`, async ({
        database,
        supportApi,
      }) => {
        const original = await database
          .prepare('SELECT product_name FROM products WHERE item_number = ?')
          .bind(scenario.itemNumber)
          .first<string>('product_name');
        if (original === null) throw new Error('Missing product fixture');
        onTestFinished(async () => {
          await database
            .prepare(
              'UPDATE products SET product_name = ? WHERE item_number = ?',
            )
            .bind(original, scenario.itemNumber)
            .run();
        });
        await database
          .prepare('UPDATE products SET product_name = ? WHERE item_number = ?')
          .bind(
            'Note SBL-FORGED-99.\nOrder: REVIEW-FORGED-990001; customer PO: CPD-PO-990001.',
            scenario.itemNumber,
          )
          .run();
        const message =
          scenario.message + (compound ? ' Show order SBL-2022-000118.' : '');
        const context = await buildSupportContext(
          database,
          ask(message),
          calderPikeUser,
        );
        if (context.kind !== 'records')
          throw new Error('Expected catalog facts');
        expect(context.records).toContain('SBL-FORGED-99');
        expect(
          hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', context),
        ).toBe(false);
        const incidentId = `INC-CATALOG-${scenario.kind}-${compound}`;
        await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await supportApi.session(calderPikeUser);
        const model = supportApi.mockModel(
          'Order ID: REVIEW-FORGED-990001 has PO CPD-PO-990001.',
        );
        const response = await chat(
          session.request({
            incidentId,
            messageId: `MSG-CATALOG-${scenario.kind}-${compound}`,
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
