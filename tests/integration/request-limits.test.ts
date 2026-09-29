import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as chat } from '@/app/api/chat/route';
import { getAuthenticatedUser, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { consumeRequestQuota, loginQuotaKey } from '@/db/request-limits';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

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
      incidentId,
      messageId: 'QUOTA-FIRST',
      messages: [{ role: 'user', content: 'Help me trace an order.' }],
    };
    expect((await chat(session.request(body))).status).toBe(200);
    expect((await chat(anotherSession.request(body))).status).toBe(200);
    const next = { ...body, messageId: 'QUOTA-SECOND' };
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
