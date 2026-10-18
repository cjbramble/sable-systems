import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures/app';

const reply = 'Which shipment should I trace?';
const titles = [
  'Priority shipment trace',
  'Nerveline allocation',
  '2030 contract releases',
];

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident(titles[0])).toBeVisible();
});

// Holds the next chat request until released. Callers must unroute.
async function holdChat(page: Page) {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/chat', async (route) => {
    received.resolve();
    await release.promise;
    await route.fulfill({ response: await route.fetch() });
  });
  return { received: received.promise, release: release.resolve };
}

test('moves focus to the selected incident after a deletion, then to a new incident', async ({
  supportPage,
}) => {
  await supportPage.openIncident(titles[0]);
  for (let remaining = titles.length; remaining > 0; remaining -= 1) {
    const selected = (await supportPage.selectedIncident
      .locator('strong')
      .textContent())!;
    const { response } = await supportPage.deleteIncident(selected, 'confirm');
    expect(response?.status()).toBe(204);
    await expect(supportPage.incident(selected)).toHaveCount(0);
    await expect(
      remaining > 1
        ? supportPage.selectedIncident
        : supportPage.newIncidentButton,
    ).toBeFocused();
  }
  await expect(supportPage.emptyHistory).toBeVisible();
});

test('shows a non-JSON deletion error under its own heading', async ({
  page,
  supportPage,
}) => {
  const title = titles[0];
  await supportPage.openIncident(title);
  const failDeletion = async (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<!DOCTYPE html><title>Bad gateway</title>',
    });
  };
  await page.route('**/api/incidents', failDeletion);
  const { response } = await supportPage.deleteIncident(title, 'confirm');
  expect(response?.status()).toBe(502);
  await expect(supportPage.deletionError).toContainText(
    'The incident could not be deleted. Please try again.',
  );
  await expect(supportPage.deletionError).not.toContainText('Unexpected');
  await expect(
    page.getByText('Support request interrupted', { exact: true }),
  ).toHaveCount(0);
  await expect(supportPage.incident(title)).toHaveCount(1);
  await page.unroute('**/api/incidents', failDeletion);

  const retried = await supportPage.deleteIncident(title, 'confirm');
  expect(retried.response?.status()).toBe(204);
  await expect(supportPage.incident(title)).toHaveCount(0);
  await expect(supportPage.deletionError).toHaveCount(0);
});

test('keeps focus where the user moved it while a reply was pending', async ({
  page,
  supportPage,
}) => {
  await supportPage.startIncident();
  const held = await holdChat(page);
  try {
    await supportPage.submitMessage('Trace my latest shipment.');
    await held.received;
    await supportPage.incidentSearch.click();
    await page.keyboard.type('Nerve');
    const answered = page.waitForResponse('**/api/chat');
    held.release();
    await answered;
    await expect(supportPage.messageContaining(reply).bubble).toHaveCount(1);
    await page.keyboard.type('line');
    await expect(supportPage.incidentSearch).toBeFocused();
    await expect(supportPage.incidentSearch).toHaveValue('Nerveline');
    await expect(supportPage.messageInput).toHaveValue('');
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }

  // Focus left on the send button returns to the composer.
  await supportPage.clearIncidentSearch();
  await supportPage.startIncident();
  expect((await supportPage.sendMessage('Trace another shipment.')).ok()).toBe(
    true,
  );
  await expect(supportPage.messageInput).toBeFocused();
});

test('disables context topics while a reply is pending', async ({
  page,
  supportPage,
  app,
}) => {
  await supportPage.startIncident();
  await expect(supportPage.topics).toHaveCount(3);
  for (const topic of await supportPage.topics.all())
    await expect(topic).toBeEnabled();
  const held = await holdChat(page);
  try {
    await supportPage.topics.first().click();
    await held.received;
    for (const topic of await supportPage.topics.all())
      await expect(topic).toBeDisabled();
    const answered = page.waitForResponse('**/api/chat');
    held.release();
    await answered;
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  for (const topic of await supportPage.topics.all())
    await expect(topic).toBeEnabled();
  expect(app.modelRequests).toHaveLength(1);
});

test('announces only the new reply, not the whole conversation', async ({
  page,
  supportPage,
}) => {
  await expect(supportPage.messageStage).not.toHaveAttribute('aria-live');
  await supportPage.openIncident(titles[0]);
  await expect(supportPage.announcement).toHaveText('');
  const held = await holdChat(page);
  try {
    await supportPage.submitMessage('Trace my latest shipment.');
    await held.received;
    await expect(supportPage.responding).toHaveText('COV-E is responding');
    const answered = page.waitForResponse('**/api/chat');
    held.release();
    await answered;
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(supportPage.announcement).toHaveText(`COV-E replied: ${reply}`);
  // A failed follow-up must not re-announce the earlier reply.
  await page.route('**/api/chat', (route) => route.abort('failed'));
  try {
    await supportPage.submitMessage('Trace a second shipment.');
    await expect(
      page.getByText('Support request interrupted', { exact: true }),
    ).toBeVisible();
    await expect(supportPage.announcement).toHaveText('');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
  await supportPage.openIncident(titles[1]);
  await expect(supportPage.announcement).toHaveText('');
  await supportPage.openIncident(titles[0]);
  await expect(supportPage.announcement).toHaveText('');
});
