import type { Frame } from '@playwright/test';

import { expect, test } from './fixtures/app';

// This journey must not generate a model reply. An empty sequence rejects any
// unexpected completion request instead of silently using the local model.
test.use({ modelResponses: [[], { scope: 'test' }] });

const email = 'mara.venn@calderpike.example';
const password = 'Sable-WHS-0427!';

test('returns to the requested page, navigates without a login detour, and revokes the session on logout', async ({
  page,
  context,
  app,
  loginPage,
  homePage,
  ordersPage,
}) => {
  const requiresOrderLogin = (url: URL) =>
    url.pathname === '/login' && url.searchParams.get('next') === '/orders';

  await ordersPage.goto();
  await expect(page).toHaveURL(requiresOrderLogin);
  await expect(loginPage.heading).toBeVisible();
  await expect(ordersPage.table).toHaveCount(0);

  await loginPage.signIn(email, password, '/orders');
  await expect(page).toHaveURL(`${app.url}/orders`);
  await expect(ordersPage.heading).toBeVisible();
  await expect(ordersPage.signedInUser).toHaveText(
    'Mara Venn // Calder Pike Distribution',
  );
  await expect(ordersPage.table).toBeVisible();
  const sessionCookie = (await context.cookies(app.url)).find(
    (cookie) => cookie.name === 'sable_session',
  );
  expect(sessionCookie).toBeDefined();

  await ordersPage.goHome();
  await expect(homePage.ordersLink).toHaveAttribute('href', '/orders');
  const loginDetours: string[] = [];
  const recordNavigation = (frame: Frame) => {
    if (
      frame === page.mainFrame() &&
      new URL(frame.url()).pathname === '/login'
    )
      loginDetours.push(frame.url());
  };
  page.on('framenavigated', recordNavigation);
  try {
    await homePage.openOrders();
    await expect(page).toHaveURL(`${app.url}/orders`);
    await expect(ordersPage.table).toBeVisible();
    await expect(ordersPage.signedInUser).toHaveText(
      'Mara Venn // Calder Pike Distribution',
    );
  } finally {
    page.off('framenavigated', recordNavigation);
  }
  expect(loginDetours).toEqual([]);

  const logout = await ordersPage.signOut();
  expect(logout.status()).toBe(200);
  // Logout redirects after the response headers arrive, so the browser may
  // discard its unread body. Verify cookie removal and server revocation below.
  await expect(loginPage.heading).toBeVisible();
  expect(
    (await context.cookies(app.url)).map((cookie) => cookie.name),
  ).not.toContain('sable_session');

  // A cleared browser cookie alone is not enough: replaying the original token
  // must also fail at the real API. This request does not restore browser auth.
  const replay = await page.request.get(`${app.url}/api/orders`, {
    headers: { Cookie: `sable_session=${sessionCookie!.value}` },
  });
  expect(replay.status()).toBe(401);
  expect(await replay.json()).toEqual({ error: 'Authentication required.' });

  await ordersPage.goto();
  await expect(page).toHaveURL(requiresOrderLogin);
  await expect(loginPage.heading).toBeVisible();
  await expect(ordersPage.table).toHaveCount(0);
  expect(app.modelRequests).toEqual([]);
});

