import { expect, test } from './fixtures/app';

function authorizedRecords(request: unknown): string {
  const { messages } = request as {
    messages: { role: string; content: string }[];
  };
  expect(messages[1].role).toBe('user');
  const data = JSON.parse(messages[1].content);
  expect(data.source).toBe('authorized_support_records');
  expect(typeof data.records).toBe('string');
  return data.records;
}

function expectExcludedStatuses(records: string, excluded: string[]) {
  expect(records).toMatch(/Authorization: .+ \(WHS-0427\) only\./);
  const search = records
    .split('\n')
    .find((line) => line.startsWith('Order search'));
  expect(search).toMatch(/exclud/i);
  for (const status of excluded) expect(search).toContain(status);

  const statuses = [...records.matchAll(/^- [^:\n]+: ([a-z_]+);/gm)].map(
    (match) => match[1],
  );
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of excluded) expect(statuses).not.toContain(status);
}

const reply = 'Your matching order records are available.';

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  const response = await loginPage.goto();
  expect(response?.status()).toBe(200);
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident('Priority shipment trace')).toBeVisible();
});

test('excludes cancelled orders and preserves the exchange after reopening', async ({
  supportPage,
  app,
}) => {
  const message = 'Show orders that are not cancelled.';
  await supportPage.startIncident();
  const response = await supportPage.sendMessage(message);
  expect(response.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(1);
  expectExcludedStatuses(authorizedRecords(app.modelRequests[0]), [
    'cancelled',
  ]);
  await expect(supportPage.messages).toHaveText([message, reply]);

  await supportPage.reload();
  await supportPage.openIncident(message);
  await expect(supportPage.messages).toHaveText([message, reply]);
  expect(app.modelRequests).toHaveLength(1);
  await expect(supportPage.requestError).toHaveCount(0);
});

test('saves an ambiguous status clarification and accepts an explicit exclusion list', async ({
  supportPage,
  app,
}) => {
  const firstMessage = 'Show orders that are not cancelled or delivered.';
  await supportPage.startIncident();
  const firstResponse = await supportPage.sendMessage(firstMessage);
  expect(firstResponse.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(0);
  const { message: clarification } = await firstResponse.json();
  expect(clarification).toMatch(/status|statuses/i);
  expect(clarification).toMatch(/include|exclude/i);
  await expect(supportPage.messages).toHaveText([firstMessage, clarification]);
  const title = await supportPage.incidentTitles.first().innerText();

  await supportPage.reload();
  await supportPage.openIncident(title);
  await expect(supportPage.messages).toHaveText([firstMessage, clarification]);
  expect(app.modelRequests).toHaveLength(0);

  const correction = 'Show orders excluding cancelled and delivered.';
  const response = await supportPage.sendMessage(correction);
  expect(response.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(1);
  expectExcludedStatuses(authorizedRecords(app.modelRequests[0]), [
    'cancelled',
    'delivered',
  ]);
  await expect(supportPage.messages).toHaveText([
    firstMessage,
    clarification,
    correction,
    reply,
  ]);
  await expect(supportPage.requestError).toHaveCount(0);
});
