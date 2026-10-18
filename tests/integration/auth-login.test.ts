import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { createSession, getAuthenticatedUser, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ORIGIN = 'http://localhost';
const mara = {
  email: 'mara.venn@calderpike.example',
  password: 'Sable-WHS-0427!',
};
const imani = {
  email: 'imani.kade@meridiancivic.example',
  password: 'Sable-WHS-1098!',
};
const unrecognized = {
  error: 'The supplied access credentials were not recognized.',
};

async function clearQuotas() {
  await (await getDatabase()).prepare('DELETE FROM request_limits').run();
}
beforeEach(clearQuotas);
afterEach(async () => {
  vi.restoreAllMocks();
  await clearQuotas();
});

const loginRequest = (
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
) =>
  new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(credentials),
  });

const sessionRequest = (cookie: string) =>
  new Request(`${ORIGIN}/api/auth/session`, {
    headers: { Cookie: cookie },
  });

async function signIn(
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
) {
  const response = await login(loginRequest(credentials, headers));
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}

const crossOriginHeaders: Record<string, string>[] = [
  { Origin: 'https://attacker.example' },
  { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
];

describe('sign-in route', () => {
  test.for([
    { entity: 'user', blockedStatus: 'suspended' },
    { entity: 'distributor', blockedStatus: 'suspended' },
    { entity: 'distributor', blockedStatus: 'closed' },
  ] as const)(
    'rejects a $entity that is $blockedStatus with the wrong-password response',
    async ({ entity, blockedStatus }, { database, onTestFinished }) => {
      const caseId = `LOGIN-${blockedStatus.toUpperCase()}-${entity.toUpperCase()}`;
      const userId = `USR-${caseId}`;
      const distributorId =
        entity === 'distributor'
          ? `WHS-${caseId}`
          : calderPikeUser.distributorId;
      const credentials = {
        email: `${caseId.toLowerCase()}@tests.example`,
        password: mara.password,
      };
      const sessionCount = async () =>
        (
          await database
            .prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?')
            .bind(userId)
            .first<{ count: number }>()
        )?.count;
      onTestFinished(async () => {
        await database.batch([
          database
            .prepare('DELETE FROM sessions WHERE user_id = ?')
            .bind(userId),
          database
            .prepare('DELETE FROM user_credentials WHERE user_id = ?')
            .bind(userId),
          database.prepare('DELETE FROM users WHERE user_id = ?').bind(userId),
          ...(entity === 'distributor'
            ? [
                database
                  .prepare('DELETE FROM distributors WHERE customer_id = ?')
                  .bind(distributorId),
              ]
            : []),
        ]);
      });
      // Only test-owned accounts change status; seeded accounts stay unchanged.
      await database.batch([
        ...(entity === 'distributor'
          ? [
              database
                .prepare(`INSERT INTO distributors
                  (customer_id, legal_name, display_name, account_tier,
                    account_status, payment_terms, currency, region)
                  VALUES (?, 'Login Test Distribution', 'Login Test',
                    'Standard', ?, 'Net 30', 'USD', 'Test District')`)
                .bind(distributorId, blockedStatus),
            ]
          : []),
        database
          .prepare(`INSERT INTO users
            (user_id, distributor_id, display_name, email, role, status, created_on)
            VALUES (?, ?, 'Login Test User', ?, 'buyer', ?, '2026-09-02')`)
          .bind(
            userId,
            distributorId,
            credentials.email,
            entity === 'user' ? blockedStatus : 'active',
          ),
        // Reuse Mara's credential so the password is known to be correct.
        database
          .prepare(`INSERT INTO user_credentials
            (user_id, password_salt, password_hash, password_iterations,
              password_updated_at)
            SELECT ?, password_salt, password_hash, password_iterations,
              password_updated_at
            FROM user_credentials WHERE user_id = ?`)
          .bind(userId, calderPikeUser.userId),
      ]);

      const denied = await login(loginRequest(credentials));
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual(unrecognized);
      expect(denied.headers.get('Set-Cookie')).toBeNull();
      expect(await sessionCount()).toBe(0);

      // The same credentials work once the account is active again.
      await database
        .prepare(
          entity === 'user'
            ? "UPDATE users SET status = 'active' WHERE user_id = ?"
            : "UPDATE distributors SET account_status = 'active' WHERE customer_id = ?",
        )
        .bind(entity === 'user' ? userId : distributorId)
        .run();
      const cookie = await signIn(credentials);
      expect(
        (await getAuthenticatedUser(database, sessionRequest(cookie)))?.userId,
      ).toBe(userId);
    },
  );

  test('runs the password hash for unknown accounts before returning 401', async () => {
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    const unknown = await login(
      loginRequest({ email: 'nobody@tests.example', password: mara.password }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(unrecognized);
    expect(unknown.headers.get('Set-Cookie')).toBeNull();
    expect(deriveBits).toHaveBeenCalledTimes(1);

    const wrongPassword = await login(
      loginRequest({ email: mara.email, password: 'wrong-password-phrase' }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(unrecognized);
    expect(deriveBits).toHaveBeenCalledTimes(2);
    // Both paths derive with the same work factor as the seeded credentials.
    const [dummyParams, realParams] = deriveBits.mock.calls.map(
      ([params]) => params as Pbkdf2Params,
    );
    expect(dummyParams).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256' });
    expect(dummyParams.iterations).toBe(realParams.iterations);
  });

  test('revokes the presented session when signing in again', async ({
    database,
    onTestFinished,
  }) => {
    const cookies: string[] = [];
    onTestFinished(async () => {
      for (const cookie of cookies)
        await revokeSession(database, sessionRequest(cookie));
    });
    const authenticated = async (cookie: string) =>
      (await getAuthenticatedUser(database, sessionRequest(cookie)))?.userId ??
      null;

    // A session this browser does not present is left alone.
    const unrelated = (
      await createSession(
        database,
        calderPikeUser.userId,
        new Request(`${ORIGIN}/api/auth/login`),
      )
    ).split(';')[0];
    cookies.push(unrelated);
    const first = await signIn(mara);
    cookies.push(first);

    // A failed sign-in does not end the current session.
    const failed = await login(
      loginRequest(
        { email: mara.email, password: 'wrong-password-phrase' },
        { Cookie: first },
      ),
    );
    expect(failed.status).toBe(401);
    expect(await authenticated(first)).toBe(calderPikeUser.userId);

    const second = await signIn(mara, { Cookie: first });
    cookies.push(second);
    expect(second).not.toBe(first);
    expect(await authenticated(first)).toBeNull();
    expect(await authenticated(second)).toBe(calderPikeUser.userId);

    // Switching accounts also ends the presented session.
    const third = await signIn(imani, { Cookie: second });
    cookies.push(third);
    expect(await authenticated(second)).toBeNull();
    expect(await authenticated(third)).toBe('USR-MCS-001');
    expect(await authenticated(unrelated)).toBe(calderPikeUser.userId);
  });

  test.for(crossOriginHeaders)(
    'rejects sign-in from a foreign origin: %o',
    async (headers, { database }) => {
      const sessionsBefore = await database
        .prepare('SELECT session_id FROM sessions ORDER BY session_id')
        .all();
      const response = await login(loginRequest(mara, headers));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Cross-origin access denied.',
      });
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(
        await database
          .prepare('SELECT session_id FROM sessions ORDER BY session_id')
          .all(),
      ).toEqual(sessionsBefore);
    },
  );

  test.for(crossOriginHeaders)(
    'rejects sign-out from a foreign origin: %o',
    async (headers, { database, onTestFinished }) => {
      const cookie = await signIn(mara);
      onTestFinished(() => revokeSession(database, sessionRequest(cookie)));
      const response = await logout(
        new Request(`${ORIGIN}/api/auth/logout`, {
          method: 'POST',
          headers: { Cookie: cookie, ...headers },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Cross-origin access denied.',
      });
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(
        (await getAuthenticatedUser(database, sessionRequest(cookie)))?.userId,
      ).toBe(calderPikeUser.userId);
    },
  );
});
