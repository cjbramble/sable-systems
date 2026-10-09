import { expect, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import { parseSupportReply } from '@/lib/chat-request';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

test('stale commands consume no model quota, while completed retries retain their original revision', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-REVISION-REPLAY';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Which shipment do you need?');
  const command = {
    incidentId,
    messageId: 'MSG-REVISION-FIRST',
    message: 'Help with a shipment.',
    expectedRevision: 0,
  };
  const first = await POST(session.request(command));
  expect(first.status).toBe(200);
  const receipt = parseSupportReply(await first.json());
  expect(receipt).not.toBeNull();
  expect(receipt!.revision).toBe(1);
  const second = await POST(
    session.request({
      ...command,
      messageId: 'MSG-REVISION-SECOND',
      expectedRevision: 1,
    }),
  );
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ revision: 2 });
  const before = await supportApi.messages(incidentId);
  const quota = await database
    .prepare('SELECT * FROM request_limits WHERE quota_key = ?')
    .bind(`chat:${calderPikeUser.userId}`)
    .first();
  const stale = await POST(
    session.request({ ...command, messageId: 'MSG-REVISION-STALE' }),
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'incident_changed' });
  const replay = await POST(session.request(command));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    message: receipt!.message,
    customerCreatedAt: receipt!.customerCreatedAt,
    assistantCreatedAt: receipt!.assistantCreatedAt,
    revision: 1,
  });
  expect(model).toHaveBeenCalledTimes(2);
  expect(await supportApi.messages(incidentId)).toEqual(before);
  expect(
    await database
      .prepare('SELECT * FROM request_limits WHERE quota_key = ?')
      .bind(`chat:${calderPikeUser.userId}`)
      .first(),
  ).toEqual(quota);
  expect(await supportApi.findIncident(incidentId)).toMatchObject({
    revision: 2,
  });
});

test('a nonzero revision cannot create a new incident', async ({
  supportApi,
}) => {
  const incidentId = 'INC-REVISION-ABSENT';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Which shipment do you need?');
  const response = await POST(
    session.request({
      incidentId,
      messageId: 'MSG-REVISION-ABSENT',
      message: 'Help with a shipment.',
      expectedRevision: 1,
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'incident_changed' });
  expect(model).not.toHaveBeenCalled();
  expect(await supportApi.findIncident(incidentId)).toBeNull();
});

test('an exact retry replays a winner committed between its saved-reply and revision reads', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-REVISION-PREFLIGHT-RACE';
  const messageId = 'MSG-REVISION-PREFLIGHT-RACE';
  const message = 'Help with a shipment.';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Unexpected second generation.');
  const prepare = database.prepare.bind(database);
  let intercepted = false;
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (!intercepted && /SELECT revision FROM support_incidents/.test(sql)) {
      intercepted = true;
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        const first = bound.first.bind(bound);
        bound.first = (async (...columns: Parameters<typeof first>) => {
          await saveSupportExchange(
            database,
            calderPikeUser,
            incidentId,
            messageId,
            message,
            'The persisted winner.',
            0,
          );
          return first(...columns);
        }) as typeof bound.first;
        return bound;
      };
      return statement;
    }
    return prepare(sql);
  });
  try {
    const response = await POST(
      session.request({ incidentId, messageId, message, expectedRevision: 0 }),
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: 'The persisted winner.',
      revision: 1,
    });
    expect(model).not.toHaveBeenCalled();
    expect((await supportApi.messages(incidentId)).results).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

test('repairing a historical reply hole advances revision and stale repairs cannot write', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-REVISION-HOLE';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  await database.batch([
    database
      .prepare(`INSERT INTO support_incidents
      (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(
        incidentId,
        calderPikeUser.userId,
        'Historical incident',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      ),
    database
      .prepare(`INSERT INTO support_messages
      (message_id, incident_id, sequence_number, role, content, created_at) VALUES (?, ?, 1, 'user', ?, ?)`)
      .bind(
        'MSG-REVISION-HOLE',
        incidentId,
        'Help with a shipment.',
        '2026-01-01T00:00:00Z',
      ),
    database
      .prepare(`INSERT INTO support_messages
      (message_id, incident_id, sequence_number, role, content, created_at) VALUES (?, ?, 3, 'user', ?, ?)`)
      .bind(
        'MSG-REVISION-LATER',
        incidentId,
        'A later historical question.',
        '2026-01-01T00:00:00Z',
      ),
  ]);
  await saveSupportExchange(
    database,
    calderPikeUser,
    incidentId,
    'MSG-REVISION-LATER',
    'A later historical question.',
    'A later answer.',
    0,
  );
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Which shipment do you need?');
  const command = {
    incidentId,
    messageId: 'MSG-REVISION-HOLE',
    message: 'Help with a shipment.',
    expectedRevision: 0,
  };
  const stale = await POST(session.request(command));
  expect(stale.status).toBe(409);
  expect(model).not.toHaveBeenCalled();
  const repaired = await POST(
    session.request({ ...command, expectedRevision: 1 }),
  );
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({ revision: 2 });
  expect(await supportApi.findIncident(incidentId)).toMatchObject({
    revision: 2,
  });
  expect(
    (await supportApi.messages(incidentId)).results.map((row) => [
      row.sequence_number,
      row.revision,
    ]),
  ).toEqual([
    [1, 0],
    [2, 2],
    [3, 0],
    [4, 1],
  ]);
});
