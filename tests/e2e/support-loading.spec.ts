import type { Page, Route } from '@playwright/test';

import type { AccountSummary } from '../../lib/contracts';
import type { SupportIncident } from '../../lib/support-incidents';
import { expect, test } from './fixtures/app';
import type { SupportPage } from './pages/support-page';

test.use({ modelResponses: [[], { scope: 'test' }] });

type Endpoint = 'account' | 'incidents';
type Payloads = {
  account: AccountSummary;
  incidents: { incidents: SupportIncident[] };
};

const endpoints = ['account', 'incidents'] as const;
const loadingText = 'VERIFYING DISTRIBUTION CREDENTIALS';
const timeoutMessage =
  'Support account and history took too long to load. Please try again.';
const errors = {
  account: 'Support account details could not be loaded. Please try again.',
  incidents: 'Support history could not be loaded. Please try again.',
};

async function prepareSupport(page: Page, origin: string): Promise<Payloads> {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: origin },
    data: {
      email: 'mara.venn@calderpike.example',
      password: 'Sable-WHS-0427!',
    },
  });
  expect(login.status()).toBe(200);
  const [account, incidents] = await Promise.all(
    endpoints.map((endpoint) => page.request.get(`/api/${endpoint}`)),
  );
  expect(account.status()).toBe(200);
  expect(incidents.status()).toBe(200);
  return { account: await account.json(), incidents: await incidents.json() };
}

function heldResponse() {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  return {
    arrived,
    release,
    delivered,
    async fulfill(route: Route, payload: unknown, status = 200) {
      arrived.resolve();
      await release.promise;
      try {
        await route.fulfill({ status, json: payload });
      } finally {
        delivered.resolve();
      }
    },
  };
}

async function expectLoading(page: Page, supportPage: SupportPage) {
  await expect(page.getByText(loadingText, { exact: true })).toBeVisible();
  await expect(supportPage.loadingError).toHaveCount(0);
  await expect(supportPage.signedInUser).toHaveCount(0);
  await expect(supportPage.incidentTitles).toHaveCount(0);
  await expect(supportPage.emptyHistory).toHaveCount(0);
  await expect(supportPage.messageInput).toHaveCount(0);
}

async function expectReady(supportPage: SupportPage) {
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
  await expect(supportPage.loadingError).toHaveCount(0);
  await expect(supportPage.emptyHistory).toHaveCount(0);
}

async function cancelledReads(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(
        sessionStorage.getItem('supportReadAborts') ?? '[]',
      ) as string[],
  );
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  // Observe cancellation while passing fetch calls and responses through unchanged.
  // Session storage preserves the evidence across a login redirect.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input === '/api/account' || input === '/api/incidents') {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const aborted = JSON.parse(
              sessionStorage.getItem('supportReadAborts') ?? '[]',
            ) as string[];
            aborted.push(input);
            sessionStorage.setItem(
              'supportReadAborts',
              JSON.stringify(aborted),
            );
          },
          { once: true },
        );
      }
      return originalFetch(input, init);
    };
  });
});

