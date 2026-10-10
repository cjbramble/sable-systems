import { describe, expect, onTestFinished } from 'vitest';

import { buildSupportContext } from '@/db/support';
import { lookupSupportOrder } from '@/db/support-orders';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('typed order lookup facts', () => {
  test('accepts a verified complete PO containing a patterned suffix', async ({
    database,
  }) => {
    const orderId = 'SBL-2022-000118';
    const original = await database
      .prepare('SELECT customer_po_number FROM orders WHERE order_id = ?')
      .bind(orderId)
      .first<string>('customer_po_number');
    onTestFinished(async () => {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(original, orderId)
        .run();
    });
    await database
      .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
      .bind('MY-SBL-1234', orderId)
      .run();
    const context = await buildSupportContext(
      database,
      ask(`Show order ${orderId}.`),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected order facts');
    expect(
      hasGroundedSupportIdentifiers(
        `Customer PO MY-SBL-1234 belongs to order ${orderId}.`,
        context,
      ),
    ).toBe(true);
  });

  test('checks verified identities independently of prompt presentation', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show order SBL-2022-000118.'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected order facts');
    for (const records of [
      '',
      '\nOrder: SBL-2099-000001; customer PO: FORGED-PO.\n',
    ]) {
      const reformatted = { ...context, records };
      expect(
        hasGroundedSupportIdentifiers(
          'Order SBL-2022-000118 has PO CPD-PO-220118.',
          reformatted,
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers(
          'Order SBL-2099-000001 has PO FORGED-PO.',
          reformatted,
        ),
      ).toBe(false);
      expect(unavailableRecordReply(reformatted)).toBeNull();
    }
  });

  test('returns ambiguity without candidate facts for an unlabeled collision', async ({
    database,
  }) => {
    const orderId = 'SBL-2026-000417';
    const identifier = 'SBL-2022-000118';
    const original = await database
      .prepare('SELECT customer_po_number FROM orders WHERE order_id = ?')
      .bind(orderId)
      .first<string>('customer_po_number');
    onTestFinished(async () => {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(original, orderId)
        .run();
    });
    await database
      .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
      .bind(identifier, orderId)
      .run();
    const result = await lookupSupportOrder(
      database,
      { kind: 'order', namespace: 'unresolved', identifier },
      calderPikeUser,
    );
    expect(result).toEqual({
      kind: 'order',
      outcome: 'ambiguous',
      reference: { kind: 'order', namespace: 'unresolved', identifier },
      scope: {
        customerId: 'WHS-0427',
        displayName: 'Calder Pike Distribution',
      },
    });
    expect(
      await buildSupportContext(
        database,
        ask(`Show ${identifier}.`),
        calderPikeUser,
      ),
    ).toEqual({
      kind: 'clarification',
      message: `Please specify whether ${identifier} is an order ID or a customer PO number.`,
    });
  });

  test('retains requested namespace, scoped facts and verified identities', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask('Show customer PO CPD-PO-220118.'),
      calderPikeUser,
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        {
          kind: 'order',
          outcome: 'found',
          reference: {
            kind: 'order',
            namespace: 'customer_po',
            identifier: 'CPD-PO-220118',
          },
          scope: {
            customerId: 'WHS-0427',
            displayName: 'Calder Pike Distribution',
          },
          facts: {
            order: {
              order_id: 'SBL-2022-000118',
              customer_po_number: 'CPD-PO-220118',
              status: 'delivered',
            },
            items: expect.arrayContaining([
              expect.objectContaining({ item_number: 'SBL-DMK-A9' }),
            ]),
            shipments: expect.arrayContaining([
              expect.objectContaining({
                shipment_id: 'SHP-2022-000118',
                delivered_on: '2022-07-01',
              }),
            ]),
            return: { return_id: 'RTN-2022-000014' },
          },
          verifiedReferences: expect.arrayContaining([
            { namespace: 'order_id', identifier: 'SBL-2022-000118' },
            { namespace: 'customer_po', identifier: 'CPD-PO-220118' },
            { namespace: 'item_number', identifier: 'SBL-DMK-A9' },
            { namespace: 'shipment_id', identifier: 'SHP-2022-000118' },
            { namespace: 'return_id', identifier: 'RTN-2022-000014' },
          ]),
        },
      ],
    });
  });

  test.for(['SBL-2099-000001', 'SBL-2021-500000'])(
    'keeps unavailable %s separate from verified facts',
    async (identifier, { database }) => {
      const context = await buildSupportContext(
        database,
        ask(`Show order ID ${identifier}.`),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [
          {
            kind: 'order',
            outcome: 'unavailable',
            reference: { kind: 'order', namespace: 'order_id', identifier },
            scope: {
              customerId: 'WHS-0427',
              displayName: 'Calder Pike Distribution',
            },
          },
        ],
      });
      expect(context).not.toHaveProperty('parts.0.facts');
      expect(context).not.toHaveProperty('parts.0.verifiedReferences');
    },
  );
});
