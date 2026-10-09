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

function modelReply(content: string) {
  return {
    status: 200,
    body: { choices: [{ finish_reason: 'stop', message: { content } }] },
  };
}

test.beforeEach(async ({ loginPage, supportPage }) => {
  const response = await loginPage.goto();
  expect(response?.status()).toBe(200);
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident('Priority shipment trace')).toBeVisible();
});

test.describe('saved order follow-up', () => {
  const firstMessage = 'Show order SBL-2022-000118.';
  const firstReply =
    'Order SBL-2022-000118 was delivered. Its shipment is SHP-2022-000118 and its return is RTN-2022-000014.';
  const followUp = 'What is the total for that order?';
  const followUpReply = 'The order total is available in your order record.';

  test.use({
    modelResponses: [
      [modelReply(firstReply), modelReply(followUpReply)],
      { scope: 'test' },
    ],
  });

  test('keeps that order attached to the customer target after reopening', async ({
    supportPage,
    app,
  }) => {
    await supportPage.startIncident();
    const firstResponse = await supportPage.sendMessage(firstMessage);
    expect(firstResponse.status()).toBe(200);
    await expect(supportPage.messages).toHaveText([firstMessage, firstReply]);

    await supportPage.reload();
    await supportPage.openIncident(firstMessage);
    await expect(supportPage.messages).toHaveText([firstMessage, firstReply]);

    const response = await supportPage.sendMessage(followUp);
    expect(response.status()).toBe(200);
    await expect(supportPage.messages).toHaveText([
      firstMessage,
      firstReply,
      followUp,
      followUpReply,
    ]);
    expect(app.modelRequests).toHaveLength(2);
    const records = authorizedRecords(app.modelRequests[1]);
    expect(records).toContain(
      'Order: SBL-2022-000118; customer PO: CPD-PO-220118;',
    );
    expect(records).toContain('Order total:');
    await expect(supportPage.requestError).toHaveCount(0);
  });
});

test.describe('order reference namespaces', () => {
  const reply = 'The requested order is available.';
  test.use({ modelReply: reply });

  test('saves clarification and resolves a namespace-only PO answer and an explicit order ID', async ({
    supportPage,
    app,
  }) => {
    await app.database
      .prepare('UPDATE orders SET customer_po_number = ? WHERE order_id = ?')
      .bind('SBL-2026-000417', 'SBL-2026-000418')
      .run();
    const firstMessage = 'Show SBL-2026-000417.';
    await supportPage.startIncident();
    const ambiguousResponse = await supportPage.sendMessage(firstMessage);
    expect(ambiguousResponse.status()).toBe(200);
    expect(app.modelRequests).toHaveLength(0);
    const { message: clarification } = await ambiguousResponse.json();
    expect(clarification).toMatch(/order ID/i);
    expect(clarification).toMatch(/(?:customer|account) PO/i);
    await expect(supportPage.messages).toHaveText([
      firstMessage,
      clarification,
    ]);

    await supportPage.reload();
    await supportPage.openIncident(firstMessage);
    await expect(supportPage.messages).toHaveText([
      firstMessage,
      clarification,
    ]);
    expect(app.modelRequests).toHaveLength(0);

    const poMessage = 'It’s the customer PO.';
    const poResponse = await supportPage.sendMessage(poMessage);
    expect(poResponse.status()).toBe(200);
    expect(app.modelRequests).toHaveLength(1);
    const poRecords = authorizedRecords(app.modelRequests[0]);
    expect(poRecords).toContain(
      'Order: SBL-2026-000418; customer PO: SBL-2026-000417;',
    );
    expect(poRecords).toContain('Order total: $118,000.00.');
    expect(poRecords).not.toContain('Order: SBL-2026-000417;');

    const orderMessage = 'Show order ID SBL-2026-000417.';
    const orderResponse = await supportPage.sendMessage(orderMessage);
    expect(orderResponse.status()).toBe(200);
    expect(app.modelRequests).toHaveLength(2);
    const orderRecords = authorizedRecords(app.modelRequests[1]);
    expect(orderRecords).toContain(
      'Order: SBL-2026-000417; customer PO: CPD-PO-260417;',
    );
    expect(orderRecords).toContain('Order total: $78,320.00.');
    expect(orderRecords).not.toContain('Order: SBL-2026-000418;');
    await expect(supportPage.messages).toHaveText([
      firstMessage,
      clarification,
      poMessage,
      reply,
      orderMessage,
      reply,
    ]);
    await expect(supportPage.requestError).toHaveCount(0);
  });
});
