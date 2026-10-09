import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { DELETE as deleteIncident } from '@/app/api/incidents/route';
import { POST as chat } from '@/app/api/chat/route';
import { getAuthenticatedUser, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { consumeRequestQuota, loginQuotaKey } from '@/db/request-limits';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

async function clearQuotas() {
  await (await getDatabase()).prepare('DELETE FROM request_limits').run();
}
beforeEach(clearQuotas);
afterEach(async () => {
  vi.restoreAllMocks();
  await clearQuotas();
});

const loginRequest = (email: string, password = 'wrong-password-phrase') =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

describe('durable request quotas', () => {
  test('admits exactly the quota under concurrency, expires, and removes old keys', async ({
    database,
  }) => {
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumeRequestQuota(database, 'test:race', 5, 60, now),
      ),
    );
    expect(results.filter((value) => value === 0)).toHaveLength(5);
    expect(results.filter((value) => value === 60)).toHaveLength(7);
    // A separately prepared query observes the persisted quota.
    expect(
      await database
        .prepare('SELECT attempts FROM request_limits WHERE quota_key = ?')
        .bind('test:race')
        .first(),
    ).toEqual({ attempts: 6 });
    expect(
      await consumeRequestQuota(database, 'test:race', 5, 60, now + 59_000),
    ).toBe(1);
    expect(
      await consumeRequestQuota(database, 'test:new', 5, 60, now + 60_000),
    ).toBe(0);
    expect(
      await database
        .prepare('SELECT * FROM request_limits WHERE quota_key = ?')
        .bind('test:race')
        .first(),
    ).toBeNull();
    expect(
      await consumeRequestQuota(database, 'test:race', 5, 60, now + 60_000),
    ).toBe(0);
  });

  test('throttles login attempts across email casing and allows a retry after expiry', async ({
    database,
  }) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const email = 'mara.venn@calderpike.example';
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (await login(loginRequest(attempt % 2 ? email.toUpperCase() : email)))
          .status,
      ).toBe(401);
    }
    const blocked = await login(loginRequest(email, 'Sable-WHS-0427!'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(blocked.headers.get('Set-Cookie')).toBeNull();
    const key = await loginQuotaKey(email);
    expect(key).not.toContain(email);

    now += 60_000;
    const accepted = await login(loginRequest(email, 'Sable-WHS-0427!'));
    expect(accepted.status).toBe(200);
    const request = new Request('http://localhost/api/auth/session', {
      headers: { Cookie: accepted.headers.get('Set-Cookie')!.split(';')[0] },
    });
    try {
      expect((await getAuthenticatedUser(database, request))?.userId).toBe(
        calderPikeUser.userId,
      );
    } finally {
      await revokeSession(database, request);
    }
  });

  test('enforces a global login limit even when every email differs', async () => {
    const results = await Promise.all(
      Array.from({ length: 61 }, (_, index) =>
        login(loginRequest(`unknown-${index}@example.com`)),
      ),
    );
    expect(results.filter((response) => response.status === 401)).toHaveLength(
      60,
    );
    expect(results.filter((response) => response.status === 429)).toHaveLength(
      1,
    );
  });

  test('blocks inference across sessions for one user while preserving saved reply replay and recovery', async ({
    database,
    supportApi,
  }) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let attempt = 0; attempt < 29; attempt++)
      await consumeRequestQuota(
        database,
        `chat:${calderPikeUser.userId}`,
        30,
        60,
        now,
      );
    const session = await supportApi.session(calderPikeUser);
    const anotherSession = await supportApi.session(calderPikeUser);
    const model = supportApi.mockModel(
      'I can help with authorized order details.',
    );
    const incidentId = 'INC-QUOTA-REGRESSION';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const body = {
      expectedRevision: 0,
      incidentId,
      messageId: 'QUOTA-FIRST',
      message: 'Help me trace an order.',
    };
    expect((await chat(session.request(body))).status).toBe(200);
    expect((await chat(anotherSession.request(body))).status).toBe(200);
    const next = { ...body, messageId: 'QUOTA-SECOND', expectedRevision: 1 };
    const blocked = await chat(anotherSession.request(next));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(model).toHaveBeenCalledTimes(1);
    expect((await supportApi.messageContents(incidentId)).results).toHaveLength(
      2,
    );
    now += 60_000;
    expect((await chat(anotherSession.request(next))).status).toBe(200);
    expect(model).toHaveBeenCalledTimes(2);
  });

  test('bounds deletion markers across concurrent sessions and permits retry after expiry', async ({
    database,
    supportApi,
  }) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sessions = [
      await supportApi.session(calderPikeUser),
      await supportApi.session(calderPikeUser),
    ];
    const ids = Array.from(
      { length: 32 },
      (_, index) => `INC-DELETE-QUOTA-${index}`,
    );
    for (const id of ids)
      await supportApi.trackTemporaryIncident(id, calderPikeUser);
    const request = (id: string, index = 0) =>
      new Request('http://localhost/api/incidents', {
        method: 'DELETE',
        headers: sessions[index % sessions.length].request({}).headers,
        body: JSON.stringify({ incidentId: id }),
      });
    const responses = await Promise.all(
      ids.map((id, index) => deleteIncident(request(id, index))),
    );
    expect(
      responses.filter((response) => response.status === 204),
    ).toHaveLength(30);
    const denied = responses.flatMap((response, index) =>
      response.status === 429 ? [index] : [],
    );
    expect(denied).toHaveLength(2);
    for (const index of denied) {
      expect(responses[index].headers.get('Retry-After')).toBe('60');
      expect(
        await database
          .prepare(
            'SELECT 1 FROM support_incident_deletions WHERE incident_id = ?',
          )
          .bind(ids[index])
          .first(),
      ).toBeNull();
    }
    expect(
      await database
        .prepare(
          'SELECT COUNT(*) AS count FROM support_incident_deletions WHERE incident_id LIKE ?',
        )
        .bind('INC-DELETE-QUOTA-%')
        .first(),
    ).toEqual({ count: 30 });
    expect(
      await database
        .prepare('SELECT attempts FROM request_limits WHERE quota_key = ?')
        .bind(`incident-delete:${calderPikeUser.userId}`)
        .first(),
    ).toEqual({ attempts: 31 });

    // One user's allowance cannot exhaust another account's deletion allowance.
    const foreign = await loadActiveUserFixture(database, 'USR-MCS-001');
    const otherSession = await supportApi.session(foreign);
    const otherId = 'INC-DELETE-OTHER-USER';
    await supportApi.trackTemporaryIncident(otherId, foreign);
    expect(
      (
        await deleteIncident(
          new Request('http://localhost/api/incidents', {
            method: 'DELETE',
            headers: otherSession.request({}).headers,
            body: JSON.stringify({ incidentId: otherId }),
          }),
        )
      ).status,
    ).toBe(204);
    now += 60_000;
    expect((await deleteIncident(request(ids[denied[0]]))).status).toBe(204);
    expect(
      await database
        .prepare(
          'SELECT user_id FROM support_incident_deletions WHERE incident_id = ?',
        )
        .bind(ids[denied[0]])
        .first(),
    ).toEqual({ user_id: calderPikeUser.userId });
  });

  test('leaves an incident untouched when deletion quota storage fails', async ({
    database,
    supportApi,
  }) => {
    const session = await supportApi.session(calderPikeUser);
    const incidentId = 'INC-USR-CPD-001-01';
    const before = await supportApi.findIncident(incidentId);
    const messages = (await supportApi.messages(incidentId)).results;
    const batch = vi
      .spyOn(database, 'batch')
      .mockRejectedValueOnce(new Error('private quota failure'));
    try {
      const response = await deleteIncident(
        new Request('http://localhost/api/incidents', {
          method: 'DELETE',
          headers: session.request({}).headers,
          body: JSON.stringify({ incidentId }),
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private quota failure');
      expect(await supportApi.findIncident(incidentId)).toEqual(before);
      expect((await supportApi.messages(incidentId)).results).toEqual(messages);
      expect(
        await database
          .prepare(
            'SELECT 1 FROM support_incident_deletions WHERE incident_id = ?',
          )
          .bind(incidentId)
          .first(),
      ).toBeNull();
    } finally {
      batch.mockRestore();
    }
  });

  test('fails closed when quota storage fails before password verification', async ({
    database,
  }) => {
    const batch = vi
      .spyOn(database, 'batch')
      .mockRejectedValueOnce(new Error('private database failure'));
    try {
      const response = await login(
        loginRequest('mara.venn@calderpike.example', 'Sable-WHS-0427!'),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(await response.text()).not.toContain('private database failure');
    } finally {
      batch.mockRestore();
    }
  });
});
