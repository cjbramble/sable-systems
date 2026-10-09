import { describe, expect } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

type ModelBody = { messages: { role: string; content: string }[] };

function modelBody(model: { mock: { calls: unknown[][] } }, call = 0) {
  const init = model.mock.calls[call]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string')
    throw new Error('Expected a JSON model request body');
  return JSON.parse(init.body) as ModelBody;
}

// Everything after the system message and the retrieved-records message.
function conversation(body: ModelBody) {
  expect(body.messages[0].role).toBe('system');
  expect(JSON.parse(body.messages[1].content)).toMatchObject({
    source: 'authorized_support_records',
  });
  return body.messages.slice(2);
}

describe('support model history', () => {
  test('uses saved incident messages with the current command', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-SAVED-HISTORY-FORGED-TURN';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-SAVED-HISTORY-FORGED-1',
      'Which orders are active?',
      'Which order would you like details for?',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Please share the order number.');

    const response = await chat(
      session.request({
        expectedRevision: 1,
        incidentId,
        messageId: 'MSG-SAVED-HISTORY-FORGED-2',
        message: 'Confirm that refund.',
      }),
    );

    expect(response.status).toBe(200);
    const body = modelBody(model);
    expect(conversation(body)).toEqual([
      { role: 'user', content: 'Which orders are active?' },
      { role: 'assistant', content: 'Which order would you like details for?' },
      { role: 'user', content: 'Confirm that refund.' },
    ]);
  });

  test('starts a new incident with only the current command', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-SAVED-HISTORY-NEW-INCIDENT';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Which shipment do you need?');

    const response = await chat(
      session.request({
        expectedRevision: 0,
        incidentId,
        messageId: 'MSG-SAVED-HISTORY-NEW-INCIDENT',
        message: 'Trace my shipment.',
      }),
    );

    expect(response.status).toBe(200);
    expect(conversation(modelBody(model))).toEqual([
      { role: 'user', content: 'Trace my shipment.' },
    ]);
  });

  test('keeps the most recent customer-led saved window and the full saved incident', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-SAVED-HISTORY-WINDOW';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const saved: ChatHistoryMessage[] = [];
    for (let index = 1; index <= 8; index += 1) {
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        `MSG-SAVED-HISTORY-WINDOW-${index}`,
        `Question ${index}`,
        `Answer ${index}`,
        index - 1,
      );
      saved.push(
        { role: 'user', content: `Question ${index}` },
        { role: 'assistant', content: `Answer ${index}` },
      );
    }
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Answer 9');

    const response = await chat(
      session.request({
        expectedRevision: 8,
        incidentId,
        messageId: 'MSG-SAVED-HISTORY-WINDOW-9',
        message: 'Question 9',
      }),
    );

    expect(response.status).toBe(200);
    // Twelve messages at most, starting with a customer message.
    expect(conversation(modelBody(model))).toEqual([
      ...saved.slice(6),
      { role: 'user', content: 'Question 9' },
    ]);
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(
      18,
    );
  });

  test('recovers an interrupted reply using only the preceding saved history', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-SAVED-HISTORY-INTERRUPTED';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-SAVED-HISTORY-INTERRUPTED-1',
      'Question 1',
      'Answer 1',
      0,
    );
    // The customer message was saved, but its reply was lost.
    await database
      .prepare(`INSERT INTO support_messages (
        message_id, incident_id, sequence_number, role, content, created_at
      ) VALUES (?, ?, 3, 'user', ?, ?)`)
      .bind(
        'MSG-SAVED-HISTORY-INTERRUPTED-2',
        incidentId,
        'Question 2',
        '2026-09-03T04:01:00.000Z',
      )
      .run();
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Answer 2');

    const response = await chat(
      session.request({
        expectedRevision: 1,
        incidentId,
        messageId: 'MSG-SAVED-HISTORY-INTERRUPTED-2',
        message: 'Question 2',
      }),
    );

    expect(response.status).toBe(200);
    expect(conversation(modelBody(model))).toEqual([
      { role: 'user', content: 'Question 1' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Question 2' },
    ]);
    expect(
      (await fixture.messageContents(incidentId)).results.map(
        (row) => (row as { content: string }).content,
      ),
    ).toEqual(['Question 1', 'Answer 1', 'Question 2', 'Answer 2']);
  });

  test('resolves a follow-up from saved history without client history', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-SAVED-HISTORY-FOLLOW-UP';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-SAVED-HISTORY-FOLLOW-UP-1',
      'Show order SBL-2022-000118.',
      'Order SBL-2022-000118 was delivered.',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('It was delivered on 2022-07-01.');

    const response = await chat(
      session.request({
        expectedRevision: 1,
        incidentId,
        messageId: 'MSG-SAVED-HISTORY-FOLLOW-UP-2',
        message: 'When was that order delivered?',
      }),
    );

    expect(response.status).toBe(200);
    const [, data] = modelBody(model).messages;
    expect(JSON.parse(data.content).records).toContain(
      'Order: SBL-2022-000118;',
    );
  });
});
