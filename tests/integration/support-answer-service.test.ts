import { expect, vi } from 'vitest';
import { answerSupportMessage } from '@/lib/answer-support-message';
import { saveSupportExchange } from '@/db/incidents';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

function modelReply(content: string) {
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { content } }],
  });
}

async function quota(database: D1Database) {
  return database
    .prepare('SELECT attempts FROM request_limits WHERE quota_key = ?')
    .bind(`chat:${calderPikeUser.userId}`)
    .first<number>('attempts');
}

test('supports direct service calls, corrective generation, and exact replay with one quota charge', async ({
  database,
  supportApi,
}) => {
  await supportApi.session(calderPikeUser);
  const command = {
    incidentId: 'INC-SERVICE-REPLAY',
    messageId: 'MSG-SERVICE-REPLAY',
    expectedRevision: 0,
    message: 'Show order SBL-2022-000118.',
  };
  await supportApi.trackTemporaryIncident(command.incidentId, calderPikeUser);
  const model = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      modelReply('Contact the SABLE Systems returns specialist.'),
    )
    .mockResolvedValueOnce(modelReply('Order SBL-2022-000118 was delivered.'));
  const result = await answerSupportMessage(
    database,
    calderPikeUser,
    command,
    model,
  );
  expect(result).toMatchObject({
    kind: 'answered',
    reply: { message: 'Order SBL-2022-000118 was delivered.', revision: 1 },
  });
  expect(model).toHaveBeenCalledTimes(2);
  expect(await quota(database)).toBe(1);
  expect(
    await answerSupportMessage(database, calderPikeUser, command, model),
  ).toEqual(result);
  expect(model).toHaveBeenCalledTimes(2);
  expect(await quota(database)).toBe(1);
  expect(
    (await supportApi.messageContents(command.incidentId)).results,
  ).toHaveLength(2);
});

test('keeps invalid model output unsaved when reused outside the HTTP route', async ({
  database,
  supportApi,
}) => {
  await supportApi.session(calderPikeUser);
  const command = {
    incidentId: 'INC-SERVICE-INVALID',
    messageId: 'MSG-SERVICE-INVALID',
    expectedRevision: 0,
    message: 'Show order SBL-2022-000118.',
  };
  await supportApi.trackTemporaryIncident(command.incidentId, calderPikeUser);
  const model = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      modelReply('Contact the SABLE Systems returns specialist.'),
    );
  expect(
    await answerSupportMessage(database, calderPikeUser, command, model),
  ).toMatchObject({
    kind: 'failed',
    reason: 'invalid_reply',
    failure: { code: 'request_not_saved' },
  });
  expect(model).toHaveBeenCalledTimes(2);
  expect(await quota(database)).toBe(1);
  expect(await supportApi.findIncident(command.incidentId)).toBeNull();
});

test('enforces incident ownership within the service before replay or inference', async ({
  database,
  supportApi,
}) => {
  await supportApi.session(calderPikeUser);
  const otherId = await database
    .prepare(
      'SELECT user_id FROM users WHERE user_id != ? AND status = ? LIMIT 1',
    )
    .bind(calderPikeUser.userId, 'active')
    .first<string>('user_id');
  if (!otherId) throw new Error('Missing other-user fixture');
  const owner = await loadActiveUserFixture(database, otherId);
  const command = {
    incidentId: 'INC-SERVICE-OTHER-OWNER',
    messageId: 'MSG-SERVICE-OTHER-OWNER',
    expectedRevision: 0,
    message: 'Help with an order.',
  };
  await supportApi.trackTemporaryIncident(command.incidentId, owner);
  await saveSupportExchange(
    database,
    owner,
    command.incidentId,
    command.messageId,
    command.message,
    'Private reply.',
    0,
  );
  const model = vi.fn<typeof fetch>();
  expect(
    await answerSupportMessage(database, calderPikeUser, command, model),
  ).toEqual({
    kind: 'failed',
    reason: 'access_denied',
    failure: { error: 'Incident access denied.', code: 'request_not_saved' },
  });
  expect(model).not.toHaveBeenCalled();
  expect(await quota(database)).toBeNull();
});

test('answers unavailable records directly without model quota', async ({
  database,
  supportApi,
}) => {
  await supportApi.session(calderPikeUser);
  const model = vi.fn<typeof fetch>();
  expect(
    await answerSupportMessage(
      database,
      calderPikeUser,
      { message: 'Show order SBL-2099-999999.' },
      model,
    ),
  ).toMatchObject({
    kind: 'answered',
    reply: { message: expect.stringContaining('cannot locate') },
  });
  expect(model).not.toHaveBeenCalled();
  expect(await quota(database)).toBeNull();
});
