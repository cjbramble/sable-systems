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
});
