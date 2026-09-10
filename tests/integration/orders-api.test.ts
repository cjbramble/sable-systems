import { describe, expect, vi } from 'vitest';

import { POST } from '@/app/api/orders/route';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

type InventoryBalance = {
  item_number: string;
  location_id: string;
  on_hand_quantity: number;
  reserved_quantity: number;
  quarantined_quantity: number;
  inbound_quantity: number;
  expected_restock_date: string | null;
  updated_at: string;
};

describe('orders API', () => {
  test('creates a charge-account order for the authenticated distributor and reserves its inventory', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-SUCCESS';
    const requestedShipDate = '2026-10-15';
    const shippingRegion = 'Great Lakes District';
    const inventory = () =>
      database
        .prepare(`SELECT * FROM inventory_balances
          WHERE item_number IN (?, ?) ORDER BY item_number, location_id`)
        .bind('SBL-RPC-12', 'SBL-SWC-12')
        .all<InventoryBalance>();
    const stockTotals = () =>
      database
        .prepare(`SELECT item_number, SUM(on_hand_quantity) AS on_hand,
          SUM(reserved_quantity) AS reserved,
          SUM(on_hand_quantity - reserved_quantity - quarantined_quantity) AS available
          FROM inventory_balances WHERE item_number IN (?, ?)
          GROUP BY item_number ORDER BY item_number`)
        .bind('SBL-RPC-12', 'SBL-SWC-12')
        .all();
    const ordersForPO = () =>
      database
        .prepare('SELECT * FROM orders WHERE customer_po_number = ?')
        .bind(customerPoNumber)
        .all();

    // Refuse to register cleanup for an existing order. These are test-DB rows.
    expect((await ordersForPO()).results).toEqual([]);
    const beforeInventory = (await inventory()).results;
    expect(beforeInventory).toHaveLength(6);
    onTestFinished(async () => {
      await database.batch([
        // Cascades remove this order's lines, charge, and confirmation event.
        database
          .prepare('DELETE FROM orders WHERE customer_po_number = ?')
          .bind(customerPoNumber),
        ...beforeInventory.map((row) =>
          database
            .prepare(`UPDATE inventory_balances SET on_hand_quantity = ?,
              reserved_quantity = ?, quarantined_quantity = ?, inbound_quantity = ?,
              expected_restock_date = ?, updated_at = ?
              WHERE item_number = ? AND location_id = ?`)
            .bind(
              row.on_hand_quantity,
              row.reserved_quantity,
              row.quarantined_quantity,
              row.inbound_quantity,
              row.expected_restock_date,
              row.updated_at,
              row.item_number,
              row.location_id,
            ),
        ),
      ]);
      expect((await ordersForPO()).results).toEqual([]);
      expect((await inventory()).results).toEqual(beforeInventory);
    });

    // Freeze only the date: database I/O and real timers continue normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2026-09-10T09:00:00.000Z'));
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const session = await supportApi.session(user);
    const headers = new Headers(session.request({}).headers);
    headers.set('Origin', 'http://localhost');
    headers.set('Sec-Fetch-Site', 'same-origin');

    expect((await stockTotals()).results).toEqual([
      { item_number: 'SBL-RPC-12', on_hand: 376, reserved: 64, available: 312 },
      {
        item_number: 'SBL-SWC-12',
        on_hand: 864,
        reserved: 144,
        available: 720,
      },
    ]);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers,
        // The client supplies neither account identity nor prices/totals.
        body: JSON.stringify({
          customerPoNumber,
          requestedShipDate,
          shippingRegion,
          items: [
            { itemNumber: 'SBL-RPC-12', quantity: 16 },
            { itemNumber: 'SBL-SWC-12', quantity: 36 },
          ],
        }),
      }),
    );
    const receipt = (await response.json()) as {
      orderId: string;
      chargeId: string;
      authorizationCode: string;
      totalCents: number;
      requestedShipDate: string;
    };
    expect(response.status, JSON.stringify(receipt)).toBe(201);
    // Independently authored oracle: 16 x 68,000 + 36 x 29,000 cents.
    expect(receipt).toEqual({
      orderId: expect.stringMatching(/^SBL-2026-\d{6}$/),
      chargeId: expect.stringMatching(/^CHG-/),
      authorizationCode: expect.stringMatching(/^ACC-/),
      totalCents: 2_132_000,
      requestedShipDate,
    });
    expect((await ordersForPO()).results).toEqual([
      {
        order_id: receipt.orderId,
        customer_id: 'WHS-1098',
        placed_by_user_id: 'USR-MCS-001',
        customer_po_number: customerPoNumber,
        created_on: '2026-09-10',
        requested_ship_date: requestedShipDate,
        status: 'confirmed',
        currency: 'USD',
        order_total_cents: 2_132_000,
        shipping_region: shippingRegion,
      },
    ]);
    const lines = await database
      .prepare(
        'SELECT * FROM order_items WHERE order_id = ? ORDER BY line_number',
      )
      .bind(receipt.orderId)
      .all();
    expect(lines.results).toEqual([
      {
        order_id: receipt.orderId,
        line_number: 1,
        item_number: 'SBL-RPC-12',
        product_name_snapshot: 'Redline Power Cell R12',
        unit_price_cents: 68_000,
        ordered_quantity: 16,
        allocated_quantity: 16,
        shipped_quantity: 0,
        cancelled_quantity: 0,
      },
      {
        order_id: receipt.orderId,
        line_number: 2,
        item_number: 'SBL-SWC-12',
        product_name_snapshot: 'Signal-Weave Active Cable, 12 m',
        unit_price_cents: 29_000,
        ordered_quantity: 36,
        allocated_quantity: 36,
        shipped_quantity: 0,
        cancelled_quantity: 0,
      },
    ]);
    const charges = await database
      .prepare(`SELECT charge_id, order_id, charge_method, status,
        amount_cents, currency, authorization_code
        FROM account_charges WHERE order_id = ?`)
      .bind(receipt.orderId)
      .all();
    expect(charges.results).toEqual([
      {
        charge_id: receipt.chargeId,
        order_id: receipt.orderId,
        charge_method: 'charge_account',
        status: 'authorized',
        amount_cents: 2_132_000,
        currency: 'USD',
        authorization_code: receipt.authorizationCode,
      },
    ]);
    const events = await database
      .prepare('SELECT event_type FROM order_events WHERE order_id = ?')
      .bind(receipt.orderId)
      .all();
    expect(events.results).toEqual([{ event_type: 'order_confirmed' }]);
    // Checkout reserves stock; it does not ship it or reduce on-hand quantities.
    expect((await stockTotals()).results).toEqual([
      { item_number: 'SBL-RPC-12', on_hand: 376, reserved: 80, available: 296 },
      {
        item_number: 'SBL-SWC-12',
        on_hand: 864,
        reserved: 180,
        available: 684,
      },
    ]);
  });
});