for (const destination of ['shop', 'orders', 'support'] as const) {
  test(`keeps failed sign-out visible and retryable on ${destination}`, async ({
    page,
    context,
    app,
    loginPage,
    shopPage,
    ordersPage,
    supportPage,
  }) => {
    const { session } = {
      shop: shopPage,
      orders: ordersPage,
      support: supportPage,
    }[destination];
    await loginPage.goto(`/${destination}`);
    await loginPage.signIn(email, password, `/${destination}`);
    await expect(session.signOutButton).toBeEnabled();
    const originalCookie = (await context.cookies(app.url)).find(
      (cookie) => cookie.name === 'sable_session',
    );
    expect(originalCookie).toBeDefined();

    for (const failure of ['http', 'network']) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/logout', async (route) => {
        await held;
        if (failure === 'network') await route.abort('failed');
        else
          await route.fulfill({
            status: 503,
            json: { error: 'Logout temporarily unavailable' },
          });
      });
      try {
        await session.signOut();
        await expect(session.signOutButton).toBeDisabled();
        release();
        await expect(session.error).toHaveText(
          'Sign-out could not be confirmed. Please try again.',
        );
        await expect(session.signOutButton).toBeEnabled();
        await expect(page).toHaveURL(`${app.url}/${destination}`);
        expect(
          (await context.cookies(app.url)).find(
            (cookie) => cookie.name === 'sable_session',
          ),
        ).toEqual(originalCookie);
        expect((await page.request.get('/api/auth/session')).status()).toBe(
          200,
        );
      } finally {
        release();
        await page.unroute('**/api/auth/logout');
      }
    }

    const logout = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/logout',
    );
    await session.signOut();
    expect((await logout).status()).toBe(200);
    await expect(page).toHaveURL(`${app.url}/login`);
    await expect(loginPage.heading).toBeVisible();
    expect(
      (await context.cookies(app.url)).some(
        (cookie) => cookie.name === 'sable_session',
      ),
    ).toBe(false);
    const replay = await page.request.get('/api/auth/session', {
      headers: { Cookie: `sable_session=${originalCookie!.value}` },
    });
    expect(replay.status()).toBe(401);
    expect(app.modelRequests).toEqual([]);
  });
}

test('leaving login cancels its delayed session check without redirecting the new page', async ({
  page,
  app,
  loginPage,
  homePage,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/auth/session', async (route) => {
    await held;
    await route.fulfill({ status: 200, json: { authenticated: true } });
  });
  try {
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/auth/session',
    );
    await loginPage.goto();
    const request = await requested;
    const cancelled = page.waitForEvent(
      'requestfailed',
      (failed) => failed === request,
    );
    await loginPage.goHome();
    release();
    await cancelled;
    await expect(page).toHaveURL(`${app.url}/`);
    await expect(homePage.ordersLink).toBeVisible();
    expect(app.modelRequests).toEqual([]);
  } finally {
    release();
    await page.unroute('**/api/auth/session');
  }
});

for (const source of ['catalog', 'account', 'checkout'] as const) {
  test(`preserves the current shop category after ${source} authentication expires`, async ({
    page,
    context,
    app,
    loginPage,
    shopPage,
  }) => {
    await loginPage.goto('/shop');
    await loginPage.signIn(email, password, '/shop');
    await expect(shopPage.categoryTab('All')).toBeVisible();

    if (source === 'checkout') {
      await shopPage.chooseCategory('Power');
      await shopPage.addCase('SBL-RPC-12');
      await shopPage.openCart();
      await shopPage.fillOrder({
        customerPoNumber: 'CPD-EXPIRED-SESSION',
        requestedShipDate: new Date(Date.now() + 30 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        shippingRegion: 'North Atlantic Trade District',
      });
      await shopPage.chargeConsent.check();
      await context.clearCookies();
      expect((await shopPage.placeOrder()).status()).toBe(401);
    } else {
      // Keep the other initial request healthy so each redirect path is tested
      // independently; the selected endpoint returns a real unauthorized response.
      const other = source === 'catalog' ? 'account' : 'catalog';
      const response = await page.request.get(`/api/${other}`);
      expect(response.status()).toBe(200);
      const payload = await response.json();
      await page.route(`**/api/${other}`, (route) =>
        route.fulfill({ json: payload }),
      );
      await context.clearCookies();
      await shopPage.goto('Power');
    }

    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/login' &&
        url.searchParams.get('next') === '/shop?category=Power',
    );
    await page.unrouteAll({ behavior: 'wait' });
    await loginPage.signIn(email, password, '/shop?category=Power');
    await expect(shopPage.categoryTab('Power')).toHaveClass(/is-active/);
    await expect(shopPage.productCategories).toHaveText(['Power']);
    expect(app.modelRequests).toEqual([]);
  });
}
