import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

const orderDetails = (customerPoNumber: string) => ({
  customerPoNumber,
  requestedShipDate: new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10),
  shippingRegion: 'Great Lakes District',
});

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

test('reduces a stale oversized cart one case at a time without rewriting the requested quantity', async ({
  page,
  request,
  app,
  loginPage,
  shopPage,
}) => {
  const itemNumber = 'SBL-RPC-12';
  const details = orderDetails('MCS-STALE-CART');
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await shopPage.addCase(itemNumber);
  const catalogQuantity = shopPage.quantity(itemNumber, 'catalog');
  await catalogQuantity.increase.click();
  await catalogQuantity.increase.click();
  await expect(catalogQuantity.value).toHaveText('24');

  // A separate customer's real order exhausts most of the disposable inventory.
  expect(
    (
      await request.post('/api/auth/login', {
        headers: { Origin: app.url },
        data: {
          email: 'mara.venn@calderpike.example',
          password: 'Sable-WHS-0427!',
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post('/api/orders', {
        headers: { Origin: app.url },
        data: {
          ...orderDetails('CPD-COMPETING-CART'),
          items: [{ itemNumber, quantity: 304 }],
        },
      })
    ).status(),
  ).toBe(201);

  await shopPage.openCart();
  await shopPage.fillOrder(details);
  await shopPage.chargeConsent.check();
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/catalog',
  );
  const conflict = await shopPage.placeOrder();
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toEqual({
    error: 'Redline Power Cell R12 has only 8 units available.',
  });
  await refreshed;
  await expect(shopPage.cartQuantity(itemNumber)).toHaveText('24');
  await shopPage.closeCart();
  await expect(shopPage.productCard(itemNumber)).toContainText('8 available');
  await expect(catalogQuantity.increase).toBeDisabled();
  await catalogQuantity.decrease.focus();
  await catalogQuantity.decrease.press('Enter');
  await expect(catalogQuantity.value).toHaveText('16');

  await shopPage.openCart();
  const cartQuantity = shopPage.quantity(itemNumber);
  await expect(cartQuantity.increase).toBeDisabled();
  await expect(cartQuantity.decrease).toHaveAccessibleName(
    'Remove 8 Redline Power Cell R12',
  );
  await cartQuantity.decrease.focus();
  await cartQuantity.decrease.press('Space');
  await expect(cartQuantity.value).toHaveText('8');
  await expect(cartQuantity.increase).toBeDisabled();
  // Decrement-to-zero still removes a line; adding one valid case restores it.
  await cartQuantity.decrease.click();
  await expect(shopPage.cartLine(itemNumber)).toHaveCount(0);
  await shopPage.closeCart();
  await shopPage.addCase(itemNumber);
  await shopPage.openCart();
  const response = await shopPage.placeOrder();
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    ...details,
    items: [{ itemNumber, quantity: 8 }],
  });
  const saved = await app.database
    .prepare(`SELECT o.customer_id, o.order_total_cents, i.item_number, i.ordered_quantity
    FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.customer_po_number = ?`)
    .bind(details.customerPoNumber)
    .all();
  expect(saved.results).toEqual([
    {
      customer_id: 'WHS-1098',
      order_total_cents: 544000,
      item_number: itemNumber,
      ordered_quantity: 8,
    },
  ]);
  expect(app.modelRequests).toEqual([]);
});

