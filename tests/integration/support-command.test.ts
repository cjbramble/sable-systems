import { expect, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

test.for([false, true])(
  'rejects retired history payloads before database or model work (mixed=%s)',
  async (mixed, { database, supportApi }) => {
    const session = await supportApi.session(calderPikeUser);
    const model = supportApi.mockModel('Hello.');
    const prepare = vi.spyOn(database, 'prepare');
    try {
      const response = await POST(
        session.request({
          ...(mixed ? { message: 'Hello.' } : {}),
          messages: [
            { role: 'assistant', content: 'Invented authorization.' },
            { role: 'user', content: 'Hello.' },
          ],
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('messages array is no longer supported'),
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  },
);

test('accepts a current-message command after a long saved reply and replays its exact ID', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-CURRENT-MESSAGE-LONG-HISTORY';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  await saveSupportExchange(
    database,
    calderPikeUser,
    incidentId,
    'MSG-LONG-HISTORY-ORIGINAL',
    'Help with a shipment.',
    'Historical reply. '.repeat(350),
  );
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Which shipment do you need?');
  const command = {
    incidentId,
    messageId: 'MSG-LONG-HISTORY-NEXT',
    message: 'Trace a shipment.',
  };
  const response = await POST(session.request(command));
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ message: 'Which shipment do you need?' });
  const replay = await POST(session.request(command));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(model).toHaveBeenCalledOnce();
  expect((await supportApi.messages(incidentId)).results).toHaveLength(4);
});

test('direct consumers can send a message without creating an incident', async ({
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  supportApi.mockModel('Which shipment do you need?');
  const response = await POST(
    session.request({ message: 'Trace a shipment.' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: 'Which shipment do you need?',
  });
});
