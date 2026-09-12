import { expect, test } from './fixtures/app';

test.use({
  modelReply: 'Which shipment should I trace?',
  viewport: { width: 390, height: 844 },
});

test('keeps mobile navigation modal, keyboard-accessible, and scrollable with 21 incidents', async ({
  page,
  app,
  loginPage,
  supportPage,
}) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.messageInput).toBeVisible();
  await app.database
    .prepare('DELETE FROM support_incidents WHERE user_id = ?')
    .bind('USR-CPD-001')
    .run();
  await app.database.batch(
    Array.from({ length: 21 }, (_, index) =>
      app.database
        .prepare(
          'INSERT INTO support_incidents (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          `INC-NAV-${String(index).padStart(2, '0')}`,
          'USR-CPD-001',
          `Navigation incident ${String(index).padStart(2, '0')}`,
          '2026-09-12T08:00:00Z',
          '2026-09-12T08:00:00Z',
        ),
    ),
  );
  await supportPage.reload();
  await expect(supportPage.navigationTrigger).toBeVisible();
  await expect(supportPage.incidents).toHaveCount(0);
  await supportPage.navigationTrigger.focus();
  await page.keyboard.press('Shift+Tab');
  expect(await supportPage.desktopNavigationContainsFocus()).toBe(false);

  await supportPage.openNavigation();
  await expect(supportPage.navigationDrawer).toBeVisible();
  await expect(supportPage.incidentTitles).toHaveCount(21);
  await expect(supportPage.messageInput).toHaveCount(0);
  await expect.poll(() => supportPage.navigationContainsFocus()).toBe(true);
  await supportPage.tryFocusingBackgroundComposer();
  await expect.poll(() => supportPage.navigationContainsFocus()).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('mobile-navigation.png'),
  });
  await supportPage.navigationHome.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(supportPage.signedInUser).toBeFocused();
  await expect(supportPage.signedInUser).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('mobile-navigation-footer.png'),
  });
  await page.keyboard.press('Tab');
  await expect(supportPage.navigationHome).toBeFocused();
  await supportPage.incident('Navigation incident 20').scrollIntoViewIfNeeded();
  await expect(supportPage.incident('Navigation incident 20')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(supportPage.navigationDrawer).toHaveCount(0);
  await expect(supportPage.navigationTrigger).toBeFocused();

  await supportPage.openNavigation();
  await supportPage.closeNavigationButton.click();
  await expect(supportPage.navigationTrigger).toBeFocused();
  await supportPage.openNavigation();
  await supportPage.openIncident('Navigation incident 20');
  await expect(supportPage.navigationDrawer).toHaveCount(0);
  await expect(supportPage.navigationTrigger).toBeFocused();

  await supportPage.openNavigation();
  await supportPage.startIncident();
  await expect(supportPage.navigationDrawer).toHaveCount(0);
  await expect(supportPage.navigationTrigger).toBeFocused();

  await supportPage.openNavigation();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(supportPage.navigationDrawer).toHaveCount(0);
  await expect(supportPage.incidentTitles).toHaveCount(22);
  await expect(supportPage.messageInput).toBeVisible();
  await expect(supportPage.messageInput).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(supportPage.incidents).toHaveCount(0);
  await expect(supportPage.navigationTrigger).toBeVisible();
});

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`uses ${reducedMotion === 'reduce' ? 'instant' : 'smooth'} chat scrolling with ${reducedMotion} motion`, async ({
    page,
    loginPage,
    supportPage,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await supportPage.recordChatScrolling();
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    await expect(supportPage.messageInput).toBeVisible();
    await expect.poll(() => supportPage.chatScrollBehaviors()).not.toEqual([]);
    const before = (await supportPage.chatScrollBehaviors()).length;
    await supportPage.sendMessage('Trace a shipment for the scrolling check.');
    await expect
      .poll(async () => (await supportPage.chatScrollBehaviors()).length)
      .toBeGreaterThan(before);
    expect(new Set(await supportPage.chatScrollBehaviors())).toEqual(
      new Set([reducedMotion === 'reduce' ? 'instant' : 'smooth']),
    );
  });
}