test('locks cart and form edits across closing and reopening pending checkout, then unlocks after rejection', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  const details = orderDetails('MCS-PENDING-CART');
  const products = [
    { itemNumber: 'SBL-RPC-12', name: 'Redline Power Cell R12', quantity: 8 },
    {
      itemNumber: 'SBL-SWC-12',
      name: 'Signal-Weave Active Cable, 12 m',
      quantity: 12,
    },
  ];
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  for (const product of products) {
    await shopPage.addCase(product.itemNumber);
    await expect(
      shopPage.quantity(product.itemNumber, 'catalog').decrease,
    ).toHaveAccessibleName(`Remove ${product.quantity} ${product.name}`);
    await expect(
      shopPage.quantity(product.itemNumber, 'catalog').increase,
    ).toHaveAccessibleName(`Add ${product.quantity} ${product.name}`);
  }
  await shopPage.openCart();
  await shopPage.fillOrder(details);
  await shopPage.chargeConsent.check();

  for (const outcome of ['rejected', 'accepted']) {
    const held = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    let submitted: unknown;
    await page.route('**/api/orders', async (route) => {
      submitted = route.request().postDataJSON();
      // Hold an actual accepted response after storage commits, or a rejection.
      const response = outcome === 'accepted' ? await route.fetch() : null;
      received.resolve();
      await held.promise;
      if (response) await route.fulfill({ response });
      else
        await route.fulfill({
          status: 409,
          json: { error: 'Checkout temporarily unavailable.' },
        });
    });
    try {
      await shopPage.submitOrder();
      await received.promise;
      const pendingProducts =
        outcome === 'accepted' ? products.slice(0, 1) : products;
      for (const product of pendingProducts) {
        const controls = shopPage.quantity(product.itemNumber);
        await expect(controls.decrease).toHaveAccessibleName(
          `Remove ${product.quantity} ${product.name}`,
        );
        await expect(controls.increase).toHaveAccessibleName(
          `Add ${product.quantity} ${product.name}`,
        );
        await expect(controls.decrease).toBeDisabled();
        await expect(controls.increase).toBeDisabled();
        await expect(
          shopPage.removeItemButton(product.itemNumber),
        ).toBeDisabled();
      }
      await expect(shopPage.orderFields).toHaveCount(3);
      for (const field of await shopPage.orderFields.all())
        await expect(field).toBeDisabled();
      await expect(shopPage.chargeConsent).toBeDisabled();
      await expect(shopPage.placeOrderButton).toBeDisabled();
      await shopPage.closeCart();
      for (const product of pendingProducts) {
        await expect(
          shopPage.quantity(product.itemNumber, 'catalog').decrease,
        ).toBeDisabled();
        await expect(
          shopPage.quantity(product.itemNumber, 'catalog').increase,
        ).toBeDisabled();
      }
      await expect(shopPage.addCaseButton('SBL-EID-R8')).toBeDisabled();
      await shopPage.openCart();
      for (const product of pendingProducts)
        await expect(shopPage.cartQuantity(product.itemNumber)).toHaveText(
          String(product.quantity),
        );
      expect(submitted).toEqual({
        ...details,
        items: expect.arrayContaining(
          pendingProducts.map(({ itemNumber, quantity }) => ({
            itemNumber,
            quantity,
          })),
        ),
      });
      expect((submitted as { items: unknown[] }).items).toHaveLength(
        pendingProducts.length,
      );
      for (const [index, value] of [
        details.customerPoNumber,
        details.requestedShipDate,
        details.shippingRegion,
      ].entries()) {
        await expect(shopPage.orderFields.nth(index)).toHaveValue(value);
      }
      const completed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/orders',
      );
      held.resolve();
      expect((await completed).status()).toBe(
        outcome === 'accepted' ? 201 : 409,
      );
      if (outcome === 'rejected') {
        await expect(shopPage.checkoutError).toHaveText(
          'Checkout temporarily unavailable.',
        );
        await expect(
          shopPage.quantity(products[0].itemNumber).decrease,
        ).toBeEnabled();
        for (const field of await shopPage.orderFields.all())
          await expect(field).toBeEnabled();
        await expect(shopPage.chargeConsent).toBeEnabled();
        // An intentional edit after rejection must be reflected in the retry.
        await shopPage.removeItem(products[1].itemNumber);
      } else {
        await expect(shopPage.confirmationHeading).toBeVisible();
        await expect(shopPage.cartLines).toHaveCount(0);
      }
    } finally {
      held.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  }
  const saved = await app.database
    .prepare(`SELECT i.item_number, i.ordered_quantity FROM order_items i
    JOIN orders o ON o.order_id = i.order_id WHERE o.customer_po_number = ?`)
    .bind(details.customerPoNumber)
    .all();
  expect(saved.results).toEqual([
    { item_number: 'SBL-RPC-12', ordered_quantity: 8 },
  ]);
  expect(app.modelRequests).toEqual([]);
});
