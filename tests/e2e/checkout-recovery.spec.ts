import { expect, test } from './fixtures/app';

test.use({ modelResponses: [] });
const itemNumber = 'SBL-RPC-12';

for (const lostResponse of [false, true]) {
  test(`accepts lowercase account currency ${lostResponse ? 'after a lost response' : 'on first submission'}`, async ({
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
    await app.database
      .prepare(
        "UPDATE distributors SET currency = 'usd' WHERE customer_id = 'WHS-1098'",
      )
      .run();
    await shopPage.addCase(itemNumber);
    await shopPage.openCart();
    const customerPoNumber = 'MCS-LOWERCASE-CURRENCY';
    await shopPage.fillOrder({
      customerPoNumber,
      requestedShipDate: '2031-01-01',
      shippingRegion: 'Great Lakes District',
    });
    await shopPage.chargeConsent.check();
    if (lostResponse) {
      await page.route(
        '**/api/orders',
        async (route) => {
          expect((await route.fetch()).status()).toBe(201);
          await route.abort('failed');
        },
        { times: 1 },
      );
    }
    await shopPage.submitOrder();
    if (lostResponse) {
      await expect(shopPage.checkoutError).toContainText(
        'could not be verified',
      );
      await shopPage.cart
        .getByRole('button', { name: 'Retry this order', exact: true })
        .click();
    }
    await expect(shopPage.confirmationHeading).toBeVisible();
    await expect(shopPage.confirmationValue('Order total')).toHaveText(
      '$5,440.00',
    );
    await expect(shopPage.cartLines).toHaveCount(0);
    expect(
      (
        await app.database
          .prepare(`SELECT o.currency, c.amount_cents, c.currency AS charge_currency
        FROM orders o JOIN account_charges c USING(order_id)
        WHERE o.customer_po_number = ?`)
          .bind(customerPoNumber)
          .all()
      ).results,
    ).toEqual([
      { currency: 'usd', amount_cents: 544000, charge_currency: 'usd' },
    ]);
  });
}

test('an account switch cannot recover another account’s uncertain checkout', async ({
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
  await shopPage.addCase(itemNumber);
  await shopPage.openCart();
  await shopPage.fillOrder({
    customerPoNumber: 'MCS-RECOVER-ACCOUNT',
    requestedShipDate: '2031-01-01',
    shippingRegion: 'Great Lakes District',
  });
  await shopPage.chargeConsent.check();
  await page.route('**/api/orders', async (route) => {
    expect((await route.fetch()).status()).toBe(201);
    await route.abort('failed');
  });
  await shopPage.submitOrder();
  await expect(shopPage.checkoutError).toContainText('could not be verified');
  await page.unroute('**/api/orders');
  const original = await (await page.request.get('/api/auth/session')).json();
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: original }),
  );
  expect(
    (
      await page.request.post('/api/auth/login', {
        headers: { Origin: app.url },
        data: {
          email: 'mara.venn@calderpike.example',
          password: 'Sable-WHS-0427!',
        },
      })
    ).status(),
  ).toBe(200);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        response.request().method() === 'POST',
    ),
    shopPage.cart
      .getByRole('button', { name: 'Retry this order', exact: true })
      .click(),
  ]);
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'account_changed' });
  await expect(
    page.getByRole('heading', { name: 'Your account changed' }),
  ).toBeVisible();
  await expect(shopPage.confirmationHeading).toHaveCount(0);
  expect(
    (
      await app.database
        .prepare(
          "SELECT customer_id, placed_by_user_id FROM orders WHERE customer_po_number = 'MCS-RECOVER-ACCOUNT'",
        )
        .all()
    ).results,
  ).toEqual([{ customer_id: 'WHS-1098', placed_by_user_id: 'USR-MCS-001' }]);
});

