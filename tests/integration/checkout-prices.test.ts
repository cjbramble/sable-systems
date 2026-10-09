import { describe, expect } from 'vitest';

import { POST } from '@/app/api/orders/route';
import {
  createCheckoutFixture,
  snapshotCheckoutState,
} from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

const cell = 'SBL-RPC-12';
const cable = 'SBL-SWC-12';
const order = {
  expectedSubject: { userId: 'USR-MCS-001', customerId: 'WHS-1098' },
  requestedShipDate: '2031-01-01',
  shippingRegion: 'Great Lakes District',
};
const priceError = {
  code: 'price_changed',
  error: 'Prices changed. Review the updated order and authorize it again.',
};

describe('reviewed checkout prices', () => {
  for (const scenario of [
    { name: 'higher', actual: 70000, expected: 68000 },
    { name: 'lower', actual: 66000, expected: 68000 },
    { name: 'tampered', actual: 68000, expected: 1 },
    { name: 'missing', actual: 68000, expected: undefined },
  ]) {
    test(`rejects ${scenario.name} prices without business writes`, async ({
      database,
      supportApi,
      onTestFinished,
    }) => {
      const customerPoNumber = `PRICE-${scenario.name.toUpperCase()}`;
      await createCheckoutFixture(database, customerPoNumber, [cell]);
      onTestFinished(async () => {
        await database
          .prepare(
            'UPDATE products SET unit_price_cents = 68000 WHERE item_number = ?',
          )
          .bind(cell)
          .run();
      });
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = ? WHERE item_number = ?',
        )
        .bind(scenario.actual, cell)
        .run();
      const session = await supportApi.session(
        await loadActiveUserFixture(database, 'USR-MCS-001'),
      );
      const before = await snapshotCheckoutState(database);
      const response = await POST(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: session.request({}).headers,
          body: JSON.stringify({
            ...order,
            customerPoNumber,
            items: [
              {
                itemNumber: cell,
                quantity: 8,
                expectedUnitPriceCents: scenario.expected,
              },
            ],
          }),
        }),
      );
      expect(response.status).toBe(scenario.name === 'missing' ? 400 : 409);
      if (scenario.name !== 'missing')
        expect(await response.json()).toEqual(priceError);
      expect(await snapshotCheckoutState(database)).toEqual(before);
    });
  }

  test('rejects offsetting line changes even when the total is unchanged', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'PRICE-OFFSETTING';
    await createCheckoutFixture(database, customerPoNumber, [cell, cable]);
    onTestFinished(async () => {
      await database.batch([
        database
          .prepare(
            'UPDATE products SET unit_price_cents = 68000 WHERE item_number = ?',
          )
          .bind(cell),
        database
          .prepare(
            'UPDATE products SET unit_price_cents = 29000 WHERE item_number = ?',
          )
          .bind(cable),
      ]);
    });
    // +8 * 150 cents and -12 * 100 cents leave the total at 892000.
    await database.batch([
      database
        .prepare(
          'UPDATE products SET unit_price_cents = 68150 WHERE item_number = ?',
        )
        .bind(cell),
      database
        .prepare(
          'UPDATE products SET unit_price_cents = 28900 WHERE item_number = ?',
        )
        .bind(cable),
    ]);
    const session = await supportApi.session(
      await loadActiveUserFixture(database, 'USR-MCS-001'),
    );
    const before = await snapshotCheckoutState(database);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: session.request({}).headers,
        body: JSON.stringify({
          ...order,
          customerPoNumber,
          items: [
            { itemNumber: cable, quantity: 12, expectedUnitPriceCents: 29000 },
            { itemNumber: cell, quantity: 8, expectedUnitPriceCents: 68000 },
          ],
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(priceError);
    expect(await snapshotCheckoutState(database)).toEqual(before);
  });

  test('checks every retry and commits server prices only after expectations match', async ({
    database,
    supportApi,
    onTestFinished,
  }) => {
    const customerPoNumber = 'PRICE-RETRY';
    await createCheckoutFixture(database, customerPoNumber, [cell]);
    onTestFinished(async () => {
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = 68000 WHERE item_number = ?',
        )
        .bind(cell)
        .run();
    });
    const session = await supportApi.session(
      await loadActiveUserFixture(database, 'USR-MCS-001'),
    );
    const before = await snapshotCheckoutState(database);
    const submit = (expectedUnitPriceCents: number) =>
      POST(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: session.request({}).headers,
          body: JSON.stringify({
            ...order,
            customerPoNumber,
            // A caller-supplied total cannot set the charge, even with valid expectations.
            totalCents: 1,
            items: [{ itemNumber: cell, quantity: 8, expectedUnitPriceCents }],
          }),
        }),
      );
    for (const [actual, reviewed] of [
      [70000, 68000],
      [68001, 70000],
    ]) {
      await database
        .prepare(
          'UPDATE products SET unit_price_cents = ? WHERE item_number = ?',
        )
        .bind(actual, cell)
        .run();
      const response = await submit(reviewed);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(priceError);
      expect(await snapshotCheckoutState(database)).toEqual(before);
    }
    const accepted = await submit(68001);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ totalCents: 544008 });
    expect(
      (
        await database
          .prepare(`SELECT o.order_total_cents, i.unit_price_cents, c.amount_cents
      FROM orders o JOIN order_items i USING(order_id) JOIN account_charges c USING(order_id)
      WHERE o.customer_po_number = ?`)
          .bind(customerPoNumber)
          .all()
      ).results,
    ).toEqual([
      {
        order_total_cents: 544008,
        unit_price_cents: 68001,
        amount_cents: 544008,
      },
    ]);
  });
});
