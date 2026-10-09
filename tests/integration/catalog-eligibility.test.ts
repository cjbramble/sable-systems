import { expect } from 'vitest';
import { POST } from '@/app/api/orders/route';
import { getCatalog } from '@/db/shop';
import { test } from '../fixtures/support-integration';
import { snapshotCheckoutState } from '../fixtures/checkout';
import { calderPikeUser } from '../fixtures/users';

test('catalog eligibility is distinct from stock and preserves the existing activity-date policy', async ({
  database,
  onTestFinished,
}) => {
  const itemNumber = 'SBL-RPC-12';
  const original = await database
    .prepare(
      'SELECT active_from, active_to FROM products WHERE item_number = ?',
    )
    .bind(itemNumber)
    .first<{ active_from: string; active_to: string | null }>();
  onTestFinished(async () => {
    await database
      .prepare(
        'UPDATE products SET active_from = ?, active_to = ? WHERE item_number = ?',
      )
      .bind(original!.active_from, original!.active_to, itemNumber)
      .run();
  });
  const initial = await getCatalog(database);
  expect(initial.some((product) => product.availableQuantity === 0)).toBe(true);
  expect(
    initial.find((product) => product.itemNumber === 'SBL-PAL-1Y'),
  ).toMatchObject({ fulfillmentType: 'license', availableQuantity: null });
  expect(initial.some((product) => product.itemNumber === 'SBL-GLV-V5')).toBe(
    false,
  );
  await database
    .prepare(
      "UPDATE products SET active_from = '2099-01-01' WHERE item_number = ?",
    )
    .bind(itemNumber)
    .run();
  expect(
    (await getCatalog(database)).some(
      (product) => product.itemNumber === itemNumber,
    ),
  ).toBe(true);
  await database
    .prepare(
      "UPDATE products SET active_to = '2099-12-31' WHERE item_number = ?",
    )
    .bind(itemNumber)
    .run();
  expect(
    (await getCatalog(database)).some(
      (product) => product.itemNumber === itemNumber,
    ),
  ).toBe(false);
});

test('checkout rejects a retired product even with available physical stock', async ({
  database,
  supportApi,
}) => {
  const itemNumber = 'SBL-GLV-V5';
  expect(
    await database
      .prepare(
        'SELECT SUM(on_hand_quantity - reserved_quantity - quarantined_quantity) AS available FROM inventory_balances WHERE item_number = ?',
      )
      .bind(itemNumber)
      .first(),
  ).toEqual({ available: 8 });
  const session = await supportApi.session(calderPikeUser);
  const before = await snapshotCheckoutState(database);
  const response = await POST(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: session.request({}).headers,
      body: JSON.stringify({
        expectedSubject: {
          userId: calderPikeUser.userId,
          customerId: calderPikeUser.distributorId,
        },
        customerPoNumber: 'CPD-RETIRED-REJECT',
        requestedShipDate: '2099-01-01',
        shippingRegion: calderPikeUser.region,
        items: [{ itemNumber, quantity: 8 }],
      }),
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    error: `Item ${itemNumber} is not orderable.`,
  });
  expect(await snapshotCheckoutState(database)).toEqual(before);
});
