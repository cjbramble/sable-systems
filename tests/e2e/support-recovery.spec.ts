import { expect, test } from './fixtures/app';

const firstTitle = 'Priority shipment trace';
const otherTitle = 'Nerveline allocation';
const question = 'Trace my interrupted shipment.';
const reply = 'Which shipment should I trace?';
const newerDraft = 'Keep this newer unsent question.';

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident(firstTitle)).toBeVisible();
});

test('checks a saved but lost exchange without resending or replacing another incident draft', async ({
  page,
  supportPage,
  app,
}) => {
  let chatRequests = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/api/chat' &&
      request.method() === 'POST'
    )
      chatRequests += 1;
  });
  await page.route(
    '**/api/chat',
    async (route) => {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    },
    { times: 1 },
  );
  await supportPage.startIncident();
  await supportPage.submitMessage(question);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await supportPage.messageInput.fill(newerDraft);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  await page.route(
    '**/api/incidents',
    async (route) => {
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
      delivered.resolve();
    },
    { times: 1 },
  );
  try {
    await page
      .getByRole('button', { name: 'Check saved conversation', exact: true })
      .click();
    await received.promise;
    await supportPage.openIncident(otherTitle);
    await supportPage.messageInput.fill('Keep this independent draft.');
    release.resolve();
    await delivered.promise;
    await expect(supportPage.incident(otherTitle)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(supportPage.messageInput).toHaveValue(
      'Keep this independent draft.',
    );
    await supportPage.openIncident(question);
    await expect(supportPage.messages).toHaveText([question, reply]);
    await expect(supportPage.messageInput).toHaveValue(newerDraft);
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toBeEnabled();
    await expect(supportPage.retryMessageButton).toHaveCount(0);
    expect(chatRequests).toBe(1);
    expect(app.modelRequests).toHaveLength(1);
    await supportPage.reload();
    await supportPage.openIncident(question);
    await expect(supportPage.messages).toHaveText([question, reply]);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const existing of [false, true]) {
  test(`keeps an uncertain exchange when ${existing ? 'an unchanged incident lacks its messages' : 'a new incident is absent from saved history'}`, async ({
    page,
    supportPage,
    app,
  }) => {
    let original: unknown;
    let chatRequests = 0;
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/api/chat' &&
        request.method() === 'POST'
      )
        chatRequests += 1;
    });
    await page.route(
      '**/api/chat',
      (route) => {
        original = route.request().postDataJSON();
        return route.abort('failed');
      },
      { times: 1 },
    );
    if (existing) await supportPage.openIncident(firstTitle);
    else await supportPage.startIncident();
    await supportPage.submitMessage(question);
    await expect(
      page.getByText('Save unconfirmed', { exact: true }),
    ).toBeVisible();
    await supportPage.messageInput.fill(newerDraft);
    const checked = page.waitForResponse('**/api/incidents');
    await page
      .getByRole('button', { name: 'Check saved conversation', exact: true })
      .click();
    expect((await checked).status()).toBe(200);
    await expect(supportPage.retryMessageButton).toBeEnabled();
    await expect(
      page.getByText('Save unconfirmed', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Discard unsent message', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toBeDisabled();
    await expect(supportPage.messageInput).toHaveValue(newerDraft);
    await expect(
      page.getByText('Incident deleted', { exact: true }),
    ).toHaveCount(0);
    expect(chatRequests).toBe(1);
    expect(app.modelRequests).toHaveLength(0);
    const retried = await supportPage.retryMessage();
    expect(retried.status()).toBe(200);
    expect(retried.request().postDataJSON()).toEqual(original);
    await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(
      1,
    );
    await expect(supportPage.messageInput).toHaveValue(newerDraft);
    expect(chatRequests).toBe(2);
    expect(app.modelRequests).toHaveLength(1);
  });
}

test('does not discard earlier uncertainty when a later retry is definitely unsaved', async ({
  page,
  supportPage,
  app,
}) => {
  const commands: unknown[] = [];
  await page.route('**/api/chat', async (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      expect((await route.fetch()).status()).toBe(200);
      return route.abort('failed');
    }
    return route.fulfill({
      status: 503,
      json: { error: 'This retry was not saved.', code: 'request_not_saved' },
    });
  });
  await supportPage.startIncident();
  await supportPage.submitMessage(question);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await supportPage.messageInput.fill(newerDraft);
  expect((await supportPage.retryMessage()).status()).toBe(503);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Discard unsent message', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Send message' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Check saved conversation', exact: true })
    .click();
  await expect(supportPage.messages).toHaveText([question, reply]);
  await expect(supportPage.messageInput).toHaveValue(newerDraft);
  await expect(supportPage.retryMessageButton).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(app.modelRequests).toHaveLength(1);
});

for (const failure of ['unavailable', 'malformed'] as const) {
  test(`preserves uncertain command and draft after ${failure} saved-history check`, async ({
    page,
    supportPage,
    app,
  }) => {
    let original: unknown;
    await page.route(
      '**/api/chat',
      async (route) => {
        original = route.request().postDataJSON();
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      },
      { times: 1 },
    );
    await supportPage.openIncident(firstTitle);
    await supportPage.submitMessage(question);
    await expect(
      page.getByText('Save unconfirmed', { exact: true }),
    ).toBeVisible();
    await supportPage.messageInput.fill(newerDraft);
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
    const checked = page.waitForResponse('**/api/incidents');
    await page
      .getByRole('button', { name: 'Check saved conversation', exact: true })
      .click();
    await checked;
    await expect(supportPage.retryMessageButton).toBeEnabled();
    await expect(
      page.getByText('Save unconfirmed', { exact: true }),
    ).toBeVisible();
    await expect(supportPage.messageInput).toHaveValue(newerDraft);
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toBeDisabled();
    const retried = await supportPage.retryMessage();
    expect(retried.status()).toBe(200);
    expect(retried.request().postDataJSON()).toEqual(original);
    await expect(
      supportPage.messages.filter({ hasText: question }),
    ).toHaveCount(1);
    await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(
      1,
    );
    await expect(supportPage.messageInput).toHaveValue(newerDraft);
    expect(app.modelRequests).toHaveLength(1);
  });
}

