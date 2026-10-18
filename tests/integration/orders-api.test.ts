import { describe, expect, vi } from 'vitest';

import { GET, POST } from '@/app/api/orders/route';
import { getOrderHistory } from '@/db/orders';
import { placeChargeAccountOrder } from '@/db/shop';
import type {
  CheckoutInput,
  OrderHistoryResponse,
  OrderStatus,
} from '@/lib/contracts';
import {
  checkoutCommand,
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
        userId: user.userId,
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

  test('filters, pages, and searches history against raw rows', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    // One seed order temporarily carries LIKE wildcards in its PO.
    const wildcardPo = 'WILD%CARD_PO\\X';
    const target = await database
      .prepare(`SELECT order_id, customer_po_number FROM orders
        WHERE customer_id = 'WHS-0427' ORDER BY order_id LIMIT 1`)
      .first<{ order_id: string; customer_po_number: string }>();
    expect(target).not.toBeNull();
    await database
      .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
      .bind(wildcardPo, target!.order_id)
      .run();
    onTestFinished(async () => {
      await database
        .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
        .bind(target!.customer_po_number, target!.order_id)
        .run();
    });

    // Seeded orders on one day share a creation time, so raw order-ID order
    // breaks ties the same way the history query does.
    const { results: rows } = await database
      .prepare(`SELECT o.order_id, o.customer_po_number, o.status,
        u.display_name
        FROM orders o JOIN users u ON u.user_id = o.placed_by_user_id
        WHERE o.customer_id = 'WHS-0427'
        ORDER BY o.created_on DESC, o.order_id DESC`)
      .all<{
        order_id: string;
        customer_po_number: string;
        status: OrderStatus;
        display_name: string;
      }>();
    expect(rows).toHaveLength(648);
    const user = await loadActiveUserFixture(database, 'USR-CPD-001');
    const session = await supportApi.session(user);
    const history = async (parameters: Record<string, string>) => {
      const url = new URL('http://localhost/api/orders');
      for (const [name, value] of Object.entries(parameters))
        url.searchParams.set(name, value);
      const response = await GET(
        new Request(url, { headers: session.request({}).headers }),
      );
      expect(response.status, url.search).toBe(200);
      return (await response.json()) as OrderHistoryResponse;
    };
    const ids = (orders: { order_id: string }[]) =>
      orders.map((order) => order.order_id);
    const listedIds = (listed: OrderHistoryResponse) =>
      listed.orders.map((order) => order.orderId);

    const statusFilters: [string, OrderStatus[] | null][] = [
      ['all', null],
      [
        'active',
        [
          'confirmed',
          'allocating',
          'backordered',
          'partially_shipped',
          'shipped',
          'on_hold',
        ],
      ],
      ['scheduled', ['scheduled']],
      ['fulfilled', ['delivered']],
      ['closed', ['cancelled']],
    ];
    for (const [status, statuses] of statusFilters) {
      const expected = rows.filter(
        (row) => !statuses || statuses.includes(row.status),
      );
      expect(expected.length, status).toBeGreaterThan(0);
      const listed = await history({ status });
      expect(listed, status).toMatchObject({
        page: 1,
        total: expected.length,
        totalPages: Math.ceil(expected.length / 25),
      });
      expect(listedIds(listed), status).toEqual(ids(expected.slice(0, 25)));
    }
    expect(rows.some((row) => row.status === 'on_hold')).toBe(true);

    const lastPage = Math.ceil(rows.length / 25);
    const pages: [string, number, number][] = [
      ['second page', 2, 2],
      ['last page', lastPage, lastPage],
      ['past the last page', lastPage + 1, lastPage],
      ['far past the last page', 10_000, lastPage],
    ];
    for (const [name, requested, served] of pages) {
      const listed = await history({ page: String(requested) });
      expect(listed, name).toMatchObject({
        page: served,
        total: rows.length,
        totalPages: lastPage,
      });
      expect(listedIds(listed), name).toEqual(
        ids(rows.slice((served - 1) * 25, served * 25)),
      );
    }
    expect(
      await history({ page: '3', query: 'no order matches this' }),
    ).toMatchObject({ orders: [], page: 1, total: 0, totalPages: 1 });

    const buyer = rows[0].display_name;
    const matches = (query: string) =>
      rows.filter((row) =>
        [row.order_id, row.customer_po_number, row.display_name].some((value) =>
          value.toLowerCase().includes(query.toLowerCase()),
        ),
      );
    const searches: [string, string, number | null][] = [
      ['buyer name', buyer, null],
      ['partial lower-case buyer name', buyer.slice(1, -1).toLowerCase(), null],
      [
        'partial lower-case order ID',
        rows[3].order_id.slice(4).toLowerCase(),
        null,
      ],
      ['percent sign', '%', 1],
      ['underscore', '_', 1],
      ['backslash', '\\', 1],
      ['literal wildcard run', 'd%card_po\\x', 1],
      ['underscore is not a single-character wildcard', 'WILD_CARD', 0],
      ['percent is not a multi-character wildcard', 'WILD%PO', 0],
    ];
    for (const [name, query, count] of searches) {
      const expected = matches(query);
      if (count !== null) expect(expected, name).toHaveLength(count);
      else expect(expected.length, name).toBeGreaterThan(0);
      const listed = await history({ query });
      expect(listed.total, name).toBe(expected.length);
      expect(listedIds(listed), name).toEqual(ids(expected.slice(0, 25)));
    }
    expect(
      (await history({ query: '%' })).orders.map(
        (order) => order.customerPoNumber,
      ),
    ).toEqual([wildcardPo]);
  });

  test('rejects an invalid page, status, or query length', async ({
    database,
    supportApi,
  }) => {
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const session = await supportApi.session(user);
    const status = async (parameters: Record<string, string>) => {
      const url = new URL('http://localhost/api/orders');
      for (const [name, value] of Object.entries(parameters))
        url.searchParams.set(name, value);
      const response = await GET(
        new Request(url, { headers: session.request({}).headers }),
      );
      return response.status;
    };
    const cases: [string, Record<string, string>, number][] = [
      ['page zero', { page: '0' }, 400],
      ['negative page', { page: '-1' }, 400],
      ['fractional page', { page: '1.5' }, 400],
      ['non-numeric page', { page: 'two' }, 400],
      ['page above the bound', { page: '10001' }, 400],
      ['unknown status', { status: 'open' }, 400],
      ['raw status name', { status: 'on_hold' }, 400],
      ['81-character query', { query: 'x'.repeat(81) }, 400],
      ['80-character query', { query: 'x'.repeat(80) }, 200],
      ['highest page', { page: '10000' }, 200],
    ];
    for (const [name, parameters, expected] of cases)
      expect(await status(parameters), name).toBe(expected);
  });

  test('lists same-day orders newest first whatever their random IDs', async ({
    database,
    onTestFinished,
  }) => {
    const purchaseOrders = ['MCS-TEST-SAME-DAY-A', 'MCS-TEST-SAME-DAY-B'];
    for (const customerPoNumber of purchaseOrders)
      await createCheckoutFixture(database, customerPoNumber, ['SBL-RPC-12']);
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    // The earlier order gets the higher random ID, so ID order is wrong.
    const randomIds = [199_998, 1];
    const { results: existing } = await database
      .prepare('SELECT order_id FROM orders WHERE order_id IN (?, ?)')
      .bind('SBL-2026-999998', 'SBL-2026-800001')
      .all();
    expect(existing).toEqual([]);
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation((array) => {
        if (!(array instanceof Uint32Array) || array.length !== 1)
          throw new Error('Unexpected random request during checkout');
        array[0] = randomIds.shift()!;
        return array;
      });
    const receipts = [];
    try {
      for (const [index, time] of ['09:00', '15:00'].entries()) {
        vi.setSystemTime(new Date(`2026-09-10T${time}:00.000Z`));
        receipts.push(
          await placeChargeAccountOrder(
            database,
            checkoutCommand(purchaseOrders[index], {
              requestedShipDate: '2026-10-15',
            }),
            user,
          ),
        );
      }
    } finally {
      random.mockRestore();
    }
    expect(receipts.map((receipt) => receipt.orderId)).toEqual([
      'SBL-2026-999998',
      'SBL-2026-800001',
    ]);

    const listed = await getOrderHistory(database, user, {
      page: 1,
      status: 'all',
      query: 'MCS-TEST-SAME-DAY',
    });
    expect(listed.orders.map((order) => order.orderId)).toEqual([
      'SBL-2026-800001',
      'SBL-2026-999998',
    ]);
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
        // The expected subject is a stale-context guard; server identity owns the order.
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedSubject: {
            userId: user.userId,
            customerId: user.distributorId,
          },
          customerPoNumber,
          requestedShipDate,
          shippingRegion,
          items: [
            {
              itemNumber: 'SBL-RPC-12',
              quantity: 16,
              expectedUnitPriceCents: 68000,
            },
            {
              itemNumber: 'SBL-SWC-12',
              quantity: 36,
              expectedUnitPriceCents: 29000,
            },
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
      commandId: expect.any(String),
      currency: 'USD',
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
      // Without a time zone, checkout uses the UTC date.
      '2026-09-09',
    ]) {
      const input = {
        commandId: crypto.randomUUID(),
        expectedSubject: {
          userId: user.userId,
          customerId: user.distributorId,
        },
        customerPoNumber,
        requestedShipDate,
        shippingRegion: 'Great Lakes District',
        items: [
          {
            itemNumber: 'SBL-RPC-12',
            quantity: 8,
            expectedUnitPriceCents: 68000,
          },
        ],
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
        status: pastDate ? 422 : 400,
      });
      expect(await snapshotCheckoutState(database), requestedShipDate).toEqual(
        before,
      );
    }
  });

  test('checks the ship date against the customer-local date at submission', async ({
    database,
    onTestFinished,
  }) => {
    const customerPoNumber = 'MCS-TEST-CHECKOUT-LOCAL-DAY';
    const { ordersForPO } = await createCheckoutFixture(
      database,
      customerPoNumber,
      ['SBL-RPC-12'],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const order = (requestedShipDate: string, timeZone?: string) =>
      placeChargeAccountOrder(
        database,
        {
          commandId: crypto.randomUUID(),
          expectedSubject: {
            userId: user.userId,
            customerId: user.distributorId,
          },
          customerPoNumber,
          requestedShipDate,
          shippingRegion: 'Great Lakes District',
          ...(timeZone === undefined ? {} : { timeZone }),
          items: [
            {
              itemNumber: 'SBL-RPC-12',
              quantity: 8,
              expectedUnitPriceCents: 68000,
            },
          ],
        },
        user,
      );
    const past = {
      status: 422,
      message: 'Requested ship date cannot be in the past.',
    };

    // 10:30 UTC on 09-10 is 00:30 on 09-11 in Kiritimati (UTC+14): a page
    // opened there the day before cannot submit its stale earliest date.
    vi.setSystemTime(new Date('2026-09-10T10:30:00.000Z'));
    await expect(
      order('2026-09-10', 'Pacific/Kiritimati'),
    ).rejects.toMatchObject(past);

    // 06:30 UTC on 09-10 is 20:30 on 09-09 in Honolulu (UTC-10).
    vi.setSystemTime(new Date('2026-09-10T06:30:00.000Z'));
    await expect(order('2026-09-08', 'Pacific/Honolulu')).rejects.toMatchObject(
      past,
    );
    // A request without a time zone uses the UTC date.
    await expect(order('2026-09-09')).rejects.toMatchObject(past);
    // The 18-day lead time also counts from the customer's local date.
    await expect(order('2026-09-27')).rejects.toMatchObject({
      status: 422,
      message:
        'Requested ship date must be on or after 2026-09-28 to cover the 18-day lead time.',
    });
    const receipt = await order('2026-09-27', 'Pacific/Honolulu');

    expect((await ordersForPO()).results).toEqual([
      expect.objectContaining({
        order_id: receipt.orderId,
        created_on: '2026-09-10',
        requested_ship_date: '2026-09-27',
      }),
    ]);
  });

  test('requires the order lead time, caps the horizon, and schedules far-future orders', async ({
    database,
    onTestFinished,
  }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // 10:30 UTC on 09-10 is 00:30 on 09-11 in Kiritimati (UTC+14).
    vi.setSystemTime(new Date('2026-09-10T10:30:00.000Z'));
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const cell = {
      itemNumber: 'SBL-RPC-12',
      quantity: 8,
      expectedUnitPriceCents: 68000,
    };
    // SBL-KTA-T7 has the longest active lead time: 60 days.
    const tendon = await database
      .prepare(
        "SELECT case_pack, unit_price_cents, lead_time_days FROM products WHERE item_number = 'SBL-KTA-T7'",
      )
      .first<{
        case_pack: number;
        unit_price_cents: number;
        lead_time_days: number;
      }>();
    expect(tendon?.lead_time_days).toBe(60);
    const tendonLine = {
      itemNumber: 'SBL-KTA-T7',
      quantity: tendon!.case_pack,
      expectedUnitPriceCents: tendon!.unit_price_cents,
    };
    const license = await database
      .prepare(
        "SELECT case_pack, unit_price_cents FROM products WHERE item_number = 'SBL-PAL-1Y'",
      )
      .first<{ case_pack: number; unit_price_cents: number }>();
    const licenseLine = {
      itemNumber: 'SBL-PAL-1Y',
      quantity: license!.case_pack,
      expectedUnitPriceCents: license!.unit_price_cents,
    };
    const order = (
      customerPoNumber: string,
      requestedShipDate: string,
      items: CheckoutInput['items'],
      timeZone?: string,
    ) =>
      placeChargeAccountOrder(
        database,
        checkoutCommand(customerPoNumber, {
          requestedShipDate,
          items,
          ...(timeZone === undefined ? {} : { timeZone }),
        }),
        user,
      );
    const statusOf = async (customerPoNumber: string) =>
      database
        .prepare('SELECT status FROM orders WHERE customer_po_number = ?')
        .bind(customerPoNumber)
        .first('status');

    const rejectedPo = 'MCS-TEST-SHIP-WINDOW-REJECT';
    await createCheckoutFixture(database, rejectedPo, [
      'SBL-RPC-12',
      'SBL-KTA-T7',
    ]);
    const before = await snapshotCheckoutState(database);
    // The largest physical lead time wins, counted from the local date.
    await expect(
      order(rejectedPo, '2026-11-09', [cell, tendonLine], 'Pacific/Kiritimati'),
    ).rejects.toMatchObject({
      status: 422,
      message:
        'Requested ship date must be on or after 2026-11-10 to cover the 60-day lead time.',
    });
    // Five years from the local date is the last allowed ship date.
    await expect(
      order(rejectedPo, '2031-09-12', [cell], 'Pacific/Kiritimati'),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Requested ship date must be on or before 2031-09-11.',
    });
    await expect(order(rejectedPo, '9999-12-31', [cell])).rejects.toMatchObject(
      {
        status: 422,
        message: 'Requested ship date must be on or before 2031-09-10.',
      },
    );
    expect(await snapshotCheckoutState(database)).toEqual(before);

    const accepted = [
      // Licenses have no lead time, so they can ship on the local date.
      ['MCS-TEST-SHIP-LICENSE', '2026-09-11', [licenseLine], 'confirmed'],
      ['MCS-TEST-SHIP-LEAD', '2026-11-10', [cell, tendonLine], 'confirmed'],
      // Up to 90 days after the local date stays confirmed; later is scheduled.
      ['MCS-TEST-SHIP-90', '2026-12-10', [cell], 'confirmed'],
      ['MCS-TEST-SHIP-91', '2026-12-11', [cell], 'scheduled'],
      ['MCS-TEST-SHIP-LAST', '2031-09-11', [cell], 'scheduled'],
    ] as const;
    for (const [
      customerPoNumber,
      requestedShipDate,
      items,
      status,
    ] of accepted) {
      await createCheckoutFixture(
        database,
        customerPoNumber,
        items.map((line) => line.itemNumber) as [string, ...string[]],
      );
      await order(
        customerPoNumber,
        requestedShipDate,
        [...items],
        'Pacific/Kiritimati',
      );
      expect(await statusOf(customerPoNumber), customerPoNumber).toBe(status);
    }
    // Without a time zone the UTC date applies: 2026-12-10 is 91 days out.
    await createCheckoutFixture(database, 'MCS-TEST-SHIP-UTC', ['SBL-RPC-12']);
    await order('MCS-TEST-SHIP-UTC', '2026-12-10', [cell]);
    expect(await statusOf('MCS-TEST-SHIP-UTC')).toBe('scheduled');

    // New scheduled orders appear under the Scheduled filter, not Active.
    const listed = async (status: 'active' | 'scheduled') =>
      (
        await getOrderHistory(database, user, {
          page: 1,
          status,
          query: 'MCS-TEST-SHIP-',
        })
      ).orders
        .map((row) => row.customerPoNumber)
        .toSorted();
    expect(await listed('scheduled')).toEqual([
      'MCS-TEST-SHIP-91',
      'MCS-TEST-SHIP-LAST',
      'MCS-TEST-SHIP-UTC',
    ]);
    expect(await listed('active')).toEqual([
      'MCS-TEST-SHIP-90',
      'MCS-TEST-SHIP-LEAD',
      'MCS-TEST-SHIP-LICENSE',
    ]);
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
          commandId: crypto.randomUUID(),
          expectedSubject: {
            userId: user.userId,
            customerId: user.distributorId,
          },
          customerPoNumber,
          // The earliest date the 18-day lead time allows.
          requestedShipDate: '2028-03-18',
          shippingRegion: 'Great Lakes District',
          items: [
            {
              itemNumber: 'SBL-RPC-12',
              quantity: 8,
              expectedUnitPriceCents: 68000,
            },
          ],
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
        requested_ship_date: '2028-03-18',
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
          commandId: crypto.randomUUID(),
          expectedSubject: {
            userId: user.userId,
            customerId: user.distributorId,
          },
          customerPoNumber,
          requestedShipDate: '2026-10-15',
          shippingRegion: 'Great Lakes District',
          items: [
            // A valid first line must not be reserved when a later line fails.
            {
              itemNumber: 'SBL-RPC-12',
              quantity: 16,
              expectedUnitPriceCents: 68000,
            },
            // Valid pack of 12, but 732 requested exceeds 720 available.
            {
              itemNumber: 'SBL-SWC-12',
              quantity: 732,
              expectedUnitPriceCents: 29000,
            },
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
                commandId: crypto.randomUUID(),
                expectedSubject: {
                  userId: user.userId,
                  customerId: user.distributorId,
                },
                customerPoNumber,
                requestedShipDate: '2026-10-15',
                shippingRegion: 'Great Lakes District',
                items: [
                  // Its reservation precedes the scarce item in the real batch.
                  {
                    itemNumber: 'SBL-SWC-12',
                    quantity: 12,
                    expectedUnitPriceCents: 29000,
                  },
                  {
                    itemNumber: 'SBL-RPC-12',
                    quantity: 8,
                    expectedUnitPriceCents: 68000,
                  },
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
