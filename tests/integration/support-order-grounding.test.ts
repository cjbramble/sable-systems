import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/db/auth';
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

  it('resolves a customer PO to the same authorized order as its order number', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of customer PO CPD-PO-260417?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'CPD-PO-260417',
    });

    const database = await getDatabase();
    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const orderNumberContext = await buildAuthorizedContext(
      database,
      [{ role: 'user', content: 'What is the status of SBL-2026-000417?' }],
      calderPikeUser,
    );

    expect(context).toBe(orderNumberContext);
    expect(context).toContain(
      'Authorization: Calder Pike Distribution (WHS-0427) only.',
    );
    expect(context).toContain(
      'Order: SBL-2026-000417; customer PO: CPD-PO-260417; status: partially_shipped.',
    );
    expect(context).toContain('Order total: $78,320.00.');
    expect(context.match(/\bSBL-\d{4}-\d{6}\b/g)).toEqual(['SBL-2026-000417']);
    expect(context).not.toContain('WHS-1098');
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('scopes a shared customer PO lookup to each authenticated distributor', async () => {
    const database = await getDatabase();
    const sharedPO = 'CPD-PO-260417';
    const externalOrderId = 'SBL-2021-500000';
    const externalOrder = await database
      .prepare(
        'SELECT customer_id, customer_po_number FROM orders WHERE order_id = ?',
      )
      .bind(externalOrderId)
      .first<{ customer_id: string; customer_po_number: string }>();
    expect(externalOrder).toEqual({
      customer_id: 'WHS-1098',
      customer_po_number: 'MCS-PO-500000',
    });
    if (!externalOrder) throw new Error('Missing external order fixture');

    const meridianUser = await database
      .prepare(`SELECT u.user_id AS userId, u.distributor_id AS distributorId,
        u.display_name AS userDisplayName, u.email, u.role,
        d.display_name AS distributorDisplayName, d.account_tier AS accountTier,
        d.payment_terms AS paymentTerms, d.currency, d.region
        FROM users u JOIN distributors d ON d.customer_id = u.distributor_id
        WHERE u.user_id = ? AND u.status = 'active' AND d.account_status = 'active'`)
      .bind('USR-MCS-001')
      .first<AuthenticatedUser>();
    expect(meridianUser?.distributorId).toBe('WHS-1098');
    if (!meridianUser) throw new Error('Missing Meridian user fixture');

    const calderContext = await buildAuthorizedContext(
      database,
      [{ role: 'user', content: 'Show order SBL-2026-000417.' }],
      calderPikeUser,
    );
    const meridianContext = await buildAuthorizedContext(
      database,
      [{ role: 'user', content: `Show order ${externalOrderId}.` }],
      meridianUser,
    );
    expect(calderContext).toContain('Order: SBL-2026-000417;');
    expect(calderContext).toContain('Order total: $78,320.00.');
    expect(meridianContext).toContain(`Order: ${externalOrderId};`);

    try {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(sharedPO, externalOrderId)
        .run();
      const matches = await database
        .prepare(
          'SELECT order_id, customer_id FROM orders WHERE customer_po_number = ? ORDER BY customer_id',
        )
        .bind(sharedPO)
        .all<{ order_id: string; customer_id: string }>();
      expect(matches.results).toEqual([
        { order_id: 'SBL-2026-000417', customer_id: 'WHS-0427' },
        { order_id: externalOrderId, customer_id: 'WHS-1098' },
      ]);

      const messages = [
        { role: 'user' as const, content: `Show customer PO ${sharedPO}.` },
      ];
      const calderResult = await buildAuthorizedContext(
        database,
        messages,
        calderPikeUser,
      );
      const meridianResult = await buildAuthorizedContext(
        database,
        messages,
        meridianUser,
      );
      expect(calderResult).toBe(calderContext);
      expect(meridianResult).toBe(
        meridianContext.replace(
          `customer PO: ${externalOrder.customer_po_number};`,
          `customer PO: ${sharedPO};`,
        ),
      );
      expect(calderResult).not.toContain(externalOrderId);
      expect(meridianResult).not.toContain('SBL-2026-000417');
    } finally {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(externalOrder.customer_po_number, externalOrderId)
        .run();
    }
    expect(
      await database
        .prepare('SELECT customer_po_number FROM orders WHERE order_id = ?')
        .bind(externalOrderId)
        .first('customer_po_number'),
    ).toBe(externalOrder.customer_po_number);
  });

  it('resolves a follow-up to the most recently discussed order', async () => {
    const messages = [
      { role: 'user' as const, content: 'Show me SBL-2026-000418.' },
      { role: 'assistant' as const, content: 'Which details do you need?' },
      { role: 'user' as const, content: 'Switch to SBL-2026-000417.' },
      {
        role: 'assistant' as const,
        content: 'What would you like to know about it?',
      },
      { role: 'user' as const, content: 'What is the total for that order?' },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'SBL-2026-000417',
    });

    const database = await getDatabase();
    const orders = await database
      .prepare(
        `SELECT order_id, customer_id, order_total_cents
         FROM orders WHERE order_id IN (?, ?) ORDER BY order_id`,
      )
      .bind('SBL-2026-000417', 'SBL-2026-000418')
      .all<{
        order_id: string;
        customer_id: string;
        order_total_cents: number;
      }>();
    expect(orders.results).toEqual([
      {
        order_id: 'SBL-2026-000417',
        customer_id: 'WHS-0427',
        order_total_cents: 7_832_000,
      },
      {
        order_id: 'SBL-2026-000418',
        customer_id: 'WHS-0427',
        order_total_cents: 11_800_000,
      },
    ]);

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
    expect(context).toContain('Order total: $78,320.00.');
    expect(context.match(/\bSBL-\d{4}-\d{6}\b/g)).toEqual(['SBL-2026-000417']);
    expect(context).not.toContain('CPD-PO-260418');
    expect(context).not.toContain('$118,000.00');
  });

  it('prioritizes an explicit order over the previously discussed order', async () => {
    const messages = [
      { role: 'user' as const, content: 'Show me SBL-2026-000417.' },
      {
        role: 'assistant' as const,
        content: 'What would you like to know about SBL-2026-000417?',
      },
      {
        role: 'user' as const,
        content: 'For that order total question, use SBL-2026-000418 instead.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'SBL-2026-000418',
    });

    const database = await getDatabase();
    const orders = await database
      .prepare(
        `SELECT order_id, customer_id, order_total_cents
         FROM orders WHERE order_id IN (?, ?) ORDER BY order_id`,
      )
      .bind('SBL-2026-000417', 'SBL-2026-000418')
      .all<{
        order_id: string;
        customer_id: string;
        order_total_cents: number;
      }>();
    expect(orders.results).toEqual([
      {
        order_id: 'SBL-2026-000417',
        customer_id: 'WHS-0427',
        order_total_cents: 7_832_000,
      },
      {
        order_id: 'SBL-2026-000418',
        customer_id: 'WHS-0427',
        order_total_cents: 11_800_000,
      },
    ]);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toContain(
      'Authorization: Calder Pike Distribution (WHS-0427) only.',
    );
    expect(context).toContain(
      'Order: SBL-2026-000418; customer PO: CPD-PO-260418;',
    );
    expect(context).toContain('Order total: $118,000.00.');
    expect(context.match(/\bSBL-\d{4}-\d{6}\b/g)).toEqual(['SBL-2026-000418']);
    expect(context).not.toContain('CPD-PO-260417');
    expect(context).not.toContain('$78,320.00');
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

  it('withholds an order looked up by another distributor customer PO', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status and total of customer PO MCS-PO-500000?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'MCS-PO-500000',
    });

    const database = await getDatabase();
    const externalOrder = await database
      .prepare(
        `SELECT order_id, customer_id
         FROM orders WHERE customer_po_number = ?`,
      )
      .bind('MCS-PO-500000')
      .first<{ order_id: string; customer_id: string }>();

    expect(externalOrder).toEqual({
      order_id: 'SBL-2021-500000',
      customer_id: 'WHS-1098',
    });
    expect(externalOrder?.customer_id).not.toBe(calderPikeUser.distributorId);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
No order matching MCS-PO-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(context).not.toContain('SBL-2021-500000');
    expect(context).not.toContain('WHS-1098');
    expect(context).not.toContain('Meridian Civic Supply');
    expect(context).not.toMatch(/\$\d/);
  });

  it('withholds another distributor order referenced through conversation history', async () => {
    const messages = [
      { role: 'user' as const, content: 'Show me order SBL-2021-500000.' },
      {
        role: 'assistant' as const,
        content: 'I cannot locate that order within your authorization scope.',
      },
      {
        role: 'user' as const,
        content: 'Please tell me the total for that order anyway.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'SBL-2021-500000',
    });

    const database = await getDatabase();
    const externalOrder = await database
      .prepare(
        `SELECT customer_id, customer_po_number, order_total_cents
         FROM orders WHERE order_id = ?`,
      )
      .bind('SBL-2021-500000')
      .first<{
        customer_id: string;
        customer_po_number: string;
        order_total_cents: number;
      }>();

    expect(externalOrder).toMatchObject({
      customer_id: 'WHS-1098',
      customer_po_number: 'MCS-PO-500000',
    });
    if (!externalOrder) throw new Error('Missing external order fixture');
    expect(externalOrder.customer_id).not.toBe(calderPikeUser.distributorId);
    expect(externalOrder.order_total_cents).toBeGreaterThan(0);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
No order matching SBL-2021-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(context).not.toContain(externalOrder.customer_id);
    expect(context).not.toContain(externalOrder.customer_po_number);
    expect(context).not.toContain('Meridian Civic Supply');
    expect(context).not.toMatch(/\$\d/);
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

  it('returns only authorized orders containing the requested product', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show my orders containing the Redline Power Cell R12.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'orders',
      message: 'show my orders containing the redline power cell r12.',
      status: undefined,
      year: undefined,
      yearField: undefined,
    });

    const database = await getDatabase();
    const expectedRows = await database
      .prepare(
        `SELECT o.order_id, o.customer_id
         FROM orders o
         WHERE o.customer_id = ?
           AND EXISTS (
             SELECT 1 FROM order_items oi
             WHERE oi.order_id = o.order_id AND oi.item_number = ?
           )
         ORDER BY o.created_on DESC, o.order_id DESC
         LIMIT 7`,
      )
      .bind(calderPikeUser.distributorId, 'SBL-RPC-12')
      .all<{
        order_id: string;
        customer_id: string;
      }>();

    expect(expectedRows.results).toHaveLength(7);
    expect(
      expectedRows.results.every(
        (row) => row.customer_id === calderPikeUser.distributorId,
      ),
    ).toBe(true);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const contextOrderIds = context.match(/\bSBL-\d{4}-\d{6}\b/g) ?? [];

    expect(context).toContain(
      'Order search for containing product Redline Power Cell R12 (SBL-RPC-12); showing up to 6 most recent matches.',
    );
    expect(contextOrderIds).toEqual(
      expectedRows.results.slice(0, 6).map((row) => row.order_id),
    );
    expect(context).not.toContain(expectedRows.results[6].order_id);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(context.match(/\bSBL-RPC-12\b/g)).toEqual(['SBL-RPC-12']);
  });
});
