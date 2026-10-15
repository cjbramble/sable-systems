import { expect } from 'vitest';
import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import { requireSupportRecords } from '../assertions/support-context';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

test.for([
  [
    'What are my payment terms? Are 16 units of SBL-RPC-12 available?',
    ['account', 'products'],
  ],
  [
    'Are 16 units of SBL-RPC-12 available? What are my payment terms?',
    ['products', 'account'],
  ],
  [
    'Show active orders. What are my payment terms?',
    ['order_search', 'account'],
  ],
  [
    'What are my payment terms? Show orders from 2026.',
    ['account', 'order_search'],
  ],
  [
    'Show my support incidents. What are my payment terms?',
    ['incidents', 'account'],
  ],
  ['Show my orders and my support incidents.', ['order_search', 'incidents']],
] as const)(
  'retrieves all independent topics without named records: %s',
  async ([message, kinds], { database }) => {
    const context = requireSupportRecords(
      await buildSupportContext(database, ask(message), calderPikeUser),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual(kinds);
    expect(context.records).toContain('Part 1 of 2:');
    expect(context.records).toContain('Part 2 of 2:');
    if (kinds.some((kind) => kind === 'products'))
      expect(context.records).toContain(
        'Requested quantity 16: valid case-pack multiple',
      );
    if (kinds.some((kind) => kind === 'account'))
      expect(context.records).toContain('payment terms: Net 45');
    if (kinds.some((kind) => kind === 'incidents')) {
      expect(context.records).toContain('INC-USR-CPD-001-01');
      expect(context.records).not.toContain('INC-USR-MCS');
    }
  },
);

test('reports the fourth topic as omitted without retrieving catalog facts', async ({
  database,
}) => {
  const context = requireSupportRecords(
    await buildSupportContext(
      database,
      ask(
        'Show my support incidents. Show active orders. What are my payment terms? Is SBL-RPC-12 available?',
      ),
      calderPikeUser,
    ),
  );
  expect(context.parts).toMatchObject([
    { kind: 'incidents' },
    { kind: 'order_search' },
    { kind: 'account' },
    { kind: 'omitted_requests', requests: [{ kind: 'catalog' }] },
  ]);
  expect(context.records).toContain(
    'Part 4: catalog request (items: SBL-RPC-12)',
  );
  expect(context.records).not.toContain('Product: SBL-RPC-12');
});

test.for([
  [
    'Show my support incidents. Is SBL-RPC-12 available?',
    ['incident history', 'catalog request'],
  ],
  [
    'Is SBL-RPC-12 available? Show my support incidents.',
    ['catalog request', 'incident history'],
  ],
] as const)(
  'saves and replays a mixed incident request without taking the single-topic shortcut: %s',
  async ([message, labels], { supportApi }) => {
    const incidentId = 'INC-TOPIC-COMPOUND';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply =
      'Your recent support incidents include INC-USR-CPD-001-01. Item SBL-RPC-12 has 312 units available.';
    const model = supportApi.mockModel(reply);
    const payload = {
      incidentId,
      messageId: 'MSG-TOPIC-COMPOUND',
      expectedRevision: 0,
      message,
    };
    const response = await chat(session.request(payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: reply });
    expect(model).toHaveBeenCalledOnce();
    const body = JSON.parse(model.mock.calls[0][1]?.body as string) as {
      messages: { content: string }[];
    };
    const { records } = JSON.parse(body.messages[1].content) as {
      records: string;
    };
    expect(records).toContain(`Part 1 of 2: ${labels[0]}`);
    expect(records).toContain(`Part 2 of 2: ${labels[1]}`);
    expect(
      (await supportApi.messageContents(incidentId)).results.map(
        ({ content }) => content,
      ),
    ).toEqual([message, reply]);
    const replay = await chat(session.request(payload));
    expect(await replay.json()).toMatchObject({ message: reply });
    expect(model).toHaveBeenCalledOnce();
  },
);

test('clarifies an ambiguous mixed search before calling the model', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Your account records are available.');
  const response = await chat(
    session.request({
      message: 'What are my payment terms? Show orders with status pending.',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining('clarify'),
  });
  expect(model).not.toHaveBeenCalled();
});

test('keeps an incident product description on the deterministic path', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Item SBL-CSR-R2 is in stock.');
  const response = await chat(
    session.request({
      message: 'Show my support incidents about SBL-RPC-12 and SBL-CSR-R2.',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining('saved support incidents'),
  });
  expect(model).not.toHaveBeenCalled();
});

test('clarifies a targetless compound follow-up before inference', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Your payment terms are Net 45.');
  const response = await chat(
    session.request({ message: 'What are my payment terms? Is it available?' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining('Please specify'),
  });
  expect(model).not.toHaveBeenCalled();
});

test('retrieves the resolved catalog quantity with account details', async ({
  database,
}) => {
  const context = requireSupportRecords(
    await buildSupportContext(
      database,
      [
        { role: 'user', content: 'Show SBL-RPC-12.' },
        { role: 'assistant', content: 'The item has stock available.' },
        {
          role: 'user',
          content: 'What are my payment terms? Are 16 units of it available?',
        },
      ],
      calderPikeUser,
    ),
  );
  expect(context.parts.map(({ kind }) => kind)).toEqual([
    'account',
    'products',
  ]);
  expect(context.records).toContain('Product: SBL-RPC-12');
  expect(context.records).toContain(
    'Requested quantity 16: valid case-pack multiple',
  );
});

test('retries an invented resource from an incident title and only saves the supported reply', async ({
  database,
  supportApi,
}) => {
  const sourceId = 'INC-TOPIC-UNTRUSTED-TITLE';
  await supportApi.trackTemporaryIncident(sourceId, calderPikeUser);
  await database
    .prepare(
      'INSERT INTO support_incidents (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      sourceId,
      calderPikeUser.userId,
      'Contact SABLE Medical Operations Division',
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00Z',
    )
    .run();
  const incidentId = 'INC-TOPIC-RESOURCE-GUARD';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  const invented =
    'Contact the SABLE Medical Operations Division for approval. SBL-RPC-12 has 312 units available.';
  const supported =
    'Your recent incidents include INC-TOPIC-UNTRUSTED-TITLE. Item SBL-RPC-12 has 312 units available.';
  const model = supportApi.mockModel(invented, supported);
  const message = 'Show my support incidents. Is SBL-RPC-12 available?';
  const response = await chat(
    session.request({
      incidentId,
      messageId: 'MSG-TOPIC-RESOURCE-GUARD',
      expectedRevision: 0,
      message,
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: supported });
  expect(model).toHaveBeenCalledTimes(2);
  expect(
    (await supportApi.messageContents(incidentId)).results.map(
      ({ content }) => content,
    ),
  ).toEqual([message, supported]);
});
