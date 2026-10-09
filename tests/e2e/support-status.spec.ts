import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/app';

const question = 'Help me trace a shipment.';
const reply = 'Which shipment should I trace?';
const online = 'COV-E NODE // ONLINE';
const offline = 'NODE // OFFLINE';

test.use({ modelReply: reply });

async function observeStatusCancellation(page: Page) {
  await page.addInitScript(() => {
    const observed = window as typeof window & {
      statusSignals: (AbortSignal | null)[];
    };
    observed.statusSignals = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input === '/api/status')
        observed.statusSignals.push(init?.signal ?? null);
      return originalFetch(input, init);
    };
  });
}

function statusCancellations(page: Page) {
  return page.evaluate(() =>
    (
      window as typeof window & { statusSignals: (AbortSignal | null)[] }
    ).statusSignals.map((signal) => signal?.aborted ?? false),
  );
}

async function setVisibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: visibility,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('distinguishes checking, offline, and online model status', async ({
  page,
  app,
  loginPage,
  supportPage,
}) => {
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await page.route('**/api/status', async (route) => {
    await statusGate;
    await route.continue();
  });
  app.setModelMetadata({ error: { message: 'Unauthorized' } });
  try {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await expect(supportPage.runtimeStatus).toHaveText('AUTHORIZING NODE');
    await expect(supportPage.runtimeStatus).toBeVisible();
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'color',
      'rgb(231, 189, 104)',
    );
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'background-color',
      'rgb(47, 37, 24)',
    );

    releaseStatus();
    await expect(supportPage.runtimeStatus).toHaveText('NODE // OFFLINE');
    await expect(supportPage.runtimeStatus).toBeVisible();
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'color',
      'rgb(239, 164, 144)',
    );
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'background-color',
      'rgb(47, 29, 26)',
    );

    app.setModelMetadata({ data: { limit_remaining: 1 } });
    await supportPage.reload();
    await expect(supportPage.runtimeStatus).toHaveText('COV-E NODE // ONLINE');
    await expect(supportPage.runtimeStatus).toBeVisible();
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'color',
      'rgb(111, 208, 190)',
    );
    await expect(supportPage.runtimeStatus).toHaveCSS(
      'background-color',
      'rgb(13, 29, 32)',
    );
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    releaseStatus();
  }
});

