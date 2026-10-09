import { expect, test } from './fixtures/app';

test.use({ modelResponses: [] });
const cell = 'SBL-RPC-12';
const cable = 'SBL-SWC-12';
const details = (customerPoNumber: string) => ({
  customerPoNumber,
  requestedShipDate: new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .slice(0, 10),
  shippingRegion: 'Great Lakes District',
});

test('preserves cents from catalog through cart, charge, receipt and order history', async ({
  app,
  loginPage,
  shopPage,
  ordersPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await app.database
    .prepare(
      'UPDATE products SET unit_price_cents = 68001 WHERE item_number = ?',
    )
    .bind(cell)
    .run();
  await shopPage.goto();
  await expect(shopPage.productCard(cell)).toContainText('$680.01');
  await shopPage.addCase(cell);
  await shopPage.openCart();
  await expect(shopPage.cartLine(cell)).toContainText('$5,440.08');
  await expect(shopPage.cartTotal).toHaveText('$5,440.08');
  await shopPage.fillOrder(details('MCS-PRICE-CENTS'));
  await shopPage.chargeConsent.check();
  const response = await shopPage.placeOrder();
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().items).toEqual([
    { itemNumber: cell, quantity: 8, expectedUnitPriceCents: 68001 },
  ]);
  const receipt = await response.json();
  expect(receipt.totalCents).toBe(544008);
  await expect(shopPage.confirmationValue('Order total')).toHaveText(
    '$5,440.08',
  );
  expect(
    await app.database
      .prepare('SELECT amount_cents FROM account_charges WHERE order_id = ?')
      .bind(receipt.orderId)
      .first('amount_cents'),
  ).toBe(544008);
  await shopPage.openOrderHistory();
  await ordersPage.search('MCS-PRICE-CENTS');
  await expect(ordersPage.orderCells(receipt.orderId).last()).toHaveText(
    '$5,440.08',
  );
  expect(app.modelRequests).toEqual([]);
});

for (const [direction, price, total] of [
  ['higher', 70001, '$5,600.08'],
  ['lower', 66001, '$5,280.08'],
] as const) {
  test(`requires renewed consent after a ${direction} price change`, async ({
    page,
    app,
    loginPage,
    shopPage,
  }) => {
    await loginPage.goto('/shop');
    await loginPage.signIn(
      'imani.kade@meridiancivic.example',
      'Sable-WHS-1098!',
      '/shop',
    );
    await shopPage.addCase(cell);
    await shopPage.openCart();
    const order = details(`MCS-PRICE-${direction.toUpperCase()}`);
    await shopPage.fillOrder(order);
    await shopPage.chargeConsent.check();
    await app.database
      .prepare('UPDATE products SET unit_price_cents = ? WHERE item_number = ?')
      .bind(price, cell)
      .run();
    const refreshed = page.waitForResponse('**/api/catalog');
    const conflict = await shopPage.placeOrder();
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).code).toBe('price_changed');
    await refreshed;
    await expect(shopPage.cartTotal).toHaveText(total);
    await expect(shopPage.cartQuantity(cell)).toHaveText('8');
    await expect(
      shopPage.cart.getByLabel('Purchase-order reference'),
    ).toHaveValue(order.customerPoNumber);
    await expect(shopPage.chargeConsent).not.toBeChecked();
    await expect(shopPage.placeOrderButton).toBeDisabled();
    expect(
      (
        await app.database
          .prepare('SELECT order_id FROM orders WHERE customer_po_number = ?')
          .bind(order.customerPoNumber)
          .all()
      ).results,
    ).toEqual([]);
    await shopPage.chargeConsent.check();
    const accepted = await shopPage.placeOrder();
    expect(accepted.status()).toBe(201);
    expect(accepted.request().postDataJSON().commandId).not.toBe(
      conflict.request().postDataJSON().commandId,
    );
    expect(accepted.request().postDataJSON().items).toEqual([
      { itemNumber: cell, quantity: 8, expectedUnitPriceCents: price },
    ]);
    await expect(shopPage.confirmationValue('Order total')).toHaveText(total);
    expect(app.modelRequests).toEqual([]);
  });
}

test('clears stale consent even when the price refresh fails', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await shopPage.addCase(cell);
  await shopPage.openCart();
  await shopPage.fillOrder(details('MCS-PRICE-REFRESH-FAIL'));
  await shopPage.chargeConsent.check();
  await app.database
    .prepare(
      'UPDATE products SET unit_price_cents = 70000 WHERE item_number = ?',
    )
    .bind(cell)
    .run();
  await page.route('**/api/catalog', (route) =>
    route.fulfill({ status: 503, json: { error: 'Catalog unavailable.' } }),
  );
  const refreshed = page.waitForResponse('**/api/catalog');
  expect((await shopPage.placeOrder()).status()).toBe(409);
  expect((await refreshed).status()).toBe(503);
  await expect(shopPage.checkoutError).toContainText('Prices changed');
  await expect(shopPage.chargeConsent).not.toBeChecked();
  await expect(shopPage.placeOrderButton).toBeDisabled();
  await shopPage.closeCart();
  await page.unroute('**/api/catalog');
  await shopPage.retryCatalog();
  await shopPage.openCart();
  await expect(shopPage.cartTotal).toHaveText('$5,600.00');
  await expect(shopPage.chargeConsent).not.toBeChecked();
});

test('cart and order-detail edits invalidate the previous authorization', async ({
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await shopPage.addCase(cell);
  await shopPage.openCart();
  await shopPage.fillOrder(details('MCS-PRICE-EDITS'));
  const assertConsentCleared = async () => {
    await expect(shopPage.chargeConsent).not.toBeChecked();
    await expect(shopPage.placeOrderButton).toBeDisabled();
  };
  for (const control of [
    shopPage.quantity(cell).increase,
    shopPage.quantity(cell).decrease,
  ]) {
    await shopPage.chargeConsent.check();
    await control.click();
    await assertConsentCleared();
  }
  await shopPage.chargeConsent.check();
  await shopPage.closeCart();
  await shopPage.addCase(cable);
  await shopPage.openCart();
  await assertConsentCleared();
  await shopPage.chargeConsent.check();
  await shopPage.removeItem(cable);
  await assertConsentCleared();
  for (const [label, value] of [
    ['Purchase-order reference', 'MCS-PRICE-EDITED'],
    ['Requested ship date', '2031-01-01'],
    ['Destination region', 'Eastern District'],
  ]) {
    await shopPage.chargeConsent.check();
    await shopPage.cart.getByLabel(label).fill(value);
    await assertConsentCleared();
  }
});
