import { expect, test } from './fixtures/app';
import { SupportPage } from './pages/support-page';

const title = 'Priority shipment trace';
const otherTitle = 'Nerveline allocation';
const firstMessage = 'Trace the shipment from the first tab.';
const rejectedMessage = 'Check the delivery from the second tab.';
const reply = 'Which shipment should I trace?';

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident(title)).toBeVisible();
});

test('reloads competing conversation changes before an explicit new submission', async ({
  page,
  context,
  supportPage,
  app,
}) => {
  const otherPage = await context.newPage();
  const otherSupport = new SupportPage(otherPage);
  await otherPage.goto(`${app.url}/support`);
  await otherSupport.openIncident(title);
  await supportPage.openIncident(title);
  const winner = await supportPage.sendMessage(firstMessage);
  expect(winner.status()).toBe(200);
  const stale = await otherSupport.sendMessage(rejectedMessage);
  expect(stale.status()).toBe(409);
  expect(stale.request().postDataJSON().expectedRevision).toBe(0);
  await expect(otherSupport.requestError).toContainText(
    'This conversation changed.',
  );
  await expect(otherSupport.retryMessageButton).toHaveCount(0);
  await expect(otherSupport.messageInput).toHaveValue(rejectedMessage);
  await expect(
    otherPage.getByRole('button', { name: 'Send message' }),
  ).toBeDisabled();
  expect(app.modelRequests).toHaveLength(1);

  await otherPage
    .getByRole('button', { name: 'Reload conversation', exact: true })
    .click();
  await expect(
    otherSupport.messages.filter({ hasText: firstMessage }),
  ).toHaveCount(1);
  await expect(
    otherSupport.messages.filter({ hasText: rejectedMessage }),
  ).toHaveCount(0);
  await expect(otherSupport.messageInput).toHaveValue(rejectedMessage);
  await expect(
    otherPage.getByRole('button', { name: 'Send message' }),
  ).toBeEnabled();
  expect(app.modelRequests).toHaveLength(1);

  const resumed = await otherSupport.sendMessage(rejectedMessage);
  expect(resumed.status()).toBe(200);
  expect(resumed.request().postDataJSON()).toMatchObject({
    expectedRevision: 1,
    message: rejectedMessage,
  });
  expect(resumed.request().postDataJSON().messageId).not.toBe(
    stale.request().postDataJSON().messageId,
  );
  await expect(
    otherSupport.messages.filter({ hasText: rejectedMessage }),
  ).toHaveCount(1);
  expect(app.modelRequests).toHaveLength(2);
  expect(app.modelRequests[1]).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: firstMessage }),
      expect.objectContaining({ role: 'assistant', content: reply }),
      expect.objectContaining({ role: 'user', content: rejectedMessage }),
    ]),
  });
  await page.bringToFront();
  await otherPage.close();
});