test('waits for a settled health request before scheduling another poll', async ({
  page,
  loginPage,
  supportPage,
}) => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.route('**/api/status', async (route) => {
    if (++requests === 1) {
      arrived.resolve();
      await release.promise;
    }
    await route.fulfill({ status: 200, json: { ready: true } });
  });
  try {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await arrived.promise;
    await expect(supportPage.messageInput).toBeVisible();
    await page.clock.fastForward(4_000);
    expect(requests).toBe(1);
    release.resolve();
    await expect(supportPage.runtimeStatus).toHaveText(online);

    // The next check is ten seconds after settlement, not after mount.
    await page.clock.fastForward(6_000);
    expect(requests).toBe(1);
    await page.clock.fastForward(4_000);
    await expect.poll(() => requests).toBe(2);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('keeps a healthy provider online after an actual support save failure', async ({
  app,
  page,
  loginPage,
  supportPage,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.runtimeStatus).toHaveText(online);
  await app.database
    .prepare(`CREATE TRIGGER test_status_save_failure
      BEFORE INSERT ON support_messages WHEN NEW.role = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'Controlled save failure'); END`)
    .run();
  try {
    await supportPage.startIncident();
    const response = await supportPage.sendMessage(question);
    expect(response.status()).toBe(500);
    await expect(supportPage.requestError).toContainText(
      'We could not confirm your support message was saved. Please try again.',
    );
    await expect(supportPage.retryMessageButton).toBeEnabled();
    await expect(supportPage.runtimeStatus).toHaveText(online);
    expect(app.modelRequests).toHaveLength(1);
  } finally {
    await app.database.prepare('DROP TRIGGER test_status_save_failure').run();
  }
});

test('aborts a stalled health check and recovers without accepting its late response', async ({
  page,
  loginPage,
  supportPage,
}) => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let requests = 0;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await observeStatusCancellation(page);
  await page.route('**/api/status', async (route) => {
    if (++requests === 1) {
      arrived.resolve();
      await release.promise;
      await route.fulfill({ status: 503, json: { ready: false } });
      delivered.resolve();
    } else {
      await route.fulfill({ status: 200, json: { ready: true } });
    }
  });
  try {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await arrived.promise;
    await expect(supportPage.runtimeStatus).toHaveText('AUTHORIZING NODE');
    await page.clock.fastForward(5_000);
    await expect(supportPage.runtimeStatus).toHaveText(offline);
    expect(await statusCancellations(page)).toEqual([true]);
    expect(requests).toBe(1);

    await page.clock.fastForward(10_000);
    await expect(supportPage.runtimeStatus).toHaveText(online);
    expect(requests).toBe(2);
    release.resolve();
    await delivered.promise;
    await expect(supportPage.runtimeStatus).toHaveText(online);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('pauses hidden health checks and resumes once without applying an older result', async ({
  page,
  loginPage,
  supportPage,
}) => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let requests = 0;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await observeStatusCancellation(page);
  await page.route('**/api/status', async (route) => {
    const requestNumber = ++requests;
    if (requestNumber === 2) {
      arrived.resolve();
      await release.promise;
    }
    await route.fulfill({
      status: requestNumber === 3 ? 503 : 200,
      json: { ready: requestNumber !== 3 },
    });
    if (requestNumber === 2) delivered.resolve();
  });
  try {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await expect(supportPage.runtimeStatus).toHaveText(online);
    await page.clock.fastForward(10_000);
    await arrived.promise;
    await setVisibility(page, 'hidden');
    expect((await statusCancellations(page))[1]).toBe(true);
    await page.clock.fastForward(30_000);
    expect(requests).toBe(2);
    await expect(supportPage.runtimeStatus).toHaveText(online);

    await setVisibility(page, 'visible');
    await setVisibility(page, 'visible');
    await expect(supportPage.runtimeStatus).toHaveText(offline);
    expect(requests).toBe(3);
    release.resolve();
    await delivered.promise;
    await expect(supportPage.runtimeStatus).toHaveText(offline);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('cancels health polling when leaving support and starts fresh on return', async ({
  page,
  loginPage,
  supportPage,
}) => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let requests = 0;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await observeStatusCancellation(page);
  await page.route('**/api/status', async (route) => {
    const requestNumber = ++requests;
    if (requestNumber === 1) {
      arrived.resolve();
      await release.promise;
    }
    await route.fulfill({
      status: requestNumber === 1 ? 200 : 503,
      json: { ready: requestNumber === 1 },
    });
    if (requestNumber === 1) delivered.resolve();
  });
  try {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await arrived.promise;
    await expect(supportPage.messageInput).toBeVisible();
    await page.getByRole('link', { name: 'SABLE home', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    expect(await statusCancellations(page)).toEqual([true]);
    await page.clock.fastForward(30_000);
    expect(requests).toBe(1);

    await page
      .getByRole('link', { name: 'COV-E Support', exact: true })
      .click();
    await expect(supportPage.runtimeStatus).toHaveText(offline);
    expect(requests).toBe(2);
    release.resolve();
    await delivered.promise;
    await expect(supportPage.runtimeStatus).toHaveText(offline);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('keeps a healthy provider online after an actual support record loading failure', async ({
  page,
  app,
  loginPage,
  supportPage,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await supportPage.waitUntilSettled();
  await expect(supportPage.runtimeStatus).toHaveText(online);
  await app.database
    .prepare(
      'ALTER TABLE support_messages RENAME TO unavailable_support_messages',
    )
    .run();
  try {
    await supportPage.startIncident();
    const response = await supportPage.sendMessage(question);
    expect(response.status()).toBe(500);
    await expect(supportPage.requestError).toContainText(
      'Support records could not be loaded. Please try again.',
    );
    await expect(supportPage.retryMessageButton).toBeEnabled();
    await expect(supportPage.runtimeStatus).toHaveText(online);
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    await app.database
      .prepare(
        'ALTER TABLE unavailable_support_messages RENAME TO support_messages',
      )
      .run();
  }
});

for (const outcome of [
  {
    name: 'provider failure',
    response: { status: 503, body: { error: { message: 'Unavailable' } } },
    error:
      'The support model could not complete that request. Please try again.',
  },
  {
    name: 'incomplete completion',
    response: {
      status: 200,
      body: {
        choices: [{ finish_reason: 'length', message: { content: reply } }],
      },
    },
    error: "The support model's reply was incomplete. Please try again.",
  },
]) {
  test.describe(outcome.name, () => {
    test.use({ modelResponses: [[outcome.response], { scope: 'test' }] });

    test('leaves the last observed provider health unchanged', async ({
      page,
      app,
      loginPage,
      supportPage,
    }) => {
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await loginPage.goto();
      await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
      await expect(supportPage.runtimeStatus).toHaveText(online);
      await supportPage.startIncident();
      expect((await supportPage.sendMessage(question)).status()).toBe(502);
      await expect(supportPage.requestError).toContainText(outcome.error);
      await expect(supportPage.runtimeStatus).toHaveText(online);
      expect(app.modelRequests).toHaveLength(1);
    });
  });
}

test('keeps the last health result when chat transport fails', async ({
  page,
  app,
  loginPage,
  supportPage,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.runtimeStatus).toHaveText(online);
  await page.route('**/api/chat', (route) => route.abort('failed'));
  await supportPage.startIncident();
  await supportPage.submitMessage(question);
  await expect(supportPage.retryMessageButton).toBeEnabled();
  await expect(supportPage.requestError).toBeVisible();
  await expect(supportPage.runtimeStatus).toHaveText(online);
  expect(app.modelRequests).toHaveLength(0);
});
