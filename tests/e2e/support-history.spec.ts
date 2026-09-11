import { expect, test } from './fixtures/app';

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
  app,
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
    const result = await app.database
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
  expect(app.modelRequests).toHaveLength(1);

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
  expect(app.modelRequests).toHaveLength(1);
});

test('searches incident titles case-insensitively, selects a match, and restores the list when cleared', async ({
  supportPage,
  app,
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
    const result = await app.database
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
  expect(app.modelRequests).toHaveLength(0);
});

test('cancels and confirms incident deletion with the remaining conversation preserved after reload', async ({
  supportPage,
  app,
}) => {
  const deletedId = 'INC-USR-CPD-001-01';
  const deletedTitle = 'Priority shipment trace';
  const remainingId = 'INC-USR-CPD-001-02';
  const remainingTitle = 'Nerveline allocation';
  const titles = [deletedTitle, remainingTitle, '2030 contract releases'];
  const expectedPrompt = {
    type: 'confirm',
    message: `Delete “${deletedTitle}”?`,
  };

  const readHistory = async () => {
    const [incidents, messages] = await Promise.all([
      app.database
        .prepare('SELECT * FROM support_incidents ORDER BY incident_id')
        .all<{ incident_id: string }>(),
      app.database
        .prepare(`SELECT * FROM support_messages
          ORDER BY incident_id, sequence_number`)
        .all<{ incident_id: string; content: string }>(),
    ]);
    return { incidents: incidents.results, messages: messages.results };
  };
  const before = await readHistory();
  expect(
    before.incidents.filter((incident) => incident.incident_id === deletedId),
  ).toHaveLength(1);
  const deletedMessages = before.messages
    .filter((message) => message.incident_id === deletedId)
    .map((message) => message.content);
  const remainingMessages = before.messages
    .filter((message) => message.incident_id === remainingId)
    .map((message) => message.content);
  expect(deletedMessages).toHaveLength(2);
  expect(remainingMessages).toHaveLength(2);
  await expect(supportPage.incidentTitles).toHaveText(titles);
  await expect(supportPage.incident(deletedTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(deletedMessages);

  const cancelled = await supportPage.deleteIncident(deletedTitle, 'cancel');
  expect(cancelled.prompt).toEqual(expectedPrompt);
  await expect(supportPage.incidentTitles).toHaveText(titles);
  await expect(supportPage.incident(deletedTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(deletedMessages);
  expect(await readHistory()).toEqual(before);

  await supportPage.reload();
  await expect(supportPage.incidentTitles).toHaveText(titles);
  await expect(supportPage.incident(deletedTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(deletedMessages);
  expect(await readHistory()).toEqual(before);

  const confirmed = await supportPage.deleteIncident(deletedTitle, 'confirm');
  expect(confirmed.prompt).toEqual(expectedPrompt);
  expect(confirmed.response?.status()).toBe(204);
  expect(confirmed.response?.request().postDataJSON()).toEqual({
    incidentId: deletedId,
  });
  await expect(supportPage.incidentTitles).toHaveText(titles.slice(1));
  await expect(supportPage.incident(remainingTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(remainingMessages);
  const afterDeletion = {
    incidents: before.incidents.filter(
      (incident) => incident.incident_id !== deletedId,
    ),
    messages: before.messages.filter(
      (message) => message.incident_id !== deletedId,
    ),
  };
  expect(await readHistory()).toEqual(afterDeletion);

  await supportPage.reload();
  await expect(supportPage.incidentTitles).toHaveText(titles.slice(1));
  await expect(supportPage.incident(remainingTitle)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(supportPage.messages).toHaveText(remainingMessages);
  expect(await readHistory()).toEqual(afterDeletion);
  expect(app.modelRequests).toHaveLength(0);
});

test.describe('model failure recovery', () => {
  const firstMessage = 'Help trace my shipment.';
  const followUpMessage = 'Which order details do you need?';
  const recoveredReply = 'Please provide the order number.';
  const errorMessage =
    'The local model could not complete that request. Please try again.';
  const upstreamError = 'Controlled upstream failure for browser recovery test';

  test.use({
    modelResponses: [
      [
        { status: 503, body: { error: upstreamError } },
        {
          status: 200,
          body: { choices: [{ message: { content: recoveredReply } }] },
        },
      ],
      { scope: 'test' },
    ],
  });

  test('recovers from a model error without adding error text to the conversation or subsequent model history', async ({
    supportPage,
    app,
  }) => {
    await supportPage.startIncident();
    const failedResponse = await supportPage.sendMessage(firstMessage);
    expect(failedResponse.status()).toBe(502);
    expect(await failedResponse.json()).toEqual({ error: errorMessage });
    await expect(supportPage.requestError).toBeVisible();
    await expect(supportPage.requestError).toContainText(errorMessage);
    await expect(
      supportPage.messageEntries.filter({ has: supportPage.requestError }),
    ).toHaveCount(0);
    await expect(supportPage.messages).toHaveCount(2);
    await expect(
      supportPage.messages.filter({ hasText: firstMessage }),
    ).toHaveCount(1);
    await expect(
      supportPage.messages.filter({ hasText: errorMessage }),
    ).toHaveCount(0);
    await expect(supportPage.messageInput).toBeEnabled();

    const { incidentId } = failedResponse.request().postDataJSON();
    const readExchange = async () => {
      const result = await app.database
        .prepare(`SELECT message_id, sequence_number, role, content
          FROM support_messages WHERE incident_id = ? ORDER BY sequence_number`)
        .bind(incidentId)
        .all();
      return result.results;
    };
    expect(await readExchange()).toEqual([]);
    expect(app.modelRequests).toHaveLength(1);
    expect(app.modelRequests[0]).toMatchObject({
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: firstMessage },
      ],
    });

    const recoveredResponse = await supportPage.sendMessage(followUpMessage);
    expect(recoveredResponse.status()).toBe(200);
    expect(await recoveredResponse.json()).toEqual({ message: recoveredReply });
    await expect(supportPage.requestError).toHaveCount(0);
    await expect(supportPage.messageInput).toBeEnabled();
    await expect(supportPage.messages).toHaveCount(4);
    await expect(
      supportPage.messages.filter({ hasText: firstMessage }),
    ).toHaveCount(1);
    await expect(
      supportPage.messages.filter({ hasText: followUpMessage }),
    ).toHaveCount(1);
    await expect(
      supportPage.messages.filter({ hasText: recoveredReply }),
    ).toHaveCount(1);
    await expect(
      supportPage.messages.filter({ hasText: errorMessage }),
    ).toHaveCount(0);

    const expectedHistory = [
      { role: 'user', content: firstMessage },
      { role: 'user', content: followUpMessage },
    ];
    const recoveryRequest = recoveredResponse.request().postDataJSON();
    expect(recoveryRequest.incidentId).toBe(incidentId);
    expect(recoveryRequest.messages).toEqual(expectedHistory);
    expect(app.modelRequests).toHaveLength(2);
    expect(app.modelRequests[1]).toMatchObject({
      messages: [
        expect.objectContaining({ role: 'system' }),
        ...expectedHistory,
      ],
    });
    expect(JSON.stringify(app.modelRequests)).not.toContain(errorMessage);
    expect(JSON.stringify(app.modelRequests)).not.toContain(upstreamError);
    expect(await readExchange()).toEqual([
      {
        message_id: recoveryRequest.messageId,
        sequence_number: 1,
        role: 'user',
        content: followUpMessage,
      },
      {
        message_id: `AST-${recoveryRequest.messageId}`,
        sequence_number: 2,
        role: 'assistant',
        content: recoveredReply,
      },
    ]);
  });
});

test.describe('Markdown rendering', () => {
  // These probes only change the disposable browser page's title if executed.
  const executionMarker = 'unsafe-markdown-executed';
  const markdownReply = [
    '## Formatting sample',
    '',
    'A **verified reply** with *careful handling* and `read-only` context.',
    '',
    '- Check the order number',
    '- Confirm the requested quantity',
    '',
    '| Field | Value |',
    '| --- | --- |',
    '| Channel | Support |',
    '| Access | Read only |',
    '',
    '[Order history](/orders)',
    '',
    `[Unsafe script](javascript:document.title='${executionMarker}')`,
    '',
    `[Unsafe document](data:text/html,%3Cscript%3Edocument.title%3D%27${executionMarker}%27%3C%2Fscript%3E)`,
    '',
    `<script>document.title='${executionMarker}'</script>`,
    '',
    `<img src="data:image/png,invalid" onerror="document.title='${executionMarker}'">`,
    '',
    `<iframe srcdoc="<script>parent.document.title='${executionMarker}'</script>"></iframe>`,
  ].join('\n');

  test.use({ modelReply: markdownReply });

  test('renders formatted replies while blocking executable HTML and unsafe links, including after reload', async ({
    supportPage,
    app,
  }) => {
    const initialTitle = await supportPage.title();
    const prompt = 'Show a formatted support checklist.';
    await supportPage.startIncident();
    const response = await supportPage.sendMessage(prompt);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ message: markdownReply });
    await expect(supportPage.requestError).toHaveCount(0);

    const message = supportPage.messageContaining('Formatting sample');
    const expectSafeRendering = async () => {
      await expect(message.bubble).toHaveCount(1);
      await expect(message.headings).toHaveText(['Formatting sample']);
      await expect(message.strongText).toHaveText(['verified reply']);
      await expect(message.emphasizedText).toHaveText(['careful handling']);
      await expect(message.code).toHaveText(['read-only']);
      await expect(message.listItems).toHaveText([
        'Check the order number',
        'Confirm the requested quantity',
      ]);
      await expect(message.tableHeaders).toHaveText(['Field', 'Value']);
      await expect(message.tableCells).toHaveText([
        'Channel',
        'Support',
        'Access',
        'Read only',
      ]);
      await expect(message.link('Order history')).toHaveAttribute(
        'href',
        '/orders',
      );
      await expect(message.link('Unsafe script')).toHaveAttribute('href', '');
      await expect(message.link('Unsafe document')).toHaveAttribute('href', '');
      await expect(message.embeddedHtml).toHaveCount(0);
      expect(await supportPage.title()).toBe(initialTitle);
      await expect(message.bubble).not.toContainText(executionMarker);
    };
    await expectSafeRendering();

    const { incidentId } = response.request().postDataJSON();
    const readReply = async () => {
      const result = await app.database
        .prepare(`SELECT content FROM support_messages
          WHERE incident_id = ? AND role = 'assistant' ORDER BY sequence_number`)
        .bind(incidentId)
        .all();
      return result.results;
    };
    // The stored reply stays untrusted text; rendering must remain safe on reload.
    expect(await readReply()).toEqual([{ content: markdownReply }]);
    expect(app.modelRequests).toHaveLength(1);

    await supportPage.reload();
    await supportPage.openIncident(prompt);
    await expectSafeRendering();
    expect(await readReply()).toEqual([{ content: markdownReply }]);
    expect(app.modelRequests).toHaveLength(1);
  });
});
