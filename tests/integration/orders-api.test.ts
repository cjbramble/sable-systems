import { describe, expect, vi } from 'vitest';

import { GET, POST } from '@/app/api/orders/route';
import { placeChargeAccountOrder } from '@/db/shop';
import type { OrderHistoryResponse, OrderStatus } from '@/lib/contracts';
import {
  createCheckoutFixture,
  snapshotCheckoutState,
} from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

describe('orders API', () => {
  test('scopes history, search results, and totals to the authenticated distributor', async ({
    database,
    supportApi,
  }) => {
    // Build the ownership oracle from raw rows, independently of the history
    // query, its SQL predicates, and its aggregate-count implementation.
    const { results: orders } = await database
      .prepare(`SELECT order_id, customer_id, status FROM orders
        ORDER BY created_on DESC, order_id DESC`)
      .all<{
        order_id: string;
        customer_id: string;
        status: OrderStatus;
      }>();
    const scenarios = [
      { userId: 'USR-MCS-001', customerId: 'WHS-1098', count: 24 },
      { userId: 'USR-CPD-001', customerId: 'WHS-0427', count: 648 },
    ];

    for (const scenario of scenarios) {
      const user = await loadActiveUserFixture(database, scenario.userId);
      expect(user.distributorId).toBe(scenario.customerId);
      const session = await supportApi.session(user);
      const history = async (query = '') => {
        const url = new URL('http://localhost/api/orders');
        if (query) url.searchParams.set('query', query);
        const response = await GET(
          new Request(url, { headers: session.request({}).headers }),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as OrderHistoryResponse;
      };
      const owned = orders.filter(
        (order) => order.customer_id === scenario.customerId,
      );
      expect(owned).toHaveLength(scenario.count);
      const account = {
        customerId: scenario.customerId,
        displayName: user.distributorDisplayName,
        userDisplayName: user.userDisplayName,
        accountTier: user.accountTier,
        currency: user.currency,
        region: user.region,
      };
      const summary = {
        totalOrders: owned.length,
        activeOrders: owned.filter((order) =>
          [
            'confirmed',
            'allocating',
            'backordered',
            'partially_shipped',
            'shipped',
            'on_hold',
          ].includes(order.status),
        ).length,
        scheduledOrders: owned.filter((order) => order.status === 'scheduled')
          .length,
        fulfilledOrders: owned.filter((order) => order.status === 'delivered')
          .length,
      };

      const listed = await history();
      expect(listed).toMatchObject({
        account,
        page: 1,
        pageSize: 25,
        total: owned.length,
        totalPages: Math.ceil(owned.length / 25),
        summary,
      });
      expect(listed.orders.map((order) => order.orderId)).toEqual(
        owned.slice(0, 25).map((order) => order.order_id),
      );

      // Each foreign ID is visible in its owner's first page in this same test.
      // A known exact ID must not bypass account scoping or leak its count.
      const other = scenarios.find((entry) => entry !== scenario)!;
      const foreignOrder = orders.find(
        (order) => order.customer_id === other.customerId,
      );
      expect(foreignOrder).toBeDefined();
      expect(await history(foreignOrder!.order_id)).toEqual({
        account,
        orders: [],
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 1,
        // Account-wide totals stay scoped, even when a search has no matches.
        summary,
      });
    }
  });

  test('creates a charge-account order for the authenticated distributor and reserves its inventory', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-SUCCESS';
    const requestedShipDate = '2026-10-15';
    const checkoutAt = '2026-09-10T09:17:23.456Z';
    const shippingRegion = 'Great Lakes District';
    const { stockTotals, ordersForPO, beforeInventory, inventory } =
      await createCheckoutFixture(database, customerPoNumber, [
        'SBL-RPC-12',
        'SBL-SWC-12',
      ]);
    expect(beforeInventory).toHaveLength(6);

    // Freeze only the date: database I/O and real timers continue normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date(checkoutAt));
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
        amount_cents, currency, authorization_code, authorized_at
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
        authorized_at: checkoutAt,
      },
    ]);
    const events = await database
      .prepare(
        'SELECT event_type, occurred_at FROM order_events WHERE order_id = ?',
      )
      .bind(receipt.orderId)
      .all();
    expect(events.results).toEqual([
      { event_type: 'order_confirmed', occurred_at: checkoutAt },
    ]);
    const changedInventory = (await inventory()).results.filter(
      (row, index) =>
        row.reserved_quantity !== beforeInventory[index].reserved_quantity,
    );
    expect(changedInventory).toHaveLength(2);
    expect(changedInventory.map((row) => row.updated_at)).toEqual([
      checkoutAt,
      checkoutAt,
    ]);
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

  test('rejects impossible and past ship dates without business writes', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-DATE';
    await createCheckoutFixture(database, customerPoNumber, ['SBL-RPC-12']);
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2026-09-10T09:17:23.456Z'));
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const session = await supportApi.session(user);
    const before = await snapshotCheckoutState(database);

    for (const requestedShipDate of [
      '2031-13-01',
      '2031-00-01',
      '2031-04-31',
      '2031-02-29',
      '2100-02-29',
      '2026-09-09',
    ]) {
      const input = {
        customerPoNumber,
        requestedShipDate,
        shippingRegion: 'Great Lakes District',
        items: [{ itemNumber: 'SBL-RPC-12', quantity: 8 }],
      };
      const response = await POST(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: session.request({}).headers,
          body: JSON.stringify(input),
        }),
      );
      const pastDate = requestedShipDate === '2026-09-09';
      expect(response.status, requestedShipDate).toBe(pastDate ? 422 : 400);
      expect(await snapshotCheckoutState(database), requestedShipDate).toEqual(
        before,
      );

      // The business operation must also reject invalid dates without its HTTP parser.
      await expect(
        placeChargeAccountOrder(database, input, user),
      ).rejects.toMatchObject({
        status: 422,
        message: pastDate
          ? 'Requested ship date cannot be in the past.'
          : 'Enter a valid requested ship date.',
      });
      expect(await snapshotCheckoutState(database), requestedShipDate).toEqual(
        before,
      );
    }
  });

  test('keeps one checkout instant when a same-day leap-day order crosses UTC midnight', async ({
    database,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-MIDNIGHT';
    const { ordersForPO, inventory, beforeInventory } =
      await createCheckoutFixture(database, customerPoNumber, ['SBL-RPC-12']);
    const checkoutAt = '2028-02-29T23:59:59.999Z';
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2028-03-01T00:59:59.999+01:00'));
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const originalPrepare = database.prepare.bind(database);
    // Advance during the first business read, before reservations/charge/event
    // statements are built. All writes must retain the instant captured on entry.
    const prepare = vi
      .spyOn(database, 'prepare')
      .mockImplementationOnce((sql) => {
        vi.setSystemTime(new Date('2028-03-01T00:00:00.123Z'));
        return originalPrepare(sql);
      });
    let receipt: Awaited<ReturnType<typeof placeChargeAccountOrder>>;
    try {
      receipt = await placeChargeAccountOrder(
        database,
        {
          customerPoNumber,
          requestedShipDate: '2028-02-29',
          shippingRegion: 'Great Lakes District',
          items: [{ itemNumber: 'SBL-RPC-12', quantity: 8 }],
        },
        user,
      );
      expect(prepare).toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(new Date().toISOString()).toBe('2028-03-01T00:00:00.123Z');
    expect(receipt.orderId).toMatch(/^SBL-2028-\d{6}$/);
    expect((await ordersForPO()).results).toEqual([
      expect.objectContaining({
        created_on: '2028-02-29',
        requested_ship_date: '2028-02-29',
      }),
    ]);
    expect(
      await database
        .prepare('SELECT authorized_at FROM account_charges WHERE order_id = ?')
        .bind(receipt.orderId)
        .first(),
    ).toEqual({ authorized_at: checkoutAt });
    expect(
      await database
        .prepare('SELECT occurred_at FROM order_events WHERE order_id = ?')
        .bind(receipt.orderId)
        .first(),
    ).toEqual({ occurred_at: checkoutAt });
    const changedInventory = (await inventory()).results.filter(
      (row, index) =>
        row.reserved_quantity !== beforeInventory[index].reserved_quantity,
    );
    expect(changedInventory).toHaveLength(1);
    expect(changedInventory[0].updated_at).toBe(checkoutAt);
  });

  test('rejects insufficient stock on a later line without changing orders, charges, or inventory', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-SHORTFALL';
    const { stockTotals } = await createCheckoutFixture(
      database,
      customerPoNumber,
      ['SBL-RPC-12', 'SBL-SWC-12'],
    );
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
    // Full, ordered rows catch partial inserts, altered metadata, and changes to
    // existing records, not just a missing order with this PO or unchanged counts.
    const before = await snapshotCheckoutState(database);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customerPoNumber,
          requestedShipDate: '2026-10-15',
          shippingRegion: 'Great Lakes District',
          items: [
            // A valid first line must not be reserved when a later line fails.
            { itemNumber: 'SBL-RPC-12', quantity: 16 },
            // Valid pack of 12, but 732 requested exceeds 720 available.
            { itemNumber: 'SBL-SWC-12', quantity: 732 },
          ],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Signal-Weave Active Cable, 12 m has only 720 units available.',
    });
    // Check before fixture cleanup so cleanup cannot hide partial writes.
    const after = await snapshotCheckoutState(database);
    for (const table of [
      'orders',
      'lines',
      'charges',
      'events',
      'inventory',
    ] as const) {
      expect(after[table], `No changes to ${table}`).toEqual(before[table]);
    }
  });

  test('allows only one concurrent checkout for the last stock and rolls back the losing order', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const purchaseOrders = ['MCS-TEST-RACE-A', 'MCS-TEST-RACE-B'];
    const first = await createCheckoutFixture(database, purchaseOrders[0], [
      'SBL-RPC-12',
      'SBL-SWC-12',
    ]);
    // Capture the same original inventory before either fixture changes it.
    await createCheckoutFixture(database, purchaseOrders[1], [
      'SBL-RPC-12',
      'SBL-SWC-12',
    ]);
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

    // Leave one eight-unit Redline case available at ATL-01, none elsewhere.
    await database
      .prepare(`UPDATE inventory_balances
        SET reserved_quantity = on_hand_quantity - quarantined_quantity
          - CASE WHEN location_id = 'ATL-01' THEN 8 ELSE 0 END
        WHERE item_number = ?`)
      .bind('SBL-RPC-12')
      .run();
    expect((await first.stockTotals()).results).toEqual([
      { item_number: 'SBL-RPC-12', on_hand: 376, reserved: 368, available: 8 },
      {
        item_number: 'SBL-SWC-12',
        on_hand: 864,
        reserved: 144,
        available: 720,
      },
    ]);
    const before = await snapshotCheckoutState(database);
    expect(
      before.orders.some(
        (row) =>
          row.order_id === 'SBL-2026-899990' ||
          row.order_id === 'SBL-2026-899991',
      ),
    ).toBe(false);

    // Pin distinct order IDs so a random ID collision cannot masquerade as a
    // stock conflict. Authentication has already obtained its real session.
    let sequence = 99_990;
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation((array) => {
        if (!(array instanceof Uint32Array) || array.length !== 1)
          throw new Error('Unexpected random request during checkout');
        array[0] = sequence++;
        return array;
      });
    const originalBatch = database.batch.bind(database);
    let arrivals = 0;
    let timedOut = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batch = vi
      .spyOn(database, 'batch')
      .mockImplementation(async <T>(statements: D1PreparedStatement[]) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
        // Only synchronize arrival; keep the real transaction and constraints.
        return originalBatch<T>(statements);
      });
    const timeout = setTimeout(() => {
      timedOut = true;
      release();
    }, 2_000);
    const requests: Promise<Response>[] = [];
    let responses: Response[];
    try {
      for (const customerPoNumber of purchaseOrders) {
        requests.push(
          POST(
            new Request('http://localhost/api/orders', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                customerPoNumber,
                requestedShipDate: '2026-10-15',
                shippingRegion: 'Great Lakes District',
                items: [
                  // Its reservation precedes the scarce item in the real batch.
                  { itemNumber: 'SBL-SWC-12', quantity: 12 },
                  { itemNumber: 'SBL-RPC-12', quantity: 8 },
                ],
              }),
            }),
          ),
        );
      }
      responses = await Promise.all(requests);
      expect(timedOut, 'Both transactions must reach the write gate').toBe(
        false,
      );
      expect(arrivals).toBe(2);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.allSettled(requests);
      clearTimeout(timeout);
      batch.mockRestore();
      random.mockRestore();
    }

    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 409]);
    const winner = responses.findIndex((response) => response.status === 201);
    const receipt = (await responses[winner].json()) as Record<
      string,
      string | number
    >;
    expect(receipt).toMatchObject({
      totalCents: 892_000,
      requestedShipDate: '2026-10-15',
    });
    expect(await responses[1 - winner].json()).toEqual({
      error: 'Inventory changed during checkout. Refresh and try again.',
    });
    const after = await snapshotCheckoutState(database);
    const winningRows = <K extends 'orders' | 'lines' | 'charges' | 'events'>(
      table: K,
    ) => after[table].filter((row) => row.order_id === receipt.orderId);
    expect(winningRows('orders')).toHaveLength(1);
    expect(winningRows('orders')[0]).toMatchObject({
      customer_po_number: purchaseOrders[winner],
      customer_id: 'WHS-1098',
      placed_by_user_id: 'USR-MCS-001',
      status: 'confirmed',
      order_total_cents: 892_000,
    });
    expect(
      winningRows('lines').map((row) => ({
        item: row.item_number,
        ordered: row.ordered_quantity,
        allocated: row.allocated_quantity,
      })),
    ).toEqual([
      { item: 'SBL-SWC-12', ordered: 12, allocated: 12 },
      { item: 'SBL-RPC-12', ordered: 8, allocated: 8 },
    ]);
    expect(winningRows('charges')).toHaveLength(1);
    expect(winningRows('charges')[0]).toMatchObject({
      charge_id: receipt.chargeId,
      authorization_code: receipt.authorizationCode,
      charge_method: 'charge_account',
      status: 'authorized',
      amount_cents: 892_000,
      currency: 'USD',
    });
    expect(winningRows('events').map((row) => row.event_type)).toEqual([
      'order_confirmed',
    ]);
    // The only new business rows belong to the winner; no partial loser remains.
    for (const table of ['orders', 'lines', 'charges', 'events'] as const) {
      expect(
        after[table].filter((row) => row.order_id !== receipt.orderId),
        table,
      ).toEqual(before[table]);
    }
    expect((await first.stockTotals()).results).toEqual([
      { item_number: 'SBL-RPC-12', on_hand: 376, reserved: 376, available: 0 },
      {
        item_number: 'SBL-SWC-12',
        on_hand: 864,
        reserved: 156,
        available: 708,
      },
    ]);
    expect(after.inventory).toEqual(
      before.inventory.map((row) =>
        ['SBL-RPC-12', 'SBL-SWC-12'].includes(String(row.item_number))
          ? {
              ...row,
              reserved_quantity: expect.any(Number),
              updated_at: expect.any(String),
            }
          : row,
      ),
    );
    for (const row of after.inventory) {
      expect(
        Number(row.on_hand_quantity) -
          Number(row.reserved_quantity) -
          Number(row.quarantined_quantity),
        `${row.item_number}/${row.location_id}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
