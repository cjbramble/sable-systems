import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support account grounding', () => {
  it('builds an exact, tenant-scoped account and charge context', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show my payment terms and recent charge authorizations.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'account',
      includeCharges: true,
    });

    const database = await getDatabase();
    const account = await database
      .prepare(
        `SELECT d.customer_id, d.display_name, d.account_tier,
          d.payment_terms, d.currency, d.region,
          COUNT(o.order_id) AS total_orders,
          SUM(CASE WHEN o.status NOT IN ('delivered', 'cancelled', 'scheduled') THEN 1 ELSE 0 END) AS active_orders,
          SUM(CASE WHEN o.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_orders
         FROM distributors d
         JOIN orders o ON o.customer_id = d.customer_id
         WHERE d.customer_id = ?
         GROUP BY d.customer_id`,
      )
      .bind(calderPikeUser.distributorId)
      .first<Record<string, string | number>>();
    const charges = await database
      .prepare(
        `SELECT c.order_id
         FROM account_charges c
         JOIN orders o ON o.order_id = c.order_id
         WHERE o.customer_id = ?`,
      )
      .bind(calderPikeUser.distributorId)
      .all<{ order_id: string }>();

    expect(account).toEqual({
      customer_id: 'WHS-0427',
      display_name: 'Calder Pike Distribution',
      account_tier: 'Obsidian Preferred',
      payment_terms: 'Net 45',
      currency: 'USD',
      region: 'North Atlantic Trade District',
      total_orders: 648,
      active_orders: 57,
      scheduled_orders: 161,
    });
    expect(charges.results).toEqual([]);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Account tier: Obsidian Preferred; payment terms: Net 45; currency: USD; region: North Atlantic Trade District.
Authenticated user: Mara Venn (USR-CPD-001); role: account_admin.
Orders: 648 total; 57 active; 161 scheduled.
Recent charge-account authorizations:
- No charge-account authorizations recorded.
</authorized_records>`);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(context).not.toContain('Meridian Civic Supply');
  });
});
