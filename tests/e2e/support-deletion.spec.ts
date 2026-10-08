import { expect, test } from './fixtures/app';

const question = 'Trace my interrupted shipment.';
const deletedTitle = 'Priority shipment trace';
const otherTitle = 'Nerveline allocation';
const deletedId = 'INC-USR-CPD-001-01';

test.use({ modelReply: 'Which shipment should I trace?' });

for (const switchIncident of [false, true]) {
  test(`recovers a message for a deleted incident while ${switchIncident ? 'another incident is selected' : 'it is selected'}`, async ({
    page,
    loginPage,
    supportPage,
    app,
  }) => {
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await supportPage.openIncident(deletedTitle);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(
      '**/api/chat',
      async (route) => {
        received.resolve();
        await release.promise;
        await route.fulfill({ response: await route.fetch() });
      },
      { times: 1 },
    );
    try {
      await supportPage.submitMessage(question);
      await received.promise;
      if (switchIncident) await supportPage.openIncident(otherTitle);
      // Another tab deletes the incident before this stale request reaches storage.
      const deleted = await page.request.delete(`${app.url}/api/incidents`, {
        data: { incidentId: deletedId },
      });
      expect(deleted.status()).toBe(204);
      const rejected = page.waitForResponse('**/api/chat');
      release.resolve();
      expect((await rejected).status()).toBe(410);
      await expect(
        page.getByText('Incident deleted', { exact: true }),
      ).toBeVisible();
      await expect(supportPage.incident(deletedTitle)).toHaveCount(0);
      await expect(supportPage.retryMessageButton).toHaveCount(0);
      if (switchIncident) {
        await expect(supportPage.incident(otherTitle)).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(supportPage.messages).not.toContainText([question]);
      }
      expect(app.modelRequests).toHaveLength(0);
      await page
        .getByRole('button', { name: 'Use message in a new incident' })
        .click();
      await expect(supportPage.messageInput).toHaveValue(question);
      expect(app.modelRequests).toHaveLength(0);
      const sent = await supportPage.sendMessage(question);
      expect(sent.status()).toBe(200);
      expect(sent.request().postDataJSON().incidentId).not.toBe(deletedId);
      expect(app.modelRequests).toHaveLength(1);
      await expect(
        supportPage.messages.filter({ hasText: question }),
      ).toHaveCount(1);
      await supportPage.reload();
      await expect(supportPage.incident(deletedTitle)).toHaveCount(0);
      expect(
        await app.database
          .prepare('SELECT 1 FROM support_incidents WHERE incident_id = ?')
          .bind(deletedId)
          .first(),
      ).toBeNull();
      expect(
        await app.database
          .prepare('SELECT 1 FROM support_messages WHERE incident_id = ?')
          .bind(deletedId)
          .first(),
      ).toBeNull();
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('discarding recovery preserves another selected incident and its draft', async ({
  page,
  loginPage,
  supportPage,
  app,
}) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await supportPage.openIncident(deletedTitle);
  await page.request.delete(`${app.url}/api/incidents`, {
    data: { incidentId: deletedId },
  });
  const response = await supportPage.sendMessage(question);
  expect(response.status()).toBe(410);
  await expect(
    page.getByText('Incident deleted', { exact: true }),
  ).toBeVisible();
  await supportPage.openIncident(otherTitle);
  await supportPage.messageInput.fill('Keep this draft.');
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard unsent message' }).click();
  await expect(supportPage.messageInput).toHaveValue('Keep this draft.');
  await expect(supportPage.incident(otherTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  expect(app.modelRequests).toHaveLength(0);
});
