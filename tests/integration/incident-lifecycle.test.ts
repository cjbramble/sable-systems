import { expect, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { DELETE } from '@/app/api/incidents/route';
import {
  deleteSupportIncident,
  getSupportIncidentState,
  listSupportIncidents,
  saveSupportExchange,
} from '@/db/incidents';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

function gate() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    arrived.resolve();
    released.resolve();
  }, 2_000);
  return {
    arrived,
    released,
    get timedOut() {
      return timedOut;
    },
    close() {
      clearTimeout(timer);
      released.resolve();
    },
  };
}

test('deletion during inference prevents resurrection and rejects stale retries', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-DELETE-IN-FLIGHT';
  const messageId = 'MSG-LIFECYCLE-DELETE-IN-FLIGHT';
  const prompt = 'Help with a shipment.';
  const reply = 'Which shipment do you need help with?';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  await saveSupportExchange(
    database,
    calderPikeUser,
    incidentId,
    'MSG-LIFECYCLE-DELETE-SETUP',
    'Hello.',
    'How can I help?',
    0,
  );
  const hold = gate();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      hold.arrived.resolve();
      await hold.released.promise;
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: reply } }],
      });
    });
  const pending = POST(
    session.request({
      expectedRevision: 1,
      incidentId,
      messageId,
      message: prompt,
    }),
  );
  try {
    await hold.arrived.promise;
    expect(hold.timedOut).toBe(false);
    expect((await supportApi.messages(incidentId)).results).toHaveLength(2);
    const deleteBody = session.request({ incidentId });
    const deleted = await DELETE(
      new Request('http://localhost/api/incidents', {
        method: 'DELETE',
        headers: deleteBody.headers,
        body: await deleteBody.text(),
      }),
    );
    expect(deleted.status).toBe(204);
    expect(await supportApi.findIncident(incidentId)).toBeNull();
    expect((await supportApi.messages(incidentId)).results).toEqual([]);
    hold.released.resolve();
    const response = await pending;
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'incident_deleted' });
    for (const retryId of [messageId, 'MSG-LIFECYCLE-NEW-RETRY']) {
      const retry = await POST(
        session.request({
          expectedRevision: 1,
          incidentId,
          messageId: retryId,
          message: prompt,
        }),
      );
      expect(retry.status).toBe(410);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await supportApi.findIncident(incidentId)).toBeNull();
    expect((await supportApi.messages(incidentId)).results).toEqual([]);
    expect(
      await database
        .prepare(
          'SELECT * FROM support_incident_deletions WHERE incident_id = ?',
        )
        .bind(incidentId)
        .first(),
    ).toEqual({ incident_id: incidentId, user_id: calderPikeUser.userId });
    expect(hold.timedOut).toBe(false);
  } finally {
    hold.close();
    await Promise.allSettled([pending]);
    fetchMock.mockRestore();
  }
});

for (const duplicate of [false, true]) {
  test(`delayed ${duplicate ? 'duplicate' : 'distinct'} save preserves the latest saved activity`, async ({
    database,
    supportApi,
  }) => {
    const incidentId = `INC-LIFECYCLE-TIMESTAMP-${duplicate ? 'DUPLICATE' : 'DISTINCT'}`;
    const firstId = 'MSG-LIFECYCLE-TIMESTAMP-FIRST';
    const secondId = duplicate ? firstId : 'MSG-LIFECYCLE-TIMESTAMP-SECOND';
    const earlier = '2030-01-01T00:00:01.000Z';
    const later = '2030-01-01T00:00:02.000Z';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-LIFECYCLE-TIMESTAMP-SETUP',
      'Hello.',
      'How can I help?',
      0,
    );
    const hold = gate();
    const originalBatch = database.batch.bind(database);
    let calls = 0;
    const batchMock = vi
      .spyOn(database, 'batch')
      .mockImplementation(async (statements) => {
        if (++calls === 1) {
          hold.arrived.resolve();
          await hold.released.promise;
        }
        return originalBatch(statements);
      });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlier);
    const pending = saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      firstId,
      'Help with a shipment.',
      'First generated reply.',
      1,
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      await hold.arrived.promise;
      expect(hold.timedOut).toBe(false);
      vi.setSystemTime(later);
      const winner = await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        secondId,
        'Help with a shipment.',
        'Second generated reply.',
        1,
      );
      expect(winner.incidentUpdatedAt).toBe(later);
      hold.released.resolve();
      if (duplicate) {
        expect(await outcome).toEqual(winner);
      } else {
        expect(await outcome).toMatchObject({
          name: 'SupportRevisionConflictError',
        });
      }
      expect(await supportApi.findIncident(incidentId)).toMatchObject({
        updated_at: later,
        revision: 2,
      });
      const rows = (await supportApi.messages(incidentId)).results;
      expect(rows).toHaveLength(4);
      expect(rows.some((row) => row.created_at === later)).toBe(true);
      expect(winner.message).toBe('Second generated reply.');
      expect(winner.customerCreatedAt).toBe(later);
      expect(hold.timedOut).toBe(false);
    } finally {
      hold.close();
      await Promise.allSettled([pending]);
      batchMock.mockRestore();
      vi.useRealTimers();
    }
  });
}

