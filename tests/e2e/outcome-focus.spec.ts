import { expect, test } from './fixtures/app';

test.use({ modelResponses: [] });

for (const keyboard of [false, true]) {
  test(`focuses and associates a rejected login (${keyboard ? 'keyboard' : 'pointer'})`, async ({
    page,
    loginPage,
  }) => {
    await loginPage.goto();
    const email = page.getByLabel('Authorized email');
    const password = page.getByLabel('Access phrase');
    await email.fill('mara.venn@calderpike.example');
    await password.fill('Wrong-access-123!');
    const submit = page.getByRole('button', {
      name: 'Enter authorized channel',
    });
    await expect(submit).toBeEnabled();
    if (keyboard) await password.press('Enter');
    else await submit.click();
    const error = page.locator('.login-error');
    await expect(error).toContainText('credentials were not recognized');
    await expect(error).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(email).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await expect(email).toHaveAccessibleDescription(
      'The supplied access credentials were not recognized.',
    );
    await expect(password).toHaveAccessibleDescription(
      'The supplied access credentials were not recognized.',
    );
    await password.fill('Sable-WHS-0427!');
    await password.press('Enter');
    await page.waitForURL((url) => url.pathname === '/support');
  });
}

for (const height of [800, 568]) {
  test(`hands checkout focus to the receipt and empty queue at 320x${height}`, async ({
    page,
    loginPage,
    shopPage,
  }) => {
    await loginPage.goto('/shop');
    await loginPage.signIn(
      'imani.kade@meridiancivic.example',
      'Sable-WHS-1098!',
      '/shop',
    );
    await page.setViewportSize({ width: 320, height });
    await shopPage.addCase('SBL-RPC-12');
    await shopPage.openCart();
    await shopPage.fillOrder({
      customerPoNumber: 'MCS-FOCUS-RECEIPT',
      requestedShipDate: '2031-01-01',
      shippingRegion: 'Great Lakes District',
    });
    await shopPage.chargeConsent.check();
    await shopPage.placeOrderButton.focus();
    await shopPage.placeOrderButton.press('Enter');
    await expect(shopPage.confirmationHeading).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(shopPage.cartTrigger).toBeFocused();
    await shopPage.openCart();
    await expect(shopPage.confirmationHeading).toBeFocused();
    await page.keyboard.press('Tab');
    const history = shopPage.cart.getByRole('link', {
      name: 'View order history',
    });
    await expect(history).toBeFocused();
    await expect(history).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Tab');
    const another = shopPage.cart.getByRole('button', {
      name: 'Build another order',
    });
    await expect(another).toBeFocused();
    await expect(another).toBeInViewport({ ratio: 1 });
    await another.press('Enter');
    await expect(
      shopPage.cart.getByRole('heading', { name: 'Queue is empty.' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(shopPage.cart).not.toBeVisible();
    await expect(shopPage.cartTrigger).toBeFocused();
  });
}

test('scrolls receipt actions into a short viewport without moving the header or close button', async ({
  page,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  await shopPage.fillOrder({
    customerPoNumber: 'MCS-SCROLL-RECEIPT',
    requestedShipDate: '2031-01-01',
    shippingRegion: 'Great Lakes District',
  });
  await shopPage.chargeConsent.check();
  expect((await shopPage.placeOrder()).status()).toBe(201);
  await expect(shopPage.confirmationHeading).toBeVisible();
  const heading = shopPage.cart.getByRole('heading', {
    name: 'Procurement queue',
  });
  const originalTop = (await heading.boundingBox())!.y;
  await page.mouse.move(160, 480);
  await page.mouse.wheel(0, 1200);
  const another = shopPage.cart.getByRole('button', {
    name: 'Build another order',
  });
  await expect(another).toBeInViewport({ ratio: 1 });
  await expect(
    shopPage.cart.getByRole('link', { name: 'View order history' }),
  ).toBeInViewport({ ratio: 1 });
  await expect(heading).toBeInViewport({ ratio: 1 });
  expect((await heading.boundingBox())!.y).toBeCloseTo(originalTop, 1);
  await expect(
    shopPage.cart.getByRole('button', { name: 'Close', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await another.click();
  await expect(
    shopPage.cart.getByRole('button', { name: 'Return to catalog' }),
  ).toBeInViewport({ ratio: 1 });
});

test('keeps empty, populated, and error cart actions reachable in a short viewport', async ({
  page,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await shopPage.openCart();
  await expect(
    shopPage.cart.getByRole('heading', { name: 'Queue is empty.' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    shopPage.cart.getByRole('button', { name: 'Return to catalog' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(shopPage.cartTrigger).toBeFocused();
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  await shopPage.fillOrder({
    customerPoNumber: 'MCS-FOCUS-ERROR',
    requestedShipDate: '2031-01-01',
    shippingRegion: 'Great Lakes District',
  });
  await shopPage.chargeConsent.check();
  await page.route('**/api/orders', (route) => route.abort('failed'));
  await shopPage.submitOrder();
  await expect(shopPage.checkoutError).toBeVisible();
  const retry = shopPage.cart.getByRole('button', { name: 'Retry this order' });
  await retry.focus();
  await expect(retry).toBeInViewport({ ratio: 1 });
  await expect(
    shopPage.cart.getByRole('heading', { name: 'Procurement queue' }),
  ).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(shopPage.cartTrigger).toBeFocused();
});
