import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support return grounding', () => {
  it('builds an exact, tenant-scoped context for an authorized return', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of return RTN-2022-000014?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'return',
      identifier: 'RTN-2022-000014',
    });

    const database = await getDatabase();
    const returnRecord = await database
      .prepare(
        `SELECT r.return_id, r.status, r.reason_code, r.requested_on,
          r.authorized_on, r.received_on, o.order_id, o.customer_po_number,
          o.customer_id, ri.return_quantity, ri.disposition,
          oi.item_number, oi.product_name_snapshot
         FROM returns r
         JOIN orders o ON o.order_id = r.order_id
         JOIN return_items ri ON ri.return_id = r.return_id
         JOIN order_items oi
           ON oi.order_id = ri.order_id AND oi.line_number = ri.line_number
         WHERE r.return_id = ?`,
      )
      .bind('RTN-2022-000014')
      .first<Record<string, string | number | null>>();

    expect(returnRecord).toEqual({
      return_id: 'RTN-2022-000014',
      status: 'closed',
      reason_code: 'sealed_surplus',
      requested_on: '2022-07-08',
      authorized_on: '2022-07-09',
      received_on: '2022-07-21',
      order_id: 'SBL-2022-000118',
      customer_po_number: 'CPD-PO-220118',
      customer_id: 'WHS-0427',
      return_quantity: 12,
      disposition: 'restock',
      item_number: 'SBL-DMK-A9',
      product_name_snapshot: 'Dermal Maintenance Kit A9',
    });

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Return: RTN-2022-000014; status: closed; reason: sealed_surplus.
Order: SBL-2022-000118; customer PO: CPD-PO-220118.
Requested: 2022-07-08; authorized: 2022-07-09; received: 2022-07-21.
Items:
- SBL-DMK-A9 Dermal Maintenance Kit A9: quantity 12; disposition restock.
</authorized_records>`);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('withholds facts for an unknown return', async () => {
    const unknownReturnId = 'RTN-2031-999999';
    const messages = [
      {
        role: 'user' as const,
        content: `What is the status of return ${unknownReturnId}?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'return',
      identifier: unknownReturnId,
    });

    const database = await getDatabase();
    const returnRecord = await database
      .prepare('SELECT return_id FROM returns WHERE return_id = ?')
      .bind(unknownReturnId)
      .first<{ return_id: string }>();

    expect(returnRecord).toBeNull();

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
No return matching ${unknownReturnId} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(context.match(/\bRTN-\d{4}-\d{6}\b/g)).toEqual([unknownReturnId]);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
    expect(context).not.toContain('Meridian Civic Supply');
  });
});
