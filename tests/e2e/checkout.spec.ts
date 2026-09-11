import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

test('removes a cart item, places a charge-account order, and finds it in persisted history', async ({
  app,
  loginPage,
  shopPage,
  ordersPage,
}) => {
  // Keep the real browser/worker clocks and choose a date safely in the future.
  const requestedShipDate = new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const details = {
    customerPoNumber: 'MCS-E2E-CHECKOUT',
    requestedShipDate,
    shippingRegion: 'Great Lakes District',
  };
  const retainedItem = 'SBL-RPC-12';
  const removedItem = 'SBL-SWC-12';

  await shopPage.goto();
  await expect(loginPage.heading).toBeVisible();
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await expect(shopPage.signedInUser).toHaveText(
    'Imani Kade // Meridian Civic Supply',
  );

  const readStock = async () => {
    const { results } = await app.database
      .prepare(`SELECT item_number, SUM(on_hand_quantity) AS on_hand,
        SUM(reserved_quantity) AS reserved,
        SUM(on_hand_quantity - reserved_quantity - quarantined_quantity) AS available
        FROM inventory_balances WHERE item_number IN (?, ?)
        GROUP BY item_number ORDER BY item_number`)
      .bind(retainedItem, removedItem)
      .all<{
        item_number: string;
        on_hand: number;
        reserved: number;
        available: number;
      }>();
    return results;
  };
  const stockBefore = await readStock();
  expect(stockBefore).toEqual([
    { item_number: retainedItem, on_hand: 376, reserved: 64, available: 312 },
    { item_number: removedItem, on_hand: 864, reserved: 144, available: 720 },
  ]);

  await shopPage.addCase(retainedItem);
  await shopPage.addCase(removedItem);
  await expect(shopPage.cartTrigger).toHaveText('Cart 20');
  await shopPage.openCart();
  await expect(shopPage.cartLines).toHaveCount(2);
  await expect(shopPage.cartQuantity(retainedItem)).toHaveText('8');
  await expect(shopPage.cartQuantity(removedItem)).toHaveText('12');
  // Independently authored totals: 8 x $680 + 12 x $290, then only 8 x $680.
  await expect(shopPage.cartTotal).toHaveText('$8,920');
  await shopPage.removeItem(removedItem);
  await expect(shopPage.cartLine(removedItem)).toHaveCount(0);
  await expect(shopPage.cartLines).toHaveCount(1);
  await expect(shopPage.cartTotal).toHaveText('$5,440');

  await shopPage.fillOrder(details);
  await expect(shopPage.placeOrderButton).toBeDisabled();
  await shopPage.chargeConsent.check();
  await expect(shopPage.placeOrderButton).toBeEnabled();
  const response = await shopPage.placeOrder();
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    ...details,
    items: [{ itemNumber: retainedItem, quantity: 8 }],
  });
  const receipt = await response.json();
  expect(receipt).toEqual({
    orderId: expect.stringMatching(/^SBL-\d{4}-\d{6}$/),
    chargeId: expect.stringMatching(/^CHG-/),
    authorizationCode: expect.stringMatching(/^ACC-/),
    totalCents: 544_000,
    requestedShipDate,
  });
  await expect(shopPage.confirmationHeading).toBeVisible();
  await expect(shopPage.confirmationValue('Order')).toHaveText(receipt.orderId);
  await expect(shopPage.confirmationValue('Authorization')).toHaveText(
    receipt.authorizationCode,
  );
  await expect(shopPage.confirmationValue('Order total')).toHaveText('$5,440');
  await expect(shopPage.confirmationValue('Requested ship')).toHaveText(
    requestedShipDate,
  );
  await expect(shopPage.cartLines).toHaveCount(0);

  // Read durable rows independently of the response and history presentation.
  const saved = await app.database
    .prepare(`SELECT o.order_id, o.customer_id, o.placed_by_user_id,
      o.customer_po_number, o.requested_ship_date, o.shipping_region,
      o.order_total_cents, c.charge_method, c.status AS charge_status,
      c.amount_cents, c.authorization_code
      FROM orders o LEFT JOIN account_charges c ON c.order_id = o.order_id
      WHERE o.customer_po_number = ?`)
    .bind(details.customerPoNumber)
    .all();
  expect(saved.results).toEqual([
    {
      order_id: receipt.orderId,
      customer_id: 'WHS-1098',
      placed_by_user_id: 'USR-MCS-001',
      customer_po_number: details.customerPoNumber,
      requested_ship_date: requestedShipDate,
      shipping_region: details.shippingRegion,
      order_total_cents: 544_000,
      charge_method: 'charge_account',
      charge_status: 'authorized',
      amount_cents: 544_000,
      authorization_code: receipt.authorizationCode,
    },
  ]);
  expect(await readStock()).toEqual(
    stockBefore.map((row) =>
      row.item_number === retainedItem
        ? { ...row, reserved: row.reserved + 8, available: row.available - 8 }
        : row,
    ),
  );

  await shopPage.openOrderHistory();
  await expect(ordersPage.heading).toBeVisible();
  await expect(ordersPage.signedInUser).toHaveText(
    'Imani Kade // Meridian Civic Supply',
  );
  const search = await ordersPage.search(details.customerPoNumber);
  expect(search.status()).toBe(200);
  await expect(ordersPage.orderRows).toHaveCount(1);
  // Check the displayed order identity, ownership, quantities, and total.
  await expect(ordersPage.orderCells(receipt.orderId)).toContainText([
    receipt.orderId,
    'confirmed',
    'Imani Kade',
    '1 line',
    '$5,440',
  ]);
  await expect(ordersPage.orderCells(receipt.orderId)).toContainText([
    `PO ${details.customerPoNumber}`,
    'USR-MCS-001',
    '8 units',
  ]);

  await ordersPage.reload();
  expect((await ordersPage.search(details.customerPoNumber)).status()).toBe(
    200,
  );
  await expect(ordersPage.orderRows).toHaveCount(1);
  await expect(ordersPage.orderCells(receipt.orderId)).toContainText([
    receipt.orderId,
    'Imani Kade',
    '8 units',
    '$5,440',
  ]);
  expect(app.modelRequests).toEqual([]);
});
