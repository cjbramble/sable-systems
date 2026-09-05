import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support order grounding', () => {
  it('builds an exact, tenant-scoped context for a known order', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of SBL-2026-000417?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'SBL-2026-000417',
    });

    const database = await getDatabase();
    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toContain(
      'Authorization: Calder Pike Distribution (WHS-0427) only.',
    );
    expect(context).toContain(
      'Order: SBL-2026-000417; customer PO: CPD-PO-260417; status: partially_shipped.',
    );
    expect(context).toContain(
      'Created: 2026-08-03; requested ship date: 2026-08-26; destination: North Atlantic Trade District.',
    );
    expect(context).toContain('Order total: $78,320.00.');
    expect(context).toContain(
      'SBL-RPC-12 Redline Power Cell R12: ordered 64, allocated 64, shipped 32, cancelled 0; price $680.00 per unit.',
    );
    expect(context).toContain(
      'SBL-SWC-12 Signal-Weave Active Cable, 12 m: ordered 120, allocated 120, shipped 120, cancelled 0; price $290.00 per unit.',
    );
    expect(context.match(/\bSBL-\d{4}-\d{6}\b/g)).toEqual(['SBL-2026-000417']);
    expect(context).not.toContain('WHS-1098');
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('withholds an order owned by another distributor', async () => {
    const database = await getDatabase();
    const externalOrder = await database
      .prepare(
        `SELECT customer_id, customer_po_number
         FROM orders
         WHERE order_id = ?`,
      )
      .bind('SBL-2021-500000')
      .first<{
        customer_id: string;
        customer_po_number: string;
      }>();

    expect(externalOrder).toEqual({
      customer_id: 'WHS-1098',
      customer_po_number: 'MCS-PO-500000',
    });

    const context = await buildAuthorizedContext(
      database,
      [
        {
          role: 'user',
          content: 'Show me order SBL-2021-500000.',
        },
      ],
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
No order matching SBL-2021-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(context).not.toContain('WHS-1098');
    expect(context).not.toContain('MCS-PO-500000');
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('returns only the six newest authorized partially shipped orders', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show my partially shipped orders.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'orders',
      message: 'show my partially shipped orders.',
      status: 'partially_shipped',
      year: undefined,
      yearField: undefined,
    });

    const database = await getDatabase();
    const expectedRows = await database
      .prepare(
        `SELECT order_id, customer_id, status
         FROM orders
         WHERE customer_id = ? AND status = ?
         ORDER BY created_on DESC, order_id DESC
         LIMIT 7`,
      )
      .bind(calderPikeUser.distributorId, 'partially_shipped')
      .all<{
        order_id: string;
        customer_id: string;
        status: string;
      }>();

    expect(expectedRows.results).toHaveLength(7);
    expect(
      expectedRows.results.every(
        (row) =>
          row.customer_id === calderPikeUser.distributorId &&
          row.status === 'partially_shipped',
      ),
    ).toBe(true);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const contextOrderIds = context.match(/\bSBL-\d{4}-\d{6}\b/g) ?? [];

    expect(context).toContain(
      'Authorization: Calder Pike Distribution (WHS-0427) only.',
    );
    expect(context).toContain(
      'Order search for status partially shipped; showing up to 6 most recent matches.',
    );
    expect(contextOrderIds).toEqual(
      expectedRows.results.slice(0, 6).map((row) => row.order_id),
    );
    expect(context).not.toContain(expectedRows.results[6].order_id);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(context.match(/: partially_shipped;/g)).toHaveLength(6);
  });

  it('filters scheduled orders by requested ship year', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show my scheduled orders requested for shipment in 2030.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'orders',
      message: 'show my scheduled orders requested for shipment in 2030.',
      status: 'scheduled',
      year: 2030,
      yearField: 'requested',
    });

    const database = await getDatabase();
    const expectedRows = await database
      .prepare(
        `SELECT order_id, customer_id, status, created_on, requested_ship_date
         FROM orders
         WHERE customer_id = ? AND status = ?
           AND requested_ship_date >= ? AND requested_ship_date < ?
         ORDER BY created_on DESC, order_id DESC
         LIMIT 7`,
      )
      .bind(
        calderPikeUser.distributorId,
        'scheduled',
        '2030-01-01',
        '2031-01-01',
      )
      .all<{
        order_id: string;
        customer_id: string;
        status: string;
        created_on: string;
        requested_ship_date: string;
      }>();

    expect(expectedRows.results).toHaveLength(7);
    expect(
      expectedRows.results.every(
        (row) =>
          row.customer_id === calderPikeUser.distributorId &&
          row.status === 'scheduled' &&
          row.created_on.startsWith('2026-') &&
          row.requested_ship_date.startsWith('2030-'),
      ),
    ).toBe(true);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const contextOrderIds = context.match(/\bSBL-\d{4}-\d{6}\b/g) ?? [];

    expect(context).toContain(
      'Order search for status scheduled, requested in 2030; showing up to 6 most recent matches.',
    );
    expect(contextOrderIds).toEqual(
      expectedRows.results.slice(0, 6).map((row) => row.order_id),
    );
    expect(context).not.toContain(expectedRows.results[6].order_id);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(
      context.match(
        /: scheduled; created 2026-\d{2}-\d{2}; requested 2030-\d{2}-\d{2};/g,
      ),
    ).toHaveLength(6);
  });
});
