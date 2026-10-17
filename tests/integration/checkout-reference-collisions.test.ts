import { describe, expect, vi } from 'vitest';

import { CheckoutError, placeChargeAccountOrder } from '@/db/shop';
import { checkoutCommand, createCheckoutFixture } from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

// Order IDs come from one random value each, so repeating a value forces the
// same ID. 199_990 maps to the unused SBL-YYYY-999990 range.
function pinOrderNumbers(values: number[]) {
  const sequence = values.slice();
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint32Array) || array.length !== 1)
      throw new Error('Unexpected random request during checkout');
    const next = sequence.shift();
    if (next === undefined) throw new Error('Order number sequence exhausted');
    array[0] = next;
    return array;
  });
}

describe('checkout order reference collisions', () => {
  test('retries a colliding order ID and commits the order once', async ({
    database,
    onTestFinished,
  }) => {
    const first = await createCheckoutFixture(database, 'MCS-TEST-COLLIDE-A', [
      'SBL-RPC-12',
    ]);
    const second = await createCheckoutFixture(database, 'MCS-TEST-COLLIDE-B', [
      'SBL-RPC-12',
    ]);
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const random = pinOrderNumbers([199_990, 199_990, 199_991]);
    onTestFinished(() => {
      random.mockRestore();
    });

    const original = await placeChargeAccountOrder(
      database,
      checkoutCommand('MCS-TEST-COLLIDE-A'),
      user,
    );
    const retried = await placeChargeAccountOrder(
      database,
      checkoutCommand('MCS-TEST-COLLIDE-B'),
      user,
    );

    expect(original.orderId).toMatch(/^SBL-\d{4}-999990$/);
    expect(retried.orderId).toMatch(/^SBL-\d{4}-999991$/);
    expect(random).toHaveBeenCalledTimes(3);
    expect((await first.ordersForPO()).results).toHaveLength(1);
    const [order] = (await second.ordersForPO()).results;
    expect(order).toMatchObject({ order_id: retried.orderId });
    const charges = await database
      .prepare('SELECT charge_id FROM account_charges WHERE order_id = ?')
      .bind(retried.orderId)
      .all();
    expect(charges.results).toEqual([{ charge_id: retried.chargeId }]);
    // Both orders reserve eight units once each; a doubled retry would show 24.
    const reserved = (rows: { reserved_quantity: number }[]) =>
      rows.reduce((total, row) => total + row.reserved_quantity, 0);
    expect(
      reserved((await second.inventory()).results) -
        reserved(second.beforeInventory),
    ).toBe(16);
  });

  test('asks for a new submission after repeated collisions without writing', async ({
    database,
    onTestFinished,
  }) => {
    await createCheckoutFixture(database, 'MCS-TEST-COLLIDE-C', ['SBL-RPC-12']);
    const blocked = await createCheckoutFixture(
      database,
      'MCS-TEST-COLLIDE-D',
      ['SBL-RPC-12'],
    );
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const random = pinOrderNumbers(Array(4).fill(199_992));
    onTestFinished(() => {
      random.mockRestore();
    });
    await placeChargeAccountOrder(
      database,
      checkoutCommand('MCS-TEST-COLLIDE-C'),
      user,
    );
    const afterFirst = (await blocked.inventory()).results;
    const command = checkoutCommand('MCS-TEST-COLLIDE-D');

    const attempt = placeChargeAccountOrder(database, command, user);

    await expect(attempt).rejects.toBeInstanceOf(CheckoutError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      message: 'An order reference conflict occurred. Submit the order again.',
    });
    expect(random).toHaveBeenCalledTimes(4);
    expect((await blocked.ordersForPO()).results).toEqual([]);
    expect((await blocked.inventory()).results).toEqual(afterFirst);
  });
});
