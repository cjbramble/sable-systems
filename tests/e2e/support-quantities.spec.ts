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

function productRecords(records: string, itemNumber: string): string {
  const products = records.split(/(?=^Product: )/m);
  const product = products.find((section) =>
    section.startsWith(`Product: ${itemNumber} —`),
  );
  expect(product).toBeDefined();
  return product!;
}

const reply =
  'The product records include current availability and case-pack requirements.';

test.use({ modelReply: reply });

test.beforeEach(async ({ loginPage, supportPage }) => {
  const response = await loginPage.goto();
  expect(response?.status()).toBe(200);
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident('Priority shipment trace')).toBeVisible();
});

test('saves a fractional-quantity clarification and accepts a grouped integer after reopening', async ({
  supportPage,
  app,
}) => {
  const firstMessage = 'Can you supply 1.5 units of SBL-RPC-12?';
  await supportPage.startIncident();
  const firstResponse = await supportPage.sendMessage(firstMessage);
  expect(firstResponse.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(0);
  const { message: clarification } = await firstResponse.json();
  expect(clarification).toMatch(/quantity|units/i);
  expect(clarification).toMatch(/whole|integer/i);
  await expect(supportPage.messages).toHaveText([firstMessage, clarification]);

  await supportPage.reload();
  await supportPage.openIncident(firstMessage);
  await expect(supportPage.messages).toHaveText([firstMessage, clarification]);
  expect(app.modelRequests).toHaveLength(0);

  const correction = 'Can you supply 1,000 units of SBL-RPC-12?';
  const response = await supportPage.sendMessage(correction);
  expect(response.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(1);
  const records = productRecords(
    authorizedRecords(app.modelRequests[0]),
    'SBL-RPC-12',
  );
  expect(records).toContain('Requested quantity 1000:');
  expect(records).toContain(
    'Stock shortfall for requested quantity 1000: 688 units (1000 requested; 312 available).',
  );
  await expect(supportPage.messages).toHaveText([
    firstMessage,
    clarification,
    correction,
    reply,
  ]);
  await expect(supportPage.requestError).toHaveCount(0);
});

test('keeps each requested quantity with its own product in a combined question', async ({
  supportPage,
  app,
}) => {
  const message =
    'Can you supply 8 units of SBL-RPC-12 and 12 units of SBL-SWC-12?';
  await supportPage.startIncident();
  const response = await supportPage.sendMessage(message);
  expect(response.status()).toBe(200);
  expect(app.modelRequests).toHaveLength(1);
  const records = authorizedRecords(app.modelRequests[0]);
  const rpc = productRecords(records, 'SBL-RPC-12');
  const swc = productRecords(records, 'SBL-SWC-12');
  expect(rpc).toContain('Requested quantity 8: valid case-pack multiple;');
  expect(rpc).not.toContain('Requested quantity 12:');
  expect(swc).toContain('Requested quantity 12: valid case-pack multiple;');
  expect(swc).not.toContain('Requested quantity 8:');
  await expect(supportPage.messages).toHaveText([message, reply]);
  await expect(supportPage.requestError).toHaveCount(0);
});
