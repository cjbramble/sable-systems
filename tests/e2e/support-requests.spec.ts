import { expect, test } from './fixtures/app';

const reply = 'Which shipment should I trace?';
const question = 'Trace my interrupted shipment.';
const firstTitle = 'Priority shipment trace';
const secondTitle = 'Nerveline allocation';
const thirdTitle = '2030 contract releases';

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident(firstTitle)).toBeVisible();
});

test('keeps a pending exchange owned by its incident and replays a saved but lost reply', async ({
  page,
  supportPage,
  app,
}) => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let original!: { incidentId: string; messageId: string; messages: unknown[] };
  await page.route(
    '**/api/chat',
    async (route) => {
      original = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      received.resolve();
      await release.promise;
      // Storage has committed; only delivery to the browser is lost.
      await route.abort('failed');
    },
    { times: 1 },
  );
  try {
    await supportPage.startIncident();
    await supportPage.submitMessage(question);
    await received.promise;
    await expect(supportPage.responding).toBeVisible();
    await supportPage.openIncident(firstTitle);
    await expect(supportPage.responding).toHaveCount(0);
    await expect(supportPage.deleteButton(question)).toBeDisabled();
    await expect(supportPage.deleteButton(firstTitle)).toBeEnabled();
    release.resolve();
    await expect(supportPage.messageInput).toBeEnabled();
    await expect(supportPage.requestError).toHaveCount(0);
    await supportPage.openIncident(question);
    await expect(supportPage.requestError).toBeVisible();
    await expect(supportPage.retryMessageButton).toBeEnabled();

    const readMessages = async () =>
      (
        await app.database
          .prepare(
            'SELECT message_id, role, content FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
          )
          .bind(original.incidentId)
          .all()
      ).results;
    const saved = [
      { message_id: original.messageId, role: 'user', content: question },
      {
        message_id: `AST-${original.messageId}`,
        role: 'assistant',
        content: reply,
      },
    ];
    expect(await readMessages()).toEqual(saved);
    const retried = page.waitForResponse('**/api/chat');
    await supportPage.retryMessageButton.click();
    const response = await retried;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual(original);
    await expect(supportPage.requestError).toHaveCount(0);
    await expect(
      supportPage.messages.filter({ hasText: question }),
    ).toHaveCount(1);
    await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(
      1,
    );
    expect(await readMessages()).toEqual(saved);
    expect(app.modelRequests).toHaveLength(1);
    await supportPage.reload();
    await supportPage.openIncident(question);
    await expect(supportPage.messages).toHaveText([question, reply]);

    // A deliberate new submission of the same text is a new exchange, not a retry.
    const repeated = await supportPage.sendMessage(question);
    const repeatedId = repeated.request().postDataJSON().messageId;
    expect(repeatedId).not.toBe(original.messageId);
    await expect(supportPage.messages).toHaveText([
      question,
      reply,
      question,
      reply,
    ]);
    expect(app.modelRequests).toHaveLength(2);
    expect(await readMessages()).toEqual([
      ...saved,
      { message_id: repeatedId, role: 'user', content: question },
      { message_id: `AST-${repeatedId}`, role: 'assistant', content: reply },
    ]);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const reverse of [false, true]) {
  test(`preserves current selection and new replies when overlapping deletions finish ${reverse ? 'in reverse' : 'in request'} order`, async ({
    page,
    supportPage,
    app,
  }) => {
    const targets = [
      { id: 'INC-USR-CPD-001-01', title: firstTitle },
      { id: 'INC-USR-CPD-001-02', title: secondTitle },
    ].map((target) => ({
      ...target,
      received: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    }));
    await page.route('**/api/incidents', async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      const target = targets.find(
        (entry) => entry.id === route.request().postDataJSON().incidentId,
      )!;
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      target.received.resolve();
      await target.release.promise;
      await route.fulfill({ response });
    });
    try {
      for (const target of targets) {
        await supportPage.confirmDeletion(target.title);
        await target.received.promise;
        await expect(supportPage.deleteButton(target.title)).toBeDisabled();
      }
      await expect(supportPage.messageInput).toBeDisabled();
      await supportPage.startIncident();
      const response = await supportPage.sendMessage(question);
      expect(response.status()).toBe(200);
      await expect(supportPage.messages.filter({ hasText: reply })).toHaveCount(
        1,
      );
      await supportPage.messageInput.fill('Keep this unsent draft.');
      const completionOrder = reverse ? [...targets].reverse() : targets;
      for (const target of completionOrder) {
        target.release.resolve();
        await expect(supportPage.incident(target.title)).toHaveCount(0);
        await expect(supportPage.incident(question)).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(supportPage.messageInput).toHaveValue(
          'Keep this unsent draft.',
        );
        await expect(
          supportPage.messages.filter({ hasText: reply }),
        ).toHaveCount(1);
      }
      await expect(supportPage.incidentTitles).toHaveText([
        question,
        thirdTitle,
      ]);
      const { incidentId, messageId } = response.request().postDataJSON();
      const rows = (
        await app.database
          .prepare(
            'SELECT incident_id, title FROM support_incidents WHERE user_id = ? ORDER BY incident_id',
          )
          .bind('USR-CPD-001')
          .all()
      ).results;
      expect(rows).toEqual(
        expect.arrayContaining([
          { incident_id: incidentId, title: question },
          { incident_id: 'INC-USR-CPD-001-03', title: thirdTitle },
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(
        (
          await app.database
            .prepare(
              'SELECT message_id, role, content FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
            )
            .bind(incidentId)
            .all()
        ).results,
      ).toEqual([
        { message_id: messageId, role: 'user', content: question },
        { message_id: `AST-${messageId}`, role: 'assistant', content: reply },
      ]);
      expect(
        await app.database
          .prepare(
            'SELECT COUNT(*) AS count FROM support_messages WHERE incident_id IN (?, ?)',
          )
          .bind(targets[0].id, targets[1].id)
          .first('count'),
      ).toBe(0);
      expect(app.modelRequests).toHaveLength(1);
      await supportPage.reload();
      await expect(supportPage.incidentTitles).toHaveText([
        question,
        thirdTitle,
      ]);
      await supportPage.openIncident(question);
      await expect(supportPage.messages).toHaveText([question, reply]);
    } finally {
      for (const target of targets) target.release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
