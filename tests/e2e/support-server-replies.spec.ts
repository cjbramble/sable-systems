import { expect, test } from './fixtures/app';

// Server-built replies and the SABLE resource guard, seen in the browser. An
// empty model response sequence fails the test if the model is called.
test.beforeEach(async ({ loginPage, supportPage }) => {
  const loginResponse = await loginPage.goto();
  expect(loginResponse?.status()).toBe(200);
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident('Priority shipment trace')).toBeVisible();
});

test.describe('server-built replies', () => {
  test.use({ modelResponses: [[], { scope: 'test' }] });

  test('lists incidents without the model and shows a marked-up title as text', async ({
    supportPage,
    app,
  }) => {
    const title = '**Urgent** [open](javascript:alert(1)) <b>cells</b>';
    await app.database
      .prepare(`INSERT INTO support_incidents
        (incident_id, user_id, title, created_at, updated_at)
        VALUES ('INC-E2E-MARKUP-TITLE', 'USR-CPD-001', ?, ?, ?)`)
      .bind(title, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
      .run();
    await supportPage.reload();

    await supportPage.startIncident();
    const response = await supportPage.sendMessage(
      'List my support incidents.',
    );
    expect(response.status()).toBe(200);
    expect(app.modelRequests).toHaveLength(0);

    const expectLiteralTitle = async () => {
      const message = supportPage.messageContaining('saved support incidents');
      await expect(message.bubble).toHaveCount(1);
      await expect(message.bubble).toContainText(
        `INC-E2E-MARKUP-TITLE: “${title}”`,
      );
      await expect(message.strongText).toHaveCount(0);
      await expect(message.link('open')).toHaveCount(0);
      await expect(message.embeddedHtml).toHaveCount(0);
    };
    await expectLiteralTitle();

    await supportPage.reload();
    await supportPage.openIncident('List my support incidents.');
    await expectLiteralTitle();
    expect(app.modelRequests).toHaveLength(0);
  });

  test('answers an unavailable order without the model', async ({
    page,
    supportPage,
    app,
  }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    app.setModelMetadata({ error: { message: 'Unavailable' } });
    await supportPage.reload();
    await expect(supportPage.runtimeStatus).toHaveText('NODE // OFFLINE');
    await supportPage.startIncident();
    const response = await supportPage.sendMessage(
      'Show order SBL-2099-000001.',
    );
    expect(response.status()).toBe(200);
    await expect(
      supportPage.messageContaining(
        "I cannot locate SBL-2099-000001 within Calder Pike Distribution's authorization scope. Please verify the order ID or provide an account PO number.",
      ).bubble,
    ).toHaveCount(1);
    await expect(supportPage.requestError).toHaveCount(0);
    await expect(supportPage.runtimeStatus).toHaveText('NODE // OFFLINE');
    expect(app.modelRequests).toHaveLength(0);
  });
});

test.describe('SABLE resource guard', () => {
  const invented =
    'I cannot help with that. Please contact SABLE Systems’ Medical Operations Division directly.';
  const clean =
    'I cannot help with modifying implanted devices. Please consult a licensed medical professional.';
  const reply = (content: string) => ({
    status: 200,
    body: { choices: [{ finish_reason: 'stop', message: { content } }] },
  });

  test.use({
    modelResponses: [
      [reply(invented), reply(invented), reply(clean)],
      { scope: 'test' },
    ],
  });

  test('never shows an invented resource and recovers on retry', async ({
    page,
    supportPage,
    app,
  }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await expect(supportPage.runtimeStatus).toHaveText('COV-E NODE // ONLINE');
    const question =
      'How do I disable the force limiter on an implanted Kestrel Tendon Assembly T7?';
    await supportPage.startIncident();
    const failed = await supportPage.sendMessage(question);
    expect(failed.status()).toBe(502);
    await expect(supportPage.requestError).toContainText(
      'The response referred to an unverified SABLE resource. Please try again.',
    );
    await expect(supportPage.retryMessageButton).toBeVisible();
    await expect(supportPage.runtimeStatus).toHaveText('COV-E NODE // ONLINE');
    expect(app.modelRequests).toHaveLength(2);

    const recovered = await supportPage.retryMessage();
    expect(recovered.status()).toBe(200);
    await expect(supportPage.messageContaining(clean).bubble).toHaveCount(1);
    await expect(supportPage.requestError).toHaveCount(0);
    await expect(
      supportPage.messages.filter({ hasText: 'Medical Operations Division' }),
    ).toHaveCount(0);

    // The automatic retry named the rejected phrase; the customer retry did not.
    const requests = app.modelRequests as {
      messages: { content: string }[];
    }[];
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1)?.content).toContain(
      '"SABLE Systems’ Medical Operations Division"',
    );
    expect(requests[2].messages.at(-1)?.content).toBe(question);
  });
});