for (const existing of [false, true]) {
  test(`deletion before a ${existing ? 'continued' : 'first'} exchange commits stays deleted`, async ({
    database,
    supportApi,
  }) => {
    const incidentId = `INC-LIFECYCLE-COMMIT-${existing}`;
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    if (existing)
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-LIFECYCLE-SETUP',
        'Hello.',
        'How can I help?',
        0,
      );
    const hold = gate();
    const originalBatch = database.batch.bind(database);
    const batchMock = vi
      .spyOn(database, 'batch')
      .mockImplementationOnce(async (statements) => {
        hold.arrived.resolve();
        await hold.released.promise;
        return originalBatch(statements);
      });
    const pending = saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-LIFECYCLE-COMMIT',
      'Shipment help.',
      'Please provide the shipment.',
      existing ? 1 : 0,
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      await hold.arrived.promise;
      expect(hold.timedOut).toBe(false);
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      hold.released.resolve();
      expect(await outcome).toMatchObject({ name: 'IncidentDeletedError' });
      expect(await supportApi.findIncident(incidentId)).toBeNull();
      expect((await supportApi.messages(incidentId)).results).toEqual([]);
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      expect(
        await database
          .prepare(
            'SELECT COUNT(*) AS count FROM support_incident_deletions WHERE incident_id = ?',
          )
          .bind(incidentId)
          .first(),
      ).toEqual({ count: 1 });
    } finally {
      hold.close();
      await outcome;
      batchMock.mockRestore();
    }
  });
}

test('a later duplicate leaves activity and title unchanged', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-DUPLICATE';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime('2030-01-01T00:00:01.000Z');
    const saved = await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-LIFECYCLE-DUPLICATE',
      'Hello.',
      'First reply.',
      0,
    );
    const before = await supportApi.findIncident(incidentId);
    vi.setSystemTime('2030-01-01T00:00:02.000Z');
    expect(
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-LIFECYCLE-DUPLICATE',
        'Hello.',
        'Duplicate reply.',
        0,
      ),
    ).toEqual(saved);
    expect(await supportApi.findIncident(incidentId)).toEqual(before);
  } finally {
    vi.useRealTimers();
  }
});

test('recovering an incomplete exchange advances activity across legacy timestamp formats', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-RECOVER';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  await database.batch([
    database
      .prepare(
        'INSERT INTO support_incidents (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        incidentId,
        calderPikeUser.userId,
        'New service incident',
        '2030-01-01T00:00:00Z',
        '2030-01-01T00:00:00Z',
      ),
    database
      .prepare(
        'INSERT INTO support_messages (message_id, incident_id, sequence_number, role, content, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      )
      .bind(
        'MSG-LIFECYCLE-RECOVER',
        incidentId,
        'user',
        'Shipment help.',
        '2030-01-01T00:00:00Z',
      ),
  ]);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime('2030-01-01T00:00:00.100Z');
    const result = await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-LIFECYCLE-RECOVER',
      'Shipment help.',
      'Please provide the shipment.',
      0,
    );
    expect(result.incidentUpdatedAt).toBe('2030-01-01T00:00:00.100Z');
    expect(result.customerCreatedAt).toBe('2030-01-01T00:00:00Z');
    expect(await supportApi.findIncident(incidentId)).toMatchObject({
      title: 'Shipment help.',
    });
    expect((await supportApi.messages(incidentId)).results).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test('foreign users cannot delete, claim, or inspect owned and deleted identities', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-OWNER';
  const foreign = await loadActiveUserFixture(database, 'USR-MCS-001');
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  expect(
    await getSupportIncidentState(database, calderPikeUser, incidentId),
  ).toBe('new');
  await saveSupportExchange(
    database,
    calderPikeUser,
    incidentId,
    'MSG-LIFECYCLE-OWNER',
    'Hello.',
    'Hi.',
    0,
  );
  const before = await supportApi.findIncident(incidentId);
  expect(
    await getSupportIncidentState(database, calderPikeUser, incidentId),
  ).toBe('owned');
  await deleteSupportIncident(database, foreign, incidentId);
  expect(await supportApi.findIncident(incidentId)).toEqual(before);
  expect(
    await database
      .prepare('SELECT 1 FROM support_incident_deletions WHERE incident_id = ?')
      .bind(incidentId)
      .first(),
  ).toBeNull();
  await deleteSupportIncident(database, calderPikeUser, incidentId);
  await deleteSupportIncident(database, foreign, incidentId);
  expect(await getSupportIncidentState(database, foreign, incidentId)).toBe(
    'forbidden',
  );
  expect(
    await getSupportIncidentState(database, calderPikeUser, incidentId),
  ).toBe('deleted');
  await expect(
    saveSupportExchange(
      database,
      foreign,
      incidentId,
      'MSG-LIFECYCLE-FOREIGN',
      'Hello.',
      'Hi.',
      0,
    ),
  ).rejects.toMatchObject({ name: 'IncidentAccessDeniedError' });
  const session = await supportApi.session(foreign);
  const response = await POST(
    session.request({
      expectedRevision: 0,
      incidentId,
      messageId: 'MSG-LIFECYCLE-FOREIGN',
      message: 'Hello.',
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    code: 'request_not_saved',
    error: 'Incident access denied.',
  });
});

