import { expect, test } from './fixtures/support-app';

const customerMessage = 'Trace my browser test shipment.';
const assistantMessage = 'Which shipment should I trace?';

test.use({ modelReply: assistantMessage });

test.beforeEach(async ({ loginPage, supportPage }) => {
  const loginResponse = await loginPage.goto();
  expect(loginResponse?.status()).toBe(200);
  await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
  await expect(supportPage.incident('Priority shipment trace')).toBeVisible();
});

test('sends and reopens a persisted support exchange without duplicates', async ({
  supportPage,
  supportApp,
}) => {
  await supportPage.startIncident();
  const response = await supportPage.sendMessage(customerMessage);
  expect(response.status()).toBe(200);
  await expect(
    supportPage.messages.filter({ hasText: customerMessage }),
  ).toHaveCount(1);
  await expect(
    supportPage.messages.filter({ hasText: assistantMessage }),
  ).toHaveCount(1);
  await expect(supportPage.incident(customerMessage)).toHaveAttribute(
    'aria-current',
    'page',
  );

  const readExchange = async () => {
    const result = await supportApp.database
      .prepare(`SELECT i.incident_id, i.user_id, i.title,
        m.message_id, m.sequence_number, m.role, m.content
        FROM support_incidents i
        JOIN support_messages m ON m.incident_id = i.incident_id
        WHERE i.user_id = ? AND i.title = ?
        ORDER BY m.sequence_number`)
      .bind('USR-CPD-001', customerMessage)
      .all();
    return result.results;
  };
  const savedExchange = await readExchange();
  const { incidentId, messageId } = response.request().postDataJSON();
  expect(savedExchange).toEqual([
    {
      incident_id: incidentId,
      user_id: 'USR-CPD-001',
      title: customerMessage,
      message_id: messageId,
      sequence_number: 1,
      role: 'user',
      content: customerMessage,
    },
    {
      incident_id: incidentId,
      user_id: 'USR-CPD-001',
      title: customerMessage,
      message_id: `AST-${messageId}`,
      sequence_number: 2,
      role: 'assistant',
      content: assistantMessage,
    },
  ]);
  expect(supportApp.modelRequests).toHaveLength(1);

  await supportPage.reload();
  await supportPage.openIncident('Priority shipment trace');
  await expect(supportPage.messages).not.toContainText([customerMessage]);
  await supportPage.openIncident(customerMessage);
  await expect(supportPage.incident(customerMessage)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText([
    customerMessage,
    assistantMessage,
  ]);
  expect(await readExchange()).toEqual(savedExchange);
  expect(supportApp.modelRequests).toHaveLength(1);
});

test('searches incident titles case-insensitively, selects a match, and restores the list when cleared', async ({
  supportPage,
  supportApp,
}) => {
  const titles = [
    'Priority shipment trace',
    'Nerveline allocation',
    '2030 contract releases',
  ];
  await expect(supportPage.incidentTitles).toHaveText(titles);
  await expect(supportPage.incident('Priority shipment trace')).toHaveAttribute(
    'aria-current',
    'page',
  );

  const readConversation = async () => {
    const result = await supportApp.database
      .prepare(`SELECT message_id, sequence_number, role, content
        FROM support_messages WHERE incident_id = ?
        ORDER BY sequence_number`)
      .bind('INC-USR-CPD-001-02')
      .all<{
        message_id: string;
        sequence_number: number;
        role: string;
        content: string;
      }>();
    return result.results;
  };
  const savedConversation = await readConversation();
  expect(savedConversation.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  const expectedMessages = savedConversation.map((message) => message.content);

  await supportPage.searchIncidents('nErVeLiNe');
  await expect(supportPage.incidentTitles).toHaveText(['Nerveline allocation']);
  await supportPage.openIncident('Nerveline allocation');
  await expect(supportPage.incident('Nerveline allocation')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(expectedMessages);

  await supportPage.clearIncidentSearch();
  await expect(supportPage.incidentSearch).toHaveValue('');
  await expect(supportPage.incidentTitles).toHaveText(titles);
  await expect(supportPage.incident('Nerveline allocation')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(expectedMessages);
  expect(await readConversation()).toEqual(savedConversation);
  expect(supportApp.modelRequests).toHaveLength(0);
});