test('reviews a competing saved revision before releasing an uncertain older command', async ({
  page,
  supportPage,
  app,
}) => {
  const incidentId = 'INC-USR-CPD-001-01';
  let original: { messageId: string };
  await page.route(
    '**/api/chat',
    (route) => {
      original = route.request().postDataJSON();
      return route.abort('failed');
    },
    { times: 1 },
  );
  await supportPage.openIncident(firstTitle);
  await supportPage.submitMessage(question);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await supportPage.messageInput.fill(newerDraft);
  const competingMessage = 'Trace the shipment from another tab.';
  expect(
    (
      await page.request.post(`${app.url}/api/chat`, {
        headers: { Origin: app.url },
        data: {
          incidentId,
          messageId: 'MSG-PHASE4B-COMPETING',
          message: competingMessage,
          expectedRevision: 0,
        },
      })
    ).status(),
  ).toBe(200);
  await page
    .getByRole('button', { name: 'Check saved conversation', exact: true })
    .click();
  await expect(
    supportPage.messages.filter({ hasText: competingMessage }),
  ).toHaveCount(1);
  await expect(supportPage.messages.filter({ hasText: question })).toHaveCount(
    0,
  );
  await expect(supportPage.messageInput).toHaveValue(newerDraft);
  await expect(supportPage.retryMessageButton).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Use unsent message', exact: true }),
  ).toBeDisabled();
  expect(app.modelRequests).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Discard unsent message', exact: true })
    .click();
  const resumed = await supportPage.sendMessage(newerDraft);
  expect(resumed.status()).toBe(200);
  expect(resumed.request().postDataJSON()).toMatchObject({
    incidentId,
    expectedRevision: 1,
    message: newerDraft,
  });
  expect(resumed.request().postDataJSON().messageId).not.toBe(
    original!.messageId,
  );
  await expect(supportPage.messages.filter({ hasText: question })).toHaveCount(
    0,
  );
  expect(app.modelRequests).toHaveLength(2);
});

test('keeps independent failed exchanges and drafts when another incident is resolved', async ({
  page,
  supportPage,
  app,
}) => {
  const commands: unknown[] = [];
  await page.route(
    '**/api/chat',
    (route) => {
      commands.push(route.request().postDataJSON());
      return commands.length === 1
        ? route.abort('failed')
        : route.fulfill({
            status: 503,
            json: {
              error: 'This request was not saved.',
              code: 'request_not_saved',
            },
          });
    },
    { times: 2 },
  );
  await supportPage.openIncident(firstTitle);
  await supportPage.submitMessage(question);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await supportPage.messageInput.fill(newerDraft);
  await supportPage.openIncident(otherTitle);
  expect(
    (await supportPage.sendMessage('Check another shipment.')).status(),
  ).toBe(503);
  await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
  await supportPage.messageInput.fill('Keep another incident draft.');
  await page
    .getByRole('button', { name: 'Discard unsent message', exact: true })
    .click();
  await expect(
    supportPage.messages.filter({ hasText: 'Check another shipment.' }),
  ).toHaveCount(0);
  await expect(supportPage.messageInput).toHaveValue(
    'Keep another incident draft.',
  );
  await expect(
    page.getByRole('button', { name: 'Send message' }),
  ).toBeEnabled();
  await supportPage.openIncident(firstTitle);
  await expect(
    page.getByText('Save unconfirmed', { exact: true }),
  ).toBeVisible();
  await expect(supportPage.messageInput).toHaveValue(newerDraft);
  const retried = await supportPage.retryMessage();
  expect(retried.status()).toBe(200);
  expect(retried.request().postDataJSON()).toEqual(commands[0]);
  await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(1);
  await supportPage.openIncident(otherTitle);
  await expect(supportPage.messageInput).toHaveValue(
    'Keep another incident draft.',
  );
  await expect(supportPage.retryMessageButton).toHaveCount(0);
  expect(app.modelRequests).toHaveLength(1);
});

test('does not restore a late saved reply after the account changes', async ({
  page,
  supportPage,
  app,
}) => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  await page.route(
    '**/api/chat',
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
      delivered.resolve();
    },
    { times: 1 },
  );
  try {
    await supportPage.startIncident();
    await supportPage.submitMessage(question);
    await received.promise;
    await supportPage.messageInput.fill(newerDraft);
    expect(
      (
        await page.request.post(`${app.url}/api/auth/login`, {
          headers: { Origin: app.url },
          data: {
            email: 'imani.kade@meridiancivic.example',
            password: 'Sable-WHS-1098!',
          },
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
    release.resolve();
    await delivered.promise;
    await expect(supportPage.messageInput).toHaveCount(0);
    await expect(supportPage.messages).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Reload account', exact: true })
      .click();
    await supportPage.waitUntilSettled();
    await expect(supportPage.session.signOutButton).toContainText('Imani Kade');
    await expect(supportPage.messageInput).toHaveValue('');
    await expect(supportPage.incident(question)).toHaveCount(0);
    await expect(
      supportPage.messages.filter({ hasText: question }),
    ).toHaveCount(0);
    await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(
      0,
    );
    await expect(supportPage.retryMessageButton).toHaveCount(0);
    expect(app.modelRequests).toHaveLength(1);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