for (const loss of ['before commit', 'after commit', 'malformed receipt']) {
  test(`recovers a checkout after ${loss} without another charge`, async ({
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
    await app.database
      .prepare(
        `UPDATE inventory_balances SET reserved_quantity = on_hand_quantity - quarantined_quantity - CASE WHEN location_id = 'ATL-01' THEN 8 ELSE 0 END WHERE item_number = ?`,
      )
      .bind(itemNumber)
      .run();
    await shopPage.goto();
    await shopPage.addCase(itemNumber);
    await shopPage.openCart();
    const details = {
      customerPoNumber: `MCS-RECOVER-${loss.split(' ')[0].toUpperCase()}`,
      requestedShipDate: new Date(Date.now() + 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      shippingRegion: 'Great Lakes District',
    };
    await shopPage.fillOrder(details);
    await shopPage.chargeConsent.check();
    let submitted: Record<string, unknown> | undefined;
    let originalReceipt: unknown;
    await page.route('**/api/orders', async (route) => {
      submitted = route.request().postDataJSON();
      if (loss !== 'before commit') {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        originalReceipt = await response.json();
        await app.database
          .prepare(
            "UPDATE products SET unit_price_cents = 70000, active_to = '2026-10-01' WHERE item_number = ?",
          )
          .bind(itemNumber)
          .run();
      }
      if (loss === 'malformed receipt')
        await route.fulfill({ status: 201, json: { totalCents: 544000 } });
      else await route.abort('failed');
    });
    await shopPage.submitOrder();
    await expect(shopPage.checkoutError).toContainText('could not be verified');
    await expect(shopPage.cartLines).toHaveCount(1);
    await expect(shopPage.cartQuantity(itemNumber)).toHaveText('8');
    await expect(shopPage.cartTotal).toHaveText('$5,440.00');
    for (const field of await shopPage.orderFields.all())
      await expect(field).toBeDisabled();
    await expect(shopPage.chargeConsent).toBeDisabled();
    await expect(shopPage.quantity(itemNumber).decrease).toBeDisabled();
    await expect(shopPage.removeItemButton(itemNumber)).toBeDisabled();
    await shopPage.closeCart();
    await expect(shopPage.addCaseButton('SBL-SWC-12')).toBeDisabled();
    await shopPage.openCart();
    await expect(
      shopPage.cart.getByLabel('Purchase-order reference'),
    ).toHaveValue(details.customerPoNumber);
    expect(submitted?.commandId).toEqual(expect.any(String));
    await page.unroute('**/api/orders');
    const [retried] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'POST',
      ),
      shopPage.cart
        .getByRole('button', { name: 'Retry this order', exact: true })
        .click(),
    ]);
    expect(retried.status()).toBe(201);
    expect(retried.request().postDataJSON()).toEqual(submitted);
    const receipt = await retried.json();
    if (loss !== 'before commit') expect(receipt).toEqual(originalReceipt);
    await expect(shopPage.confirmationHeading).toBeVisible();
    await expect(shopPage.confirmationValue('Order total')).toHaveText(
      '$5,440.00',
    );
    await expect(shopPage.cartLines).toHaveCount(0);
    expect(
      (
        await app.database
          .prepare(`SELECT o.order_id, c.amount_cents, i.ordered_quantity, k.command_id
      FROM orders o JOIN account_charges c USING(order_id) JOIN order_items i USING(order_id)
      JOIN checkout_commands k USING(order_id) WHERE o.customer_po_number = ?`)
          .bind(details.customerPoNumber)
          .all()
      ).results,
    ).toEqual([
      {
        order_id: receipt.orderId,
        amount_cents: 544000,
        ordered_quantity: 8,
        command_id: submitted!.commandId,
      },
    ]);
    expect(
      await app.database
        .prepare(
          'SELECT SUM(reserved_quantity) AS reserved FROM inventory_balances WHERE item_number = ?',
        )
        .bind(itemNumber)
        .first('reserved'),
    ).toBe(376);
    expect(app.modelRequests).toEqual([]);
  });
}
