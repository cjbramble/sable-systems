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

test.beforeEach(async ({ loginPage, shopPage }) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await shopPage.addCase(cell);
  await shopPage.addCase(cable);
  await shopPage.openCart();
});

for (const retireAll of [false, true]) {
  test(`retains ${retireAll ? 'all retired cart lines' : 'one retired cart line'} until explicit removal`, async ({
    page,
    app,
    shopPage,
  }) => {
    const order = details(`MCS-CART-RETIRED-${retireAll ? 'ALL' : 'ONE'}`);
    await shopPage.fillOrder(order);
    await shopPage.chargeConsent.check();
    for (const itemNumber of retireAll ? [cell, cable] : [cell]) {
      await app.database
        .prepare(
          "UPDATE products SET active_to = '2026-10-01' WHERE item_number = ?",
        )
        .bind(itemNumber)
        .run();
    }
    const refreshed = page.waitForResponse('**/api/catalog');
    expect((await shopPage.placeOrder()).status()).toBe(422);
    await refreshed;
    await expect(shopPage.cartLines).toHaveCount(2);
    await expect(shopPage.cartLine(cell)).toContainText(
      'Redline Power Cell R12',
    );
    await expect(shopPage.cartLine(cell)).toContainText('8 units requested');
    await expect(shopPage.cartLine(cell)).toContainText(
      'No longer available. Remove this item to continue.',
    );
    await expect(shopPage.cartTotal).toHaveText('Unavailable');
    await expect(shopPage.placeOrderButton).toBeDisabled();
    await expect(shopPage.chargeConsent).not.toBeChecked();
    // Even a direct form submission cannot drop unresolved lines from intent.
    const requests: unknown[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/orders'
      )
        requests.push(request.postDataJSON());
    });
    await shopPage.cart
      .locator('form')
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(requests).toEqual([]);
    expect(
      (
        await app.database
          .prepare('SELECT order_id FROM orders WHERE customer_po_number = ?')
          .bind(order.customerPoNumber)
          .all()
      ).results,
    ).toEqual([]);
    await shopPage.closeCart();
    await expect(shopPage.cartTrigger).toHaveText('Cart 20');
    await shopPage.openCart();
    await shopPage.removeItem(cell);
    if (retireAll) {
      await expect(shopPage.cartLine(cable)).toContainText(
        '12 units requested',
      );
      await expect(shopPage.placeOrderButton).toBeDisabled();
      await shopPage.removeItem(cable);
      await expect(
        shopPage.cart.getByRole('heading', { name: 'Queue is empty.' }),
      ).toBeVisible();
      await shopPage.closeCart();
      await expect(shopPage.cartTrigger).toHaveText('Cart 0');
    } else {
      await expect(shopPage.cartLines).toHaveCount(1);
      await expect(shopPage.cartTotal).not.toHaveText('Unavailable');
      await shopPage.chargeConsent.check();
      const response = await shopPage.placeOrder();
      expect(response.status()).toBe(201);
      expect(response.request().postDataJSON().items).toEqual([
        { itemNumber: cable, quantity: 12, expectedUnitPriceCents: 29000 },
      ]);
      expect(
        (
          await app.database
            .prepare(
              'SELECT i.item_number, i.ordered_quantity FROM order_items i JOIN orders o USING(order_id) WHERE o.customer_po_number = ?',
            )
            .bind(order.customerPoNumber)
            .all()
        ).results,
      ).toEqual([{ item_number: cable, ordered_quantity: 12 }]);
    }
    expect(app.modelRequests).toEqual([]);
  });
}

test('a changed case pack preserves the selection and requires an explicit correction', async ({
  page,
  app,
  shopPage,
}) => {
  await shopPage.fillOrder(details('MCS-CART-PACK-CHANGE'));
  await shopPage.chargeConsent.check();
  await app.database
    .prepare('UPDATE products SET case_pack = 12 WHERE item_number = ?')
    .bind(cell)
    .run();
  const refreshed = page.waitForResponse('**/api/catalog');
  expect((await shopPage.placeOrder()).status()).toBe(422);
  await refreshed;
  await expect(shopPage.cartQuantity(cell)).toHaveText('8');
  await expect(shopPage.cartLine(cell)).toContainText(
    'Order in case packs of 12. Remove and add this item again.',
  );
  await expect(shopPage.placeOrderButton).toBeDisabled();
  await shopPage.removeItem(cell);
  await shopPage.closeCart();
  await expect(shopPage.cartTrigger).toHaveText('Cart 12');
  await shopPage.addCase(cell);
  await shopPage.openCart();
  await expect(shopPage.cartQuantity(cell)).toHaveText('12');
  await shopPage.chargeConsent.check();
  const response = await shopPage.placeOrder();
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().items).toEqual(
    expect.arrayContaining([
      { itemNumber: cell, quantity: 12, expectedUnitPriceCents: 68000 },
      { itemNumber: cable, quantity: 12, expectedUnitPriceCents: 29000 },
    ]),
  );
});
