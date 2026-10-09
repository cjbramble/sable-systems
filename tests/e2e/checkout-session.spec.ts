import { expect, test } from './fixtures/app';
import { LoginPage } from './pages/login-page';

test.use({ modelResponses: [[], { scope: 'test' }] });

const mara = {
  email: 'mara.venn@calderpike.example',
  password: 'Sable-WHS-0427!',
};
const imani = {
  email: 'imani.kade@meridiancivic.example',
  password: 'Sable-WHS-1098!',
};
const details = (customerPoNumber: string) => ({
  customerPoNumber,
  requestedShipDate: new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10),
  shippingRegion: 'North Atlantic Trade District',
});

for (const target of [
  {
    name: 'another distributor',
    credentials: imani,
    identity: 'Imani Kade // Meridian Civic Supply',
    userId: 'USR-MCS-001',
    customerId: 'WHS-1098',
  },
  {
    name: 'another buyer in the same distributor',
    credentials: {
      email: 'review@calderpike.example',
      password: mara.password,
    },
    identity: 'Review Buyer // Calder Pike Distribution',
    userId: 'USR-CPD-REVIEW',
    customerId: 'WHS-0427',
  },
]) {
  test(`another tab signing in as ${target.name} requires a fresh checkout review`, async ({
    page,
    context,
    app,
    loginPage,
    shopPage,
  }) => {
    const other = await context.newPage();
    const otherLogin = new LoginPage(other);
    try {
      // This real login form remains open while the first tab signs in.
      await otherLogin.goto('/shop');
      await expect(otherLogin.heading).toBeVisible();
      await loginPage.goto('/shop');
      await loginPage.signIn(mara.email, mara.password, '/shop');
      if (target.userId === 'USR-CPD-REVIEW') {
        await app.database.batch([
          app.database.prepare(`INSERT INTO users
          (user_id, distributor_id, email, display_name, role, status, created_on, last_login_at)
          VALUES ('USR-CPD-REVIEW', 'WHS-0427', 'review@calderpike.example',
            'Review Buyer', 'buyer', 'active', '2026-01-01', NULL)`),
          app.database.prepare(`INSERT INTO user_credentials
          (user_id, password_salt, password_hash, password_iterations, password_updated_at)
          SELECT 'USR-CPD-REVIEW', password_salt, password_hash, password_iterations, password_updated_at
          FROM user_credentials WHERE user_id = 'USR-CPD-001'`),
        ]);
      }
      await shopPage.addCase('SBL-RPC-12');
      await shopPage.openCart();
      await shopPage.fillOrder(details('ACCOUNT-REVIEW'));
      await shopPage.chargeConsent.check();
      await otherLogin.signIn(
        target.credentials.email,
        target.credentials.password,
        '/shop',
      );
      await expect(
        page.getByRole('heading', { name: 'Your account changed' }),
      ).toBeVisible();
      await expect(shopPage.chargeConsent).toHaveCount(0);
      await expect(
        page.getByText('Mara Venn // Calder Pike Distribution'),
      ).toHaveCount(0);
      expect(
        await app.database
          .prepare(
            "SELECT COUNT(*) AS count FROM orders WHERE customer_po_number = 'ACCOUNT-REVIEW'",
          )
          .first(),
      ).toEqual({ count: 0 });

      await page.getByRole('button', { name: 'Reload account' }).click();
      await expect(shopPage.signedInUser).toHaveText(target.identity);
      await expect(shopPage.cartTrigger).toHaveText('Cart 0');
      await shopPage.addCase('SBL-RPC-12');
      await shopPage.openCart();
      await shopPage.fillOrder(details('ACCOUNT-REVIEW'));
      await expect(shopPage.chargeConsent).not.toBeChecked();
      await expect(shopPage.placeOrderButton).toBeDisabled();
      await shopPage.chargeConsent.check();
      expect((await shopPage.placeOrder()).status()).toBe(201);
      expect(
        await app.database
          .prepare(
            "SELECT customer_id, placed_by_user_id FROM orders WHERE customer_po_number = 'ACCOUNT-REVIEW'",
          )
          .first(),
      ).toEqual({
        customer_id: target.customerId,
        placed_by_user_id: target.userId,
      });
    } finally {
      await other.close();
    }
  });
}

test('server blocks an account switch immediately before submit even when the tab misses it', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(mara.email, mara.password, '/shop');
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  await shopPage.fillOrder(details('ACCOUNT-RACE'));
  await shopPage.chargeConsent.check();
  const original = await (await page.request.get('/api/auth/session')).json();
  // Deliberately miss the identity change: correctness must come from the server.
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: original }),
  );
  expect(
    (
      await page.request.post('/api/auth/login', {
        headers: { Origin: app.url },
        data: imani,
      })
    ).status(),
  ).toBe(200);
  const response = await shopPage.placeOrder();
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'account_changed' });
  await expect(
    page.getByRole('heading', { name: 'Your account changed' }),
  ).toBeVisible();
  await expect(shopPage.chargeConsent).toHaveCount(0);
  expect(
    await app.database
      .prepare(
        "SELECT COUNT(*) AS count FROM orders WHERE customer_po_number = 'ACCOUNT-RACE'",
      )
      .first(),
  ).toEqual({ count: 0 });
});