for (const endpoint of endpoints) {
  const sibling: Endpoint = endpoint === 'account' ? 'incidents' : 'account';

  for (const failure of [
    '401',
    '503',
    'network',
    'invalid JSON',
    'invalid shape',
  ]) {
    test(`handles support ${endpoint} ${failure} while its sibling is still pending`, async ({
      page,
      app,
      loginPage,
      supportPage,
    }) => {
      const payloads = await prepareSupport(page, app.url);
      // The login page checks the real session before showing its form.
      if (failure === '401') await page.context().clearCookies();
      const held = heldResponse();
      await page.route(`**/api/${sibling}`, (route) =>
        held.fulfill(route, payloads[sibling]),
      );
      await page.route(`**/api/${endpoint}`, async (route) => {
        // Make the concurrency requirement explicit before delivering failure.
        await held.arrived.promise;
        if (failure === 'network') return route.abort('failed');
        if (failure === 'invalid JSON')
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{private diagnostic: invalid JSON',
          });
        if (failure === 'invalid shape')
          return route.fulfill({
            json:
              endpoint === 'account'
                ? { ...payloads.account, userDisplayName: 42 }
                : { incidents: null },
          });
        // A login redirect must not depend on decoding an error response body.
        return route.fulfill({
          status: Number(failure),
          contentType: 'application/json',
          body: '{private diagnostic: invalid JSON',
        });
      });
      try {
        await page.goto('/support');
        await held.arrived.promise;
        if (failure === '401') {
          await expect(loginPage.heading).toBeVisible();
          await expect(page).toHaveURL(
            (url) =>
              url.pathname === '/login' &&
              url.searchParams.get('next') === '/support',
          );
        } else {
          await expect(supportPage.loadingError.locator('p')).toHaveText(
            errors[endpoint],
          );
          await expect(
            page.getByRole('button', { name: 'Retry support', exact: true }),
          ).toBeEnabled();
          await expect(supportPage.signedInUser).toHaveCount(0);
          await expect(supportPage.emptyHistory).toHaveCount(0);
          await expect(supportPage.messageInput).toHaveCount(0);
        }
        expect(await cancelledReads(page)).toContain(`/api/${sibling}`);
        expect(app.modelRequests).toEqual([]);
      } finally {
        held.release.resolve();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }

  test(`commits support account and history together when ${endpoint} arrives first`, async ({
    page,
    app,
    supportPage,
  }) => {
    const payloads = await prepareSupport(page, app.url);
    const held = { account: heldResponse(), incidents: heldResponse() };
    for (const target of endpoints)
      await page.route(`**/api/${target}`, (route) =>
        held[target].fulfill(route, payloads[target]),
      );
    try {
      await page.goto('/support');
      await Promise.all(
        endpoints.map((target) => held[target].arrived.promise),
      );
      await expectLoading(page, supportPage);
      const completed = page.waitForEvent(
        'requestfinished',
        (request) => new URL(request.url()).pathname === `/api/${endpoint}`,
      );
      held[endpoint].release.resolve();
      await completed;
      await expectLoading(page, supportPage);
      held[sibling].release.resolve();
      await expectReady(supportPage);
      await page.clock.fastForward(10_000);
      await expectReady(supportPage);
      expect(app.modelRequests).toEqual([]);
    } finally {
      for (const target of endpoints) held[target].release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test(`times out the whole support attempt with ${endpoint} pending and ignores its late reply after retry`, async ({
    page,
    app,
    supportPage,
  }) => {
    const payloads = await prepareSupport(page, app.url);
    const first = { account: heldResponse(), incidents: heldResponse() };
    const second = { account: heldResponse(), incidents: heldResponse() };
    const requests = { account: 0, incidents: 0 };
    for (const target of endpoints)
      await page.route(`**/api/${target}`, (route) => {
        const attempt = ++requests[target];
        return (attempt === 1 ? first : second)[target].fulfill(
          route,
          attempt === 1
            ? target === 'account'
              ? { ...payloads.account, userDisplayName: 'Stale Buyer' }
              : { incidents: [] }
            : payloads[target],
        );
      });
    try {
      await page.goto('/support');
      await Promise.all(
        endpoints.map((target) => first[target].arrived.promise),
      );
      await expectLoading(page, supportPage);
      await page.clock.fastForward(6_000);
      const completed = page.waitForEvent(
        'requestfinished',
        (request) => new URL(request.url()).pathname === `/api/${sibling}`,
      );
      first[sibling].release.resolve();
      await completed;
      await page.clock.fastForward(3_999);
      await expectLoading(page, supportPage);
      await page.clock.fastForward(1);
      await expect(supportPage.loadingError.locator('p')).toHaveText(
        timeoutMessage,
      );
      expect(await cancelledReads(page)).toContain(`/api/${endpoint}`);
      await expect(supportPage.emptyHistory).toHaveCount(0);
      await expect(supportPage.messageInput).toHaveCount(0);

      await supportPage.retryLoading();
      await Promise.all(
        endpoints.map((target) => second[target].arrived.promise),
      );
      await expectLoading(page, supportPage);
      expect(requests).toEqual({ account: 2, incidents: 2 });
      for (const target of endpoints) second[target].release.resolve();
      await expectReady(supportPage);
      first[endpoint].release.resolve();
      await first[endpoint].delivered.promise;
      await page.clock.fastForward(10_000);
      await expectReady(supportPage);
      await expect(page.getByText('Stale Buyer', { exact: false })).toHaveCount(
        0,
      );
      expect(requests).toEqual({ account: 2, incidents: 2 });
      expect(app.modelRequests).toEqual([]);
    } finally {
      for (const target of endpoints) {
        first[target].release.resolve();
        second[target].release.resolve();
      }
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('cancels both initial reads on SPA departure and ignores old unauthorized responses after returning', async ({
  page,
  app,
  supportPage,
}) => {
  const payloads = await prepareSupport(page, app.url);
  const held = { account: heldResponse(), incidents: heldResponse() };
  const requests = { account: 0, incidents: 0 };
  for (const endpoint of endpoints)
    await page.route(`**/api/${endpoint}`, (route) =>
      ++requests[endpoint] === 1
        ? held[endpoint].fulfill(
            route,
            { error: 'Old unauthorized response' },
            401,
          )
        : route.fulfill({ json: payloads[endpoint] }),
    );
  try {
    await page.goto('/');
    await page
      .getByRole('link', { name: 'COV-E Support', exact: true })
      .click();
    await Promise.all(endpoints.map((target) => held[target].arrived.promise));
    await expectLoading(page, supportPage);
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    expect(await cancelledReads(page)).toEqual(
      expect.arrayContaining(['/api/account', '/api/incidents']),
    );
    await page.clock.fastForward(10_000);
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page
      .getByRole('link', { name: 'COV-E Support', exact: true })
      .click();
    await expectReady(supportPage);
    for (const endpoint of endpoints) held[endpoint].release.resolve();
    await Promise.all(
      endpoints.map((target) => held[target].delivered.promise),
    );
    await page.clock.fastForward(10_000);
    await expect(page).toHaveURL((url) => url.pathname === '/support');
    await expectReady(supportPage);
    expect(requests).toEqual({ account: 2, incidents: 2 });
    expect(app.modelRequests).toEqual([]);
  } finally {
    for (const endpoint of endpoints) held[endpoint].release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
