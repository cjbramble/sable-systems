import type { Frame } from '@playwright/test';

import { expect, test } from './fixtures/app';

// This journey must not generate a model reply. An empty sequence rejects any
// unexpected completion request instead of silently using the local model.
test.use({ modelResponses: [[], { scope: 'test' }] });

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

  await loginPage.signIn(
    'mara.venn@calderpike.example',
    'Sable-WHS-0427!',
    '/orders',
  );
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