test('same-user session renewal preserves reviewed checkout and consent', async ({
  page,
  context,
  app,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(mara.email, mara.password, '/shop');
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  await shopPage.fillOrder(details('ACCOUNT-RENEWAL'));
  await shopPage.chargeConsent.check();
  const original = (await context.cookies()).find(
    (cookie) => cookie.name === 'sable_session',
  )!.value;
  expect(
    (
      await page.request.post('/api/auth/login', {
        headers: { Origin: app.url },
        data: mara,
      })
    ).status(),
  ).toBe(200);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === 'sable_session')!
      .value,
  ).not.toBe(original);
  const checked = page.waitForResponse('**/api/auth/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await checked).status()).toBe(200);
  await expect(shopPage.chargeConsent).toBeChecked();
  expect((await shopPage.placeOrder()).status()).toBe(201);
});

test('signing out in another tab invalidates the open checkout', async ({
  page,
  context,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(mara.email, mara.password, '/shop');
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  await shopPage.chargeConsent.check();
  const other = await context.newPage();
  try {
    await other.goto('/orders');
    await other.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/login' && url.searchParams.get('next') === '/shop',
    );
    await expect(shopPage.chargeConsent).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('resuming a tab after logout removes old account state and returns to login', async ({
  page,
  app,
  loginPage,
  shopPage,
}) => {
  await loginPage.goto('/shop?category=Power');
  await loginPage.signIn(mara.email, mara.password, '/shop?category=Power');
  await expect(shopPage.signedInUser).toContainText('Mara Venn');
  expect(
    (
      await page.request.post('/api/auth/logout', {
        headers: { Origin: app.url },
      })
    ).status(),
  ).toBe(200);
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('next') === '/shop?category=Power',
  );
  await expect(shopPage.signedInUser).toHaveCount(0);
});

test('an order-history refresh cannot replace the reviewed account while its session check is pending', async ({
  page,
  app,
  loginPage,
  ordersPage,
}) => {
  await loginPage.goto('/orders');
  await loginPage.signIn(mara.email, mara.password, '/orders');
  await expect(ordersPage.signedInUser).toHaveText(
    'Mara Venn // Calder Pike Distribution',
  );
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/auth/session', async (route) => {
    checking.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await checking.promise;
    expect(
      (
        await page.request.post('/api/auth/login', {
          headers: { Origin: app.url },
          data: imani,
        })
      ).status(),
    ).toBe(200);
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        new URL(response.url()).searchParams.get('query') === 'SBL-',
    );
    await ordersPage.submitSearch('SBL-');
    expect((await (await refreshed).json()).account.customerId).toBe(
      'WHS-1098',
    );
    await expect(
      page.getByRole('heading', { name: 'Your account changed' }),
    ).toBeVisible();
    await expect(ordersPage.table).toHaveCount(0);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const destination of ['orders', 'support'] as const) {
  test(`resuming ${destination} hides records from the previous account`, async ({
    page,
    app,
    loginPage,
    ordersPage,
    supportPage,
  }) => {
    await loginPage.goto(`/${destination}`);
    await loginPage.signIn(mara.email, mara.password, `/${destination}`);
    if (destination === 'orders') await expect(ordersPage.table).toBeVisible();
    else {
      await supportPage.waitUntilSettled();
      await supportPage.messageInput.fill('Unsent account-specific question');
      await supportPage.openIncident('Nerveline allocation');
      await supportPage.messageInput.fill('Another account-specific draft');
      await supportPage.startIncident();
      await page.route('**/api/chat', (route) => route.abort('failed'), {
        times: 1,
      });
      await supportPage.submitMessage(
        'An unconfirmed account-specific message',
      );
      await expect(
        page.getByText('Save unconfirmed', { exact: true }),
      ).toBeVisible();
      await supportPage.messageInput.fill('A newer account-specific draft');
    }
    expect(
      (
        await page.request.post('/api/auth/login', {
          headers: { Origin: app.url },
          data: imani,
        })
      ).status(),
    ).toBe(200);
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      ),
    );
    await expect(
      page.getByRole('heading', { name: 'Your account changed' }),
    ).toBeVisible();
    await expect(ordersPage.table).toHaveCount(0);
    await expect(supportPage.messageInput).toHaveCount(0);
    await page.getByRole('button', { name: 'Reload account' }).click();
    if (destination === 'orders')
      await expect(ordersPage.signedInUser).toHaveText(
        'Imani Kade // Meridian Civic Supply',
      );
    else {
      await supportPage.waitUntilSettled();
      await expect(supportPage.messageInput).toHaveValue('');
      await expect(supportPage.retryMessageButton).toHaveCount(0);
      await expect(
        page.getByRole('button', {
          name: 'Check saved conversation',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByText('An unconfirmed account-specific message', {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(supportPage.session.signOutButton).toContainText(
        'Imani Kade',
      );
    }
    expect(app.modelRequests).toEqual([]);
  });
}
