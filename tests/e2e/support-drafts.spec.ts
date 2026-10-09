import { expect, test } from './fixtures/app';

const firstTitle = 'Priority shipment trace';
const secondTitle = 'Nerveline allocation';
const firstDraft = 'Keep this unfinished shipment question.';
const secondDraft = 'Keep this independent allocation question.';
const newDraft = 'Keep this new incident draft.';

test.use({ modelReply: 'Which shipment should I trace?' });

test.beforeEach(async ({ loginPage, supportPage }) => {
  await loginPage.goto();
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident(firstTitle)).toBeVisible();
});

test('preserves independent drafts through current, other, and new incident selection', async ({
  supportPage,
  app,
}) => {
  await supportPage.openIncident(firstTitle);
  await supportPage.messageInput.fill(firstDraft);
  await supportPage.openIncident(firstTitle);
  await expect(supportPage.messageInput).toHaveValue(firstDraft);
  await supportPage.openIncident(secondTitle);
  await expect(supportPage.messageInput).toHaveValue('');
  await supportPage.messageInput.fill(secondDraft);
  await supportPage.startIncident();
  await expect(supportPage.messageInput).toHaveValue('');
  await supportPage.messageInput.fill(newDraft);
  await supportPage.startIncident();
  await expect(supportPage.messageInput).toHaveValue(newDraft);
  await supportPage.openIncident(firstTitle);
  await expect(supportPage.messageInput).toHaveValue(firstDraft);
  await supportPage.openIncident(secondTitle);
  await expect(supportPage.messageInput).toHaveValue(secondDraft);
  await supportPage.openIncident('New service incident');
  await expect(supportPage.messageInput).toHaveValue(newDraft);
  expect(app.modelRequests).toHaveLength(0);

  expect((await supportPage.sendMessage(newDraft)).status()).toBe(200);
  await expect(supportPage.messageInput).toHaveValue('');
  await supportPage.openIncident(firstTitle);
  await expect(supportPage.messageInput).toHaveValue(firstDraft);
  await supportPage.openIncident(secondTitle);
  await expect(supportPage.messageInput).toHaveValue(secondDraft);
  await supportPage.openIncident(newDraft);
  await expect(supportPage.messageInput).toHaveValue('');
  expect(app.modelRequests).toHaveLength(1);
});

test('removes only the deleted incident draft and restores the selected survivor draft', async ({
  supportPage,
  app,
}) => {
  await supportPage.openIncident(secondTitle);
  await supportPage.messageInput.fill(secondDraft);
  await supportPage.openIncident(firstTitle);
  await supportPage.messageInput.fill(firstDraft);
  await supportPage.confirmDeletion('2030 contract releases');
  await expect(supportPage.incident('2030 contract releases')).toHaveCount(0);
  await expect(supportPage.messageInput).toHaveValue(firstDraft);
  await supportPage.confirmDeletion(firstTitle);
  await expect(supportPage.incident(firstTitle)).toHaveCount(0);
  await expect(supportPage.incident(secondTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messageInput).toHaveValue(secondDraft);
  expect(app.modelRequests).toHaveLength(0);
});

test('preserves the initial draft when starting an incident with no saved history', async ({
  page,
  supportPage,
  app,
}) => {
  for (const incidentId of [
    'INC-USR-CPD-001-01',
    'INC-USR-CPD-001-02',
    'INC-USR-CPD-001-03',
  ]) {
    expect(
      (
        await page.request.delete(`${app.url}/api/incidents`, {
          data: { incidentId },
        })
      ).status(),
    ).toBe(204);
  }
  await supportPage.reload();
  await expect(supportPage.incidentTitles).toHaveCount(0);
  await supportPage.messageInput.fill(newDraft);
  await supportPage.startIncident();
  await expect(supportPage.messageInput).toHaveValue(newDraft);
  expect(app.modelRequests).toHaveLength(0);
  expect((await supportPage.sendMessage(newDraft)).status()).toBe(200);
  await expect(supportPage.messageInput).toHaveValue('');
  await expect(supportPage.messages.filter({ hasText: newDraft })).toHaveCount(
    1,
  );
  expect(app.modelRequests).toHaveLength(1);
});
