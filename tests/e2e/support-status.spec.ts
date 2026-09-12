import { expect, test } from './fixtures/app';

test.use({ modelReply: 'No inference expected in this status test.' });

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
  app.setModelMetadata({ data: [{ id: 'unrelated-model' }] });
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

    app.setModelMetadata({ data: [{ id: 'customer-support-local' }] });
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
