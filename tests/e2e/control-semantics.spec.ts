import { expect, test } from './fixtures/app';

test.use({ modelReply: 'Which shipment should I trace?' });
test.beforeEach(async ({ loginPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
});

for (const isComposing of [true, false]) {
  test(`keeps composition confirmation separate from submission (isComposing=${isComposing})`, async ({
    page,
    supportPage,
    app,
  }) => {
    const text = '配送について教えてください';
    const composer = supportPage.messageInput;
    await composer.fill(text);
    await composer.dispatchEvent('compositionstart');
    const cancelled = await composer.evaluate(
      (element, isComposing) =>
        !element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            // oxlint-disable-next-line typescript/no-deprecated -- Exercise the legacy IME confirmation event.
            keyCode: isComposing ? 13 : 229,
            isComposing,
            bubbles: true,
            cancelable: true,
          }),
        ),
      isComposing,
    );
    expect(cancelled).toBe(false);
    await expect(composer).toHaveValue(text);
    expect(app.modelRequests).toHaveLength(0);
    await composer.dispatchEvent('compositionend', { data: text });
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue(text + '\n');
    expect(app.modelRequests).toHaveLength(0);
    const response = page.waitForResponse('**/api/chat');
    await composer.press('Enter');
    expect((await response).status()).toBe(200);
    await expect(composer).toHaveValue('');
    expect(app.modelRequests).toHaveLength(1);
    await expect(supportPage.messages.filter({ hasText: text })).toHaveCount(1);
  });
}

for (const width of [1280, 390]) {
  test.describe(`control semantics at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test('keeps Start over named and keyboard operable', async ({
      page,
      supportPage,
    }) => {
      await supportPage.messageInput.fill('An unsent draft.');
      const start = page.getByRole('button', {
        name: 'Start over',
        exact: true,
      });
      await expect(start).toBeVisible();
      await start.focus();
      await start.press('Enter');
      await expect(supportPage.messageInput).toHaveValue('');
    });

    test('exposes category selection after keyboard filtering', async ({
      shopPage,
    }) => {
      await shopPage.goto();
      const all = shopPage.categoryTab('All');
      const cybernetics = shopPage.categoryTab('Cybernetics');
      await expect(cybernetics).toBeVisible();
      await expect(all).toHaveAttribute('aria-pressed', 'true');
      await expect(cybernetics).toHaveAttribute('aria-pressed', 'false');
      await cybernetics.focus();
      await cybernetics.press('Space');
      await expect(cybernetics).toHaveAttribute('aria-pressed', 'true');
      await expect(all).toHaveAttribute('aria-pressed', 'false');
      await expect(shopPage.productCategories.first()).toHaveText(
        'Cybernetics',
      );
      expect(
        (await shopPage.productCategories.allTextContents()).every(
          (category) => category === 'Cybernetics',
        ),
      ).toBe(true);
    });

    test('labels order search and submits it with Enter', async ({
      page,
      ordersPage,
    }) => {
      await ordersPage.goto();
      const search = page.getByLabel('Search order history', { exact: true });
      await expect(search).toHaveAccessibleName('Search order history');
      await search.fill('SBL-2022-000118');
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          new URL(response.url()).searchParams.get('query') ===
            'SBL-2022-000118',
      );
      await search.press('Enter');
      expect((await response).status()).toBe(200);
      await expect(ordersPage.orderRows).toHaveCount(1);
      await expect(ordersPage.orderRows).toContainText('SBL-2022-000118');
    });
  });
}