for (const failure of ['unavailable', 'malformed'] as const) {
  test(`preserves rejected text and the selected draft through ${failure} refresh`, async ({
    page,
    supportPage,
    app,
  }) => {
    await supportPage.openIncident(title);
    await page.route(
      '**/api/chat',
      (route) =>
        route.fulfill({
          status: 409,
          json: {
            code: 'incident_changed',
            error:
              'This conversation changed. Reload it before sending your message again.',
          },
        }),
      { times: 1 },
    );
    await supportPage.sendMessage(rejectedMessage);
    const reload = page.getByRole('button', {
      name: 'Reload conversation',
      exact: true,
    });
    await expect(reload).toBeVisible();
    await page.route(
      '**/api/incidents',
      (route) =>
        route.fulfill(
          failure === 'unavailable'
            ? { status: 503, body: 'Unavailable' }
            : {
                json: {
                  incidents: [
                    { id: 'INC-USR-CPD-001-01', revision: 'invalid' },
                  ],
                },
              },
        ),
      { times: 1 },
    );
    await reload.click();
    await expect(supportPage.requestError).toContainText(
      'could not be reloaded',
    );
    await expect(supportPage.messageInput).toHaveValue(rejectedMessage);
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toBeDisabled();

    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(
      '**/api/incidents',
      async (route) => {
        const response = await route.fetch();
        received.resolve();
        await release.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    try {
      await reload.click();
      await received.promise;
      await supportPage.openIncident(otherTitle);
      await supportPage.messageInput.fill('Keep this unrelated draft.');
      release.resolve();
      await expect(supportPage.incident(otherTitle)).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(supportPage.messageInput).toHaveValue(
        'Keep this unrelated draft.',
      );
      await supportPage.openIncident(title);
      await expect(
        page.getByRole('button', { name: 'Send message' }),
      ).toBeEnabled();
      await expect(supportPage.messageInput).toHaveValue(rejectedMessage);
      await expect(
        supportPage.messages.filter({ hasText: rejectedMessage }),
      ).toHaveCount(0);
      expect(app.modelRequests).toHaveLength(0);
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('does not restore an incident deleted while its snapshot is loading', async ({
  page,
  supportPage,
  app,
}) => {
  await supportPage.openIncident(title);
  await page.route(
    '**/api/chat',
    (route) =>
      route.fulfill({
        status: 409,
        json: { code: 'incident_changed', error: 'This conversation changed.' },
      }),
    { times: 1 },
  );
  await supportPage.sendMessage(rejectedMessage);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  await page.route('**/api/incidents', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  try {
    await page
      .getByRole('button', { name: 'Reload conversation', exact: true })
      .click();
    await received.promise;
    await supportPage.confirmDeletion(title);
    await expect(supportPage.incident(title)).toHaveCount(0);
    await supportPage.openIncident(otherTitle);
    await supportPage.messageInput.fill('Keep this draft after deletion.');
    release.resolve();
    await delivered.promise;
    await expect(supportPage.incident(title)).toHaveCount(0);
    await expect(supportPage.messageInput).toHaveValue(
      'Keep this draft after deletion.',
    );
    await expect(supportPage.requestError).toHaveCount(0);
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('recovers the draft when another tab deletes the stale conversation', async ({
  page,
  supportPage,
  app,
}) => {
  await supportPage.openIncident(title);
  await page.route(
    '**/api/chat',
    (route) =>
      route.fulfill({
        status: 409,
        json: { code: 'incident_changed', error: 'This conversation changed.' },
      }),
    { times: 1 },
  );
  await supportPage.sendMessage(rejectedMessage);
  await expect(
    page.getByRole('button', { name: 'Reload conversation', exact: true }),
  ).toBeVisible();
  const deleted = await page.request.delete(`${app.url}/api/incidents`, {
    data: { incidentId: 'INC-USR-CPD-001-01' },
  });
  expect(deleted.status()).toBe(204);
  await page
    .getByRole('button', { name: 'Reload conversation', exact: true })
    .click();
  await expect(supportPage.incident(title)).toHaveCount(0);
  await expect(
    page.getByText('Incident deleted', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Use message in a new incident' })
    .click();
  await expect(supportPage.messageInput).toHaveValue(rejectedMessage);
  expect(app.modelRequests).toHaveLength(0);
});

test('redirects an expired refresh before trying to decode its body', async ({
  page,
  supportPage,
}) => {
  await supportPage.openIncident(title);
  await page.route(
    '**/api/chat',
    (route) =>
      route.fulfill({
        status: 409,
        json: { code: 'incident_changed', error: 'This conversation changed.' },
      }),
    { times: 1 },
  );
  await supportPage.sendMessage(rejectedMessage);
  await expect(
    page.getByRole('button', { name: 'Reload conversation', exact: true }),
  ).toBeVisible();
  await page.route(
    '**/api/incidents',
    (route) =>
      route.fulfill({
        status: 401,
        contentType: 'text/html',
        body: '<p>Expired</p>',
      }),
    { times: 1 },
  );
  await page.route('**/login?**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<p>Sign in again</p>',
    }),
  );
  await page
    .getByRole('button', { name: 'Reload conversation', exact: true })
    .click();
  await expect(page).toHaveURL(/\/login\?next=%2Fsupport$/);
});

test('keeps a newer draft until it is cleared before retrying an older command', async ({
  page,
  supportPage,
}) => {
  let requests = 0;
  await page.route('**/api/chat', (route) => {
    requests += 1;
    return route.fulfill(
      requests === 1
        ? { status: 503, json: { error: 'Please retry this request.' } }
        : {
            status: 409,
            json: {
              code: 'incident_changed',
              error: 'This conversation changed.',
            },
          },
    );
  });
  await supportPage.openIncident(title);
  await supportPage.sendMessage(rejectedMessage);
  await expect(supportPage.retryMessageButton).toBeEnabled();
  await supportPage.messageInput.fill('Keep this newer draft.');
  await expect(supportPage.retryMessageButton).toBeDisabled();
  await expect(supportPage.requestError).toContainText(
    'Clear your current draft before retrying',
  );
  await expect(supportPage.messageInput).toHaveValue('Keep this newer draft.');
  expect(requests).toBe(1);
  await supportPage.messageInput.clear();
  await supportPage.retryMessage();
  await expect(
    page.getByRole('button', { name: 'Reload conversation', exact: true }),
  ).toBeVisible();
  await expect(supportPage.messageInput).toHaveValue(rejectedMessage);
  expect(requests).toBe(2);
});

test('queues messages from two deleted refreshes and sends each recovered draft', async ({
  page,
  supportPage,
  app,
}) => {
  const secondMessage = 'Preserve the second deleted conversation message.';
  await page.route(
    '**/api/chat',
    (route) =>
      route.fulfill({
        status: 409,
        json: { code: 'incident_changed', error: 'This conversation changed.' },
      }),
    { times: 2 },
  );
  await supportPage.openIncident(title);
  await supportPage.sendMessage(rejectedMessage);
  await expect(
    page.getByRole('button', { name: 'Reload conversation', exact: true }),
  ).toBeVisible();
  await supportPage.openIncident(otherTitle);
  await supportPage.sendMessage(secondMessage);
  await expect(
    page.getByRole('button', { name: 'Reload conversation', exact: true }),
  ).toBeVisible();
  for (const incidentId of ['INC-USR-CPD-001-01', 'INC-USR-CPD-001-02']) {
    expect(
      (
        await page.request.delete(`${app.url}/api/incidents`, {
          data: { incidentId },
        })
      ).status(),
    ).toBe(204);
  }
  await supportPage.openIncident(title);
  await page
    .getByRole('button', { name: 'Reload conversation', exact: true })
    .click();
  await expect(supportPage.incident(title)).toHaveCount(0);
  await supportPage.openIncident(otherTitle);
  await page
    .getByRole('button', { name: 'Reload conversation', exact: true })
    .click();
  await expect(supportPage.incident(otherTitle)).toHaveCount(0);
  const recover = page.getByRole('button', {
    name: 'Use message in a new incident',
  });
  await expect(supportPage.requestError).toContainText(rejectedMessage);
  await expect(supportPage.requestError).toContainText(
    '1 more message waiting',
  );
  await recover.click();
  await expect(supportPage.messageInput).toHaveValue(rejectedMessage);
  expect((await supportPage.sendMessage(rejectedMessage)).status()).toBe(200);
  await expect(supportPage.requestError).toContainText(secondMessage);
  await recover.click();
  await expect(supportPage.messageInput).toHaveValue(secondMessage);
  expect((await supportPage.sendMessage(secondMessage)).status()).toBe(200);
  await expect(supportPage.requestError).toHaveCount(0);
  expect(app.modelRequests).toHaveLength(2);
});
