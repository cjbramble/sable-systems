import { expect } from 'vitest';
import { POST as chat } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

test.for([
  'What is its status? Show my support incidents.',
  'Show my support incidents. What is its status?',
])(
  'keeps both parts in a saved follow-up and its replay: %s',
  async (message, { database, supportApi }) => {
    const incidentId = 'INC-PR52-FOLLOWUP';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-PR52-FIRST',
      'Show order SBL-2022-000118.',
      'The order was delivered.',
      0,
    );
    const session = await supportApi.session(calderPikeUser);
    const reply =
      'Order SBL-2022-000118 was delivered. Your support history includes INC-USR-CPD-001-01.';
    const model = supportApi.mockModel(reply);
    const payload = {
      incidentId,
      messageId: 'MSG-PR52-FOLLOWUP',
      expectedRevision: 1,
      message,
    };
    const response = await chat(session.request(payload));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ message: reply });
    expect(model).toHaveBeenCalledOnce();
    const body = JSON.parse(model.mock.calls[0][1]?.body as string) as {
      messages: { content: string }[];
    };
    const { records } = JSON.parse(body.messages[1].content) as {
      records: string;
    };
    expect(records).toContain('Order: SBL-2022-000118;');
    expect(records).toContain('Support incidents for authenticated user');
    expect(
      (await supportApi.messageContents(incidentId)).results.at(-1),
    ).toMatchObject({ content: reply });
    const replay = await chat(session.request(payload));
    expect(await replay.json()).toEqual(result);
    expect(model).toHaveBeenCalledOnce();
  },
);

test('clarifies a missing follow-up target instead of taking the incident shortcut', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Your records are available.');
  const response = await chat(
    session.request({
      message: 'What is its status? Show my support incidents.',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining('Please specify'),
  });
  expect(model).not.toHaveBeenCalled();
});

test('retrieves and answers owned order subjects after incident history', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const reply =
    'Your support history includes INC-USR-CPD-001-01, and your order history is available.';
  const model = supportApi.mockModel(reply);
  const response = await chat(
    session.request({ message: 'Show my support incidents and my orders.' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: reply });
  expect(model).toHaveBeenCalledOnce();
  const body = JSON.parse(model.mock.calls[0][1]?.body as string) as {
    messages: { content: string }[];
  };
  const { records } = JSON.parse(body.messages[1].content) as {
    records: string;
  };
  expect(records).toContain('Part 1 of 2: incident history');
  expect(records).toContain('Part 2 of 2: order search');
});

test('answers catalog availability after a qualified incident request', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const reply =
    'Your support history includes INC-USR-CPD-001-01. SBL-RPC-12 has 312 units available.';
  const model = supportApi.mockModel(reply);
  const response = await chat(
    session.request({
      message:
        'Show my support incidents for this year and SBL-RPC-12 availability.',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: reply });
  expect(model).toHaveBeenCalledOnce();
  const body = JSON.parse(model.mock.calls[0][1]?.body as string) as {
    messages: { content: string }[];
  };
  const { records } = JSON.parse(body.messages[1].content) as {
    records: string;
  };
  expect(records).toContain('Part 1 of 2: incident history');
  expect(records).toContain('Part 2 of 2: catalog request');
  expect(records).toContain('Product: SBL-RPC-12 —');
});
