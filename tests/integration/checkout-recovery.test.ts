import { describe, expect, vi } from 'vitest';

import { POST } from '@/app/api/orders/route';
import { placeChargeAccountOrder } from '@/db/shop';
import {
  checkoutCommand,
  createCheckoutFixture,
  snapshotCheckoutState,
} from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

const cell = 'SBL-RPC-12';
const cable = 'SBL-SWC-12';

describe('durable checkout recovery', () => {
  test('a definite retry rejection prevents an earlier delayed attempt from committing later', async ({
    database,
    onTestFinished,
  }) => {
    const input = checkoutCommand('RECOVER-DELAYED-COMMIT');
    await createCheckoutFixture(database, input.customerPoNumber, [cell]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    onTestFinished(async () => {
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = 68000 WHERE item_number = ?',
        )
        .bind(cell)
        .run();
    });
    const before = await snapshotCheckoutState(database);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalBatch = database.batch.bind(database);
    const batch = vi
      .spyOn(database, 'batch')
      .mockImplementationOnce(async <T>(statements: D1PreparedStatement[]) => {
        reached.resolve();
        await release.promise;
        return originalBatch<T>(statements);
      });
    const first = placeChargeAccountOrder(database, input, user);
    const outcome = first.then(
      (receipt) => ({ receipt }),
      (error: unknown) => ({ error }),
    );
    try {
      await reached.promise;
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = 70000 WHERE item_number = ?',
        )
        .bind(cell)
        .run();
      await expect(
        placeChargeAccountOrder(database, input, user),
      ).rejects.toMatchObject({ status: 409, code: 'price_changed' });
      release.resolve();
      expect(await outcome).toMatchObject({
        error: { status: 409, code: 'price_changed' },
      });
      expect(await snapshotCheckoutState(database)).toEqual(before);
    } finally {
      release.resolve();
      await outcome;
      batch.mockRestore();
    }
  });

  test('recovers the original receipt before current stock, date, price, or eligibility checks', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const input = checkoutCommand('RECOVER-ORIGINAL', {
      items: [
        { itemNumber: cell, quantity: 312, expectedUnitPriceCents: 68000 },
      ],
    });
    await createCheckoutFixture(database, input.customerPoNumber, [cell]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const original = await placeChargeAccountOrder(database, input, user);
    expect(original).toMatchObject({
      commandId: input.commandId,
      currency: 'USD',
      totalCents: 21216000,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2032-01-01T00:00:00Z'));
    onTestFinished(async () => {
      vi.useRealTimers();
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = 68000, active_to = NULL WHERE item_number = ?',
        )
        .bind(cell)
        .run();
    });
    await database
      .prepare(
        "UPDATE products SET unit_price_cents = 70000, active_to = '2031-12-31' WHERE item_number = ?",
      )
      .bind(cell)
      .run();
    // The receipt is the original confirmation, even if fulfillment reschedules the order.
    await database
      .prepare(
        "UPDATE orders SET requested_ship_date = '2032-02-01' WHERE order_id = ?",
      )
      .bind(original.orderId)
      .run();
    const before = await snapshotCheckoutState(database);
    const session = await supportApi.session(user);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: session.request({}).headers,
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(original);
    expect(await snapshotCheckoutState(database)).toEqual(before);
  });

  test('normalizes equivalent intent but rejects changes and another owner without exposing a receipt', async ({
    database,
    supportApi,
  }) => {
    const input = checkoutCommand('RECOVER-NORMALIZED', {
      items: [
        { itemNumber: cell, quantity: 8, expectedUnitPriceCents: 68000 },
        { itemNumber: cable, quantity: 12, expectedUnitPriceCents: 29000 },
      ],
    });
    await createCheckoutFixture(database, input.customerPoNumber, [
      cell,
      cable,
    ]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const receipt = await placeChargeAccountOrder(database, input, user);
    const before = await snapshotCheckoutState(database);
    expect(
      await placeChargeAccountOrder(
        database,
        {
          ...input,
          customerPoNumber: ' recover-normalized ',
          shippingRegion: ' Great Lakes District ',
          requestedShipDate: ' 2031-01-01 ',
          items: input.items.toReversed(),
          totalCents: 1,
        },
        user,
      ),
    ).toEqual(receipt);
    for (const changes of [
      { customerPoNumber: 'RECOVER-OTHER-PO' },
      { shippingRegion: 'Other district' },
      { requestedShipDate: '2031-01-02' },
      { items: [{ ...input.items[0], quantity: 16 }, input.items[1]] },
      {
        items: [
          { ...input.items[0], expectedUnitPriceCents: 70000 },
          input.items[1],
        ],
      },
      { items: [input.items[0]] },
    ]) {
      await expect(
        placeChargeAccountOrder(database, { ...input, ...changes }, user),
      ).rejects.toMatchObject({ status: 409, code: 'command_conflict' });
    }
    const other = await loadActiveUserFixture(database, 'USR-CPD-001');
    const otherSession = await supportApi.session(other);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: otherSession.request({}).headers,
        body: JSON.stringify({
          ...input,
          expectedSubject: {
            userId: other.userId,
            customerId: other.distributorId,
          },
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        'These checkout details conflict with an earlier submission. Check order history before starting another order.',
      code: 'command_conflict',
    });
    await expect(
      placeChargeAccountOrder(
        database,
        { ...input, commandId: crypto.randomUUID() },
        user,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: 'That purchase-order reference is already in use.',
    });
    expect(await snapshotCheckoutState(database)).toEqual(before);
  });

  for (const changed of [false, true]) {
    test(`concurrent ${changed ? 'changed' : 'identical'} commands commit once`, async ({
      database,
    }) => {
      const input = checkoutCommand(
        `RECOVER-RACE-${changed ? 'CHANGED' : 'SAME'}`,
      );
      const { stockTotals } = await createCheckoutFixture(
        database,
        input.customerPoNumber,
        [cell],
      );
      const otherPo = `${input.customerPoNumber}-B`;
      if (changed) await createCheckoutFixture(database, otherPo, [cell]);
      const user = await loadActiveUserFixture(database, 'USR-MCS-001');
      await database
        .prepare(
          `UPDATE inventory_balances SET reserved_quantity = on_hand_quantity - quarantined_quantity - CASE WHEN location_id = 'ATL-01' THEN ? ELSE 0 END WHERE item_number = ?`,
        )
        .bind(changed ? 16 : 8, cell)
        .run();
      const before = await snapshotCheckoutState(database);
      const gate = Promise.withResolvers<void>();
      const originalBatch = database.batch.bind(database);
      let arrivals = 0;
      const batch = vi
        .spyOn(database, 'batch')
        .mockImplementation(async <T>(statements: D1PreparedStatement[]) => {
          if (++arrivals === 2) gate.resolve();
          await gate.promise;
          return originalBatch<T>(statements);
        });
      const timeout = setTimeout(() => gate.resolve(), 2000);
      let results: PromiseSettledResult<
        Awaited<ReturnType<typeof placeChargeAccountOrder>>
      >[];
      try {
        results = await Promise.allSettled([
          placeChargeAccountOrder(database, input, user),
          placeChargeAccountOrder(
            database,
            {
              ...input,
              customerPoNumber: changed ? otherPo : input.customerPoNumber,
            },
            user,
          ),
        ]);
        expect(arrivals).toBe(2);
      } finally {
        gate.resolve();
        clearTimeout(timeout);
        batch.mockRestore();
      }
      const successes = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const failures = results.filter((result) => result.status === 'rejected');
      expect(successes).toHaveLength(changed ? 1 : 2);
      if (changed)
        expect(failures[0].reason).toMatchObject({
          status: 409,
          code: 'command_conflict',
        });
      else expect(successes[0].value).toEqual(successes[1].value);
      const after = await snapshotCheckoutState(database);
      for (const table of ['orders', 'lines', 'charges', 'events'] as const)
        expect(after[table]).toHaveLength(before[table].length + 1);
      expect((await stockTotals()).results).toEqual([
        {
          item_number: cell,
          on_hand: 376,
          reserved: changed ? 368 : 376,
          available: changed ? 8 : 0,
        },
      ]);
      expect(
        (
          await database
            .prepare('SELECT * FROM checkout_commands WHERE command_id = ?')
            .bind(input.commandId)
            .all()
        ).results,
      ).toHaveLength(1);
    });
  }

  for (const committed of [false, true]) {
    test(`recovers when the database reply is lost ${committed ? 'after' : 'before'} commit`, async ({
      database,
    }) => {
      const input = checkoutCommand(
        `RECOVER-LOSS-${committed ? 'AFTER' : 'BEFORE'}`,
      );
      await createCheckoutFixture(database, input.customerPoNumber, [cell]);
      const user = await loadActiveUserFixture(database, 'USR-MCS-001');
      const before = await snapshotCheckoutState(database);
      const originalBatch = database.batch.bind(database);
      const batch = vi
        .spyOn(database, 'batch')
        .mockImplementationOnce(async (statements) => {
          if (committed) await originalBatch(statements);
          throw new Error('Database reply lost.');
        });
      let first;
      try {
        if (committed)
          first = await placeChargeAccountOrder(database, input, user);
        else {
          await expect(
            placeChargeAccountOrder(database, input, user),
          ).rejects.toThrow('Database reply lost.');
          expect(await snapshotCheckoutState(database)).toEqual(before);
        }
      } finally {
        batch.mockRestore();
      }
      const receipt = await placeChargeAccountOrder(database, input, user);
      if (committed) expect(receipt).toEqual(first);
      const after = await snapshotCheckoutState(database);
      for (const table of ['orders', 'lines', 'charges', 'events'] as const)
        expect(after[table]).toHaveLength(before[table].length + 1);
    });
  }

  test('validates every reusable service call before writing', async ({
    database,
  }) => {
    const input = checkoutCommand('RECOVER-INVALID');
    await createCheckoutFixture(database, input.customerPoNumber, [cell]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const before = await snapshotCheckoutState(database);
    for (const invalid of [
      null,
      {},
      { ...input, commandId: '' },
      { ...input, items: [] },
      { ...input, customerPoNumber: '?' },
      { ...input, items: [input.items[0], input.items[0]] },
      { ...input, items: [{ ...input.items[0], quantity: -8 }] },
    ]) {
      await expect(
        placeChargeAccountOrder(database, invalid, user),
      ).rejects.toMatchObject({ status: 400 });
      expect(await snapshotCheckoutState(database)).toEqual(before);
    }
  });

  test('does not misclassify unrelated CHECK or UNIQUE failures as customer corrections', async ({
    database,
    supportApi,
  }) => {
    const input = checkoutCommand('RECOVER-UNEXPECTED');
    await createCheckoutFixture(database, input.customerPoNumber, [cell]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const session = await supportApi.session(user);
    const before = await snapshotCheckoutState(database);
    for (const message of [
      'CHECK constraint failed: amount_cents >= 0',
      'UNIQUE constraint failed: unrelated.value',
    ]) {
      const batch = vi
        .spyOn(database, 'batch')
        .mockRejectedValueOnce(new Error(message));
      try {
        const response = await POST(
          new Request('http://localhost/api/orders', {
            method: 'POST',
            headers: session.request({}).headers,
            body: JSON.stringify(input),
          }),
        );
        expect(response.status).toBe(500);
      } finally {
        batch.mockRestore();
      }
      expect(await snapshotCheckoutState(database)).toEqual(before);
    }
  });
});
