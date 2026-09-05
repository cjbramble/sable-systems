import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support shipment grounding', () => {
  it('builds an exact, tenant-scoped context for an authorized shipment', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Where is shipment SHP-2026-000417?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'shipment',
      identifier: 'SHP-2026-000417',
    });

    const database = await getDatabase();
    const shipment = await database
      .prepare(
        `SELECT s.shipment_id, s.status, s.carrier_name, s.tracking_reference,
          s.shipped_on, s.estimated_delivery_date, s.delivered_on,
          o.order_id, o.customer_po_number, o.customer_id
         FROM shipments s
         JOIN orders o ON o.order_id = s.order_id
         WHERE s.shipment_id = ?`,
      )
      .bind('SHP-2026-000417')
      .first<Record<string, string | null>>();

    expect(shipment).toEqual({
      shipment_id: 'SHP-2026-000417',
      status: 'delayed',
      carrier_name: 'Astra Freight Systems',
      tracking_reference: 'AST-2026000417',
      shipped_on: '2026-08-26',
      estimated_delivery_date: '2026-08-31',
      delivered_on: null,
      order_id: 'SBL-2026-000417',
      customer_po_number: 'CPD-PO-260417',
      customer_id: 'WHS-0427',
    });

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Shipment: SHP-2026-000417; status: delayed; carrier: Astra Freight Systems; tracking: AST-2026000417.
Order: SBL-2026-000417; customer PO: CPD-PO-260417.
Shipped: 2026-08-26; estimated delivery: 2026-08-31; delivered: not yet.
</authorized_records>`);
    expect(context.match(/\bWHS-\d{4}\b/g)).toEqual(['WHS-0427']);
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('withholds a shipment owned by another distributor', async () => {
    const database = await getDatabase();
    const externalShipment = await database
      .prepare(
        `SELECT s.shipment_id, s.tracking_reference,
          o.order_id, o.customer_po_number, o.customer_id
         FROM shipments s
         JOIN orders o ON o.order_id = s.order_id
         WHERE o.customer_id <> ?
         ORDER BY s.shipment_id
         LIMIT 1`,
      )
      .bind(calderPikeUser.distributorId)
      .first<Record<string, string>>();

    expect(externalShipment).not.toBeNull();
    if (!externalShipment) return;

    expect(externalShipment.customer_id).not.toBe(calderPikeUser.distributorId);

    const messages = [
      {
        role: 'user' as const,
        content: `Where is shipment ${externalShipment.shipment_id}?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'shipment',
      identifier: externalShipment.shipment_id,
    });

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
No shipment matching ${externalShipment.shipment_id} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`);
    expect(context).not.toContain(externalShipment.tracking_reference);
    expect(context).not.toContain(externalShipment.order_id);
    expect(context).not.toContain(externalShipment.customer_po_number);
    expect(context).not.toContain(externalShipment.customer_id);
  });
});
