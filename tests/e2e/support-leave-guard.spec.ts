import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/app';

const linkReply = 'Review your [Order history](/orders).';
const draft = 'Keep this unfinished question.';
const leaveWarning =
  'Leave support? Unsent drafts and messages on this page will be lost.';

test.use({ modelReply: linkReply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await supportPage.startIncident();
  expect((await supportPage.sendMessage('Where are my orders?')).ok()).toBe(
    true,
  );
});

// A full page load discards this marker; client-side navigation keeps it.
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as typeof window & { sameDocument?: boolean }).sameDocument = true;
  });
}

async function isSameDocument(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { sameDocument?: boolean }).sameDocument ===
      true,
  );
}

test('opens in-app reply links without a full page load', async ({
  page,
  supportPage,
  ordersPage,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await markDocument(page);
  await supportPage
    .messageContaining('Review your')
    .link('Order history')
    .click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(ordersPage.heading).toBeVisible();
  expect(await isSameDocument(page)).toBe(true);
  expect(dialogs).toEqual([]);
});

test('asks before an in-app link discards a draft', async ({
  page,
  supportPage,
  ordersPage,
}) => {
  await supportPage.messageInput.fill(draft);
  await markDocument(page);
  const link = supportPage
    .messageContaining('Review your')
    .link('Order history');

  const declined = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toBe(leaveWarning);
    await dialog.dismiss();
  });
  await link.click();
  await declined;
  await expect(page).toHaveURL(/\/support$/);
  await expect(supportPage.messageInput).toHaveValue(draft);

  const accepted = page
    .waitForEvent('dialog')
    .then((dialog) => dialog.accept());
  await link.click();
  await accepted;
  await expect(ordersPage.heading).toBeVisible();
  expect(await isSameDocument(page)).toBe(true);
});

test('warns before unloading the page with a draft', async ({
  page,
  supportPage,
}) => {
  await supportPage.messageInput.fill(draft);
  const prompted = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await prompted;
  expect(page.isClosed()).toBe(false);
  await expect(supportPage.messageInput).toHaveValue(draft);
});

test('signs out with a draft without a leave warning', async ({
  page,
  supportPage,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await supportPage.messageInput.fill(draft);
  await supportPage.session.signOut();
  await expect(page).toHaveURL(/\/login$/);
  expect(dialogs).toEqual([]);
});