test('a failed content deletion rolls back its marker and remains writable', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-ROLLBACK';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  await saveSupportExchange(
    database,
    calderPikeUser,
    incidentId,
    'MSG-LIFECYCLE-ROLLBACK',
    'Hello.',
    'Hi.',
    0,
  );
  const before = await supportApi.findIncident(incidentId);
  const messages = await supportApi.messages(incidentId);
  await database
    .prepare(`CREATE TRIGGER fail_incident_delete BEFORE DELETE ON support_incidents
    WHEN OLD.incident_id = 'INC-LIFECYCLE-ROLLBACK'
    BEGIN SELECT RAISE(ABORT, 'delete interrupted'); END`)
    .run();
  try {
    await expect(
      deleteSupportIncident(database, calderPikeUser, incidentId),
    ).rejects.toThrow(/delete interrupted/);
    expect(await supportApi.findIncident(incidentId)).toEqual(before);
    expect((await supportApi.messages(incidentId)).results).toEqual(
      messages.results,
    );
    expect(
      await getSupportIncidentState(database, calderPikeUser, incidentId),
    ).toBe('owned');
  } finally {
    await database.prepare('DROP TRIGGER fail_incident_delete').run();
  }
  await deleteSupportIncident(database, calderPikeUser, incidentId);
  expect(
    await getSupportIncidentState(database, calderPikeUser, incidentId),
  ).toBe('deleted');
});

test('history sorts legacy and current timestamp formats chronologically', async ({
  database,
  supportApi,
}) => {
  const earlierId = 'INC-LIFECYCLE-SORT-EARLIER';
  const laterId = 'INC-LIFECYCLE-SORT-LATER';
  for (const [id, time] of [
    [earlierId, '2030-01-01T00:00:00Z'],
    [laterId, '2030-01-01T00:00:00.100Z'],
  ]) {
    await supportApi.trackTemporaryIncident(id, calderPikeUser);
    await database
      .prepare(
        'INSERT INTO support_incidents (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, calderPikeUser.userId, id, time, time)
      .run();
  }
  const ids = (await listSupportIncidents(database, calderPikeUser)).map(
    (incident) => incident.id,
  );
  expect(ids.indexOf(laterId)).toBeLessThan(ids.indexOf(earlierId));
});

test('deletion before reading the saved winner returns the deleted outcome', async ({
  database,
  supportApi,
}) => {
  const incidentId = 'INC-LIFECYCLE-READ-WINNER';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const prepare = database.prepare.bind(database);
  const prepareMock = vi
    .spyOn(database, 'prepare')
    .mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes('customer.content AS customerMessage'))
        return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, 'bind').mockImplementation((...params) => {
        const bound = bind(...params);
        const first = bound.first.bind(bound);
        vi.spyOn(bound, 'first').mockImplementationOnce(async () => {
          await deleteSupportIncident(database, calderPikeUser, incidentId);
          return first();
        });
        return bound;
      });
      return statement;
    });
  try {
    await expect(
      saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-LIFECYCLE-READ-WINNER',
        'Shipment help.',
        'Which shipment?',
        0,
      ),
    ).rejects.toMatchObject({ name: 'IncidentDeletedError' });
    expect(await supportApi.findIncident(incidentId)).toBeNull();
  } finally {
    prepareMock.mockRestore();
  }
});
