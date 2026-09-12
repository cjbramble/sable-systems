import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

test('blocks procurement until failed account details are successfully retried', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  let requests = 0;
  const held = Promise.withResolvers<void>();
  await page.route('**/api/account', async (route) => {
    requests++;
    if (requests === 1)
      return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    await held.promise;
    await route.continue();
  });
  try {
    await loginPage.goto('/shop');
    await loginPage.signIn(
      'imani.kade@meridiancivic.example',
      'Sable-WHS-1098!',
      '/shop',
    );
    await expect(shopPage.loadingError).toContainText(
      'Account details could not be loaded.',
    );
    await expect(shopPage.cartTrigger).toHaveCount(0);
    await expect(shopPage.placeOrderButton).toHaveCount(0);
    await shopPage.retryAccount();
    await expect(shopPage.loadingError).toHaveCount(0);
    await expect(shopPage.cartTrigger).toHaveCount(0);
    held.resolve();
    await expect(shopPage.signedInUser).toHaveText(
      'Imani Kade // Meridian Civic Supply',
    );
    expect(requests).toBe(2);
    await shopPage.addCase('SBL-RPC-12');
    await shopPage.openCart();
    await expect(shopPage.shippingRegion).toHaveValue('Meridian Corridor');
    await expect(shopPage.accountTerms).toHaveText(
      'Account terms: Net 30 · USD billing ledger',
    );
    await expect(shopPage.chargeConsent).not.toBeChecked();
    await expect(shopPage.placeOrderButton).toBeDisabled();
    expect(app.modelRequests).toEqual([]);
  } finally {
    held.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('retries a catalog failure without losing the loaded account', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  let catalogRequests = 0;
  let accountRequests = 0;
  await page.route('**/api/account', (route) => {
    accountRequests++;
    return route.continue();
  });
  await page.route('**/api/catalog', (route) => {
    catalogRequests++;
    return catalogRequests === 1
      ? route.fulfill({
          status: 503,
          json: { error: 'Inventory temporarily unavailable.' },
        })
      : route.continue();
  });
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  await expect(shopPage.signedInUser).toHaveText(
    'Imani Kade // Meridian Civic Supply',
  );
  await expect(shopPage.loadingError).toContainText(
    'Inventory temporarily unavailable.',
  );
  await shopPage.retryCatalog();
  await expect(shopPage.loadingError).toHaveCount(0);
  await expect(shopPage.categoryTab('Power')).toBeVisible();
  expect(catalogRequests).toBe(2);
  expect(accountRequests).toBe(1);
  expect(app.modelRequests).toEqual([]);
});

for (const endpoint of ['account', 'incidents']) {
  test(`retries failed support ${endpoint} without presenting missing data as empty history`, async ({
    page,
    app,
    loginPage,
    supportPage,
  }) => {
    let requests = 0;
    await page.route(`**/api/${endpoint}`, (route) => {
      requests++;
      return requests === 1
        ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
        : route.continue();
    });
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await expect(supportPage.loadingError).toContainText(
      endpoint === 'account'
        ? 'Support account details could not be loaded.'
        : 'Support history could not be loaded.',
    );
    await expect(supportPage.emptyHistory).toHaveCount(0);
    await expect(supportPage.messageInput).toHaveCount(0);
    await supportPage.retryLoading();
    await expect(supportPage.loadingError).toHaveCount(0);
    await expect(supportPage.signedInUser).toContainText('Mara Venn');
    await expect(supportPage.signedInUser).toContainText(
      'Calder Pike Distribution',
    );
    await expect(supportPage.incidentTitles).toHaveText([
      'Priority shipment trace',
      'Nerveline allocation',
      '2030 contract releases',
    ]);
    await expect(supportPage.messageInput).toBeEnabled();
    expect(requests).toBe(2);
    expect(app.modelRequests).toEqual([]);
  });
}

test('retries initial and unchanged failed history queries but suppresses successful duplicate searches', async ({
  page,
  app,
  loginPage,
  ordersPage,
}) => {
  let failNext = true;
  let requests = 0;
  await page.route('**/api/orders?*', (route) => {
    requests++;
    if (failNext) {
      failNext = false;
      return route.fulfill({
        status: 503,
        json: { error: 'History temporarily unavailable.' },
      });
    }
    return route.continue();
  });
  await loginPage.goto('/orders');
  await loginPage.signIn(
    'mara.venn@calderpike.example',
    'Sable-WHS-0427!',
    '/orders',
  );
  await expect(ordersPage.loadingError).toContainText(
    'History temporarily unavailable.',
  );
  await expect(ordersPage.table).toHaveCount(0);
  await ordersPage.retryLoading();
  await expect(ordersPage.table).toBeVisible();
  await expect(ordersPage.signedInUser).toHaveText(
    'Mara Venn // Calder Pike Distribution',
  );
  failNext = true;
  expect((await ordersPage.search('SBL-2026-000417')).status()).toBe(503);
  await expect(ordersPage.loadingError).toBeVisible();
  expect((await ordersPage.search('SBL-2026-000417')).status()).toBe(200);
  await expect(ordersPage.loadingError).toHaveCount(0);
  await expect(ordersPage.orderRows).toHaveCount(1);
  await expect(ordersPage.orderCells('SBL-2026-000417').first()).toBeVisible();
  expect(requests).toBe(4);
  await ordersPage.submitSearch('SBL-2026-000417');
  await expect(ordersPage.table).toBeVisible();
  await ordersPage.goHome();
  expect(requests).toBe(4);
  expect(app.modelRequests).toEqual([]);
});

test('ignores a superseded history failure after a newer search succeeds', async ({
  page,
  app,
  loginPage,
  ordersPage,
}) => {
  await loginPage.goto('/orders');
  await loginPage.signIn(
    'mara.venn@calderpike.example',
    'Sable-WHS-0427!',
    '/orders',
  );
  await expect(ordersPage.table).toBeVisible();
  const held = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  await page.route('**/api/orders?*', async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('query') !==
      'SBL-2026-000417'
    )
      return route.continue();
    try {
      await held.promise;
      await route.fulfill({
        status: 503,
        json: { error: 'Superseded failure' },
      });
    } finally {
      settled.resolve();
    }
  });
  try {
    const requested = page.waitForRequest(
      (request) =>
        new URL(request.url()).searchParams.get('query') === 'SBL-2026-000417',
    );
    await ordersPage.submitSearch('SBL-2026-000417');
    const request = await requested;
    const cancelled = page.waitForEvent(
      'requestfailed',
      (failed) => failed === request,
    );
    expect((await ordersPage.search('SBL-2022-000118')).status()).toBe(200);
    await cancelled;
    held.resolve();
    await settled.promise;
    await expect(ordersPage.orderRows).toHaveCount(1);
    await expect(
      ordersPage.orderCells('SBL-2022-000118').first(),
    ).toBeVisible();
    await expect(ordersPage.loadingError).toHaveCount(0);
    expect(app.modelRequests).toEqual([]);
  } finally {
    held.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
