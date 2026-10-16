import { POST as logout } from '@/app/api/auth/logout/route';
import { test } from '../fixtures/support-integration';
import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { createSession, getAuthenticatedUser, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import {
  createSupportApiFixture,
  type SupportApiSession,
} from '../fixtures/support-api';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('session lifecycle and authenticated replay', () => {
  it.each(['revoked', 'expired'])(
    'denies replay from %s sessions without calling the model or changing history',
    async (sessionState) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-${sessionState.toUpperCase()}-SESSION-REPLAY`;
      const messageId = `MSG-${sessionState.toUpperCase()}-SESSION-REPLAY`;
      const customerMessage = 'Show return RTN-2022-000014.';
      const privateReply =
        'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
      const makeRequest = (session: SupportApiSession) =>
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId,
          message: customerMessage,
        });
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        if (sessionState === 'expired') {
          // Freeze only Date: database I/O and timers continue running normally.
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
        }
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(
          'This reply must not be generated.',
        );
        await saveSupportExchange(
          database,
          calderPikeUser,
          incidentId,
          messageId,
          customerMessage,
          privateReply,
          0,
        );
        const savedIncident = await fixture.findIncident(incidentId);
        const savedMessages = await fixture.messages(incidentId);
        expect(savedIncident).toMatchObject({ user_id: calderPikeUser.userId });
        expect(savedMessages.results).toHaveLength(2);

        // The 12-hour session remains valid until just before its expiry boundary.
        if (sessionState === 'expired')
          vi.setSystemTime(new Date('2026-09-02T23:59:59.999Z'));
        const beforeInvalidation = await POST(makeRequest(session));
        expect(beforeInvalidation.status).toBe(200);
        expect(await beforeInvalidation.json()).toMatchObject({
          message: privateReply,
        });
        expect(fetchMock).not.toHaveBeenCalled();

        if (sessionState === 'expired')
          vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
        else await revokeSession(database, makeRequest(session));
        // Keep sending the original cookie after revocation or expiration.
        for (let retry = 0; retry < 2; retry += 1) {
          const denied = await POST(makeRequest(session));
          expect(denied.status).toBe(401);
          expect(await denied.json()).toEqual({
            code: 'request_not_saved',
            error: 'Authentication required.',
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
          expect((await fixture.messages(incidentId)).results).toEqual(
            savedMessages.results,
          );
        }

        // A fresh session for the same owner can still retrieve the intact reply.
        const freshSession = await fixture.session(calderPikeUser);
        const recovered = await POST(makeRequest(freshSession));
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toMatchObject({ message: privateReply });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
        expect((await fixture.messages(incidentId)).results).toEqual(
          savedMessages.results,
        );
      } finally {
        if (sessionState === 'expired') vi.useRealTimers();
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );

  it.each([
    { entity: 'user', blockedStatus: 'suspended' },
    { entity: 'distributor', blockedStatus: 'suspended' },
    { entity: 'distributor', blockedStatus: 'closed' },
  ] as const)(
    'denies saved reply access when a $entity is $blockedStatus despite a valid session',
    async ({ entity, blockedStatus }) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const caseId = `${blockedStatus.toUpperCase()}-${entity.toUpperCase()}`;
      const userId = `USR-${caseId}-TEST`;
      const incidentId = `INC-${caseId}-REPLAY`;
      const messageId = `MSG-${caseId}-REPLAY`;
      const distributorId =
        entity === 'distributor'
          ? `WHS-${caseId}-TEST`
          : calderPikeUser.distributorId;
      const customerMessage = 'Help with a shipment.';
      const privateReply = 'Please provide the shipment reference.';
      const findUser = () =>
        database
          .prepare('SELECT * FROM users WHERE user_id = ?')
          .bind(userId)
          .first();
      const findSessions = () =>
        database
          .prepare(
            'SELECT * FROM sessions WHERE user_id = ? ORDER BY session_id',
          )
          .bind(userId)
          .all();
      const findDistributor = () =>
        database
          .prepare('SELECT * FROM distributors WHERE customer_id = ?')
          .bind(distributorId)
          .first();
      let userCreated = false;
      let distributorCreated = false;
      expect(await findUser()).toBeNull();
      if (entity === 'distributor') expect(await findDistributor()).toBeNull();
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        // Only test-owned accounts change status; seeded accounts stay unchanged.
        if (entity === 'distributor') {
          await database
            .prepare(`INSERT INTO distributors
          (customer_id, legal_name, display_name, account_tier, account_status,
            payment_terms, currency, region)
          VALUES (?, 'Replay Test Distribution', 'Replay Test', 'Standard',
            'active', 'Net 30', 'USD', 'Test District')`)
            .bind(distributorId)
            .run();
          distributorCreated = true;
        }
        await database
          .prepare(`INSERT INTO users
        (user_id, distributor_id, display_name, email, role, status, created_on)
        VALUES (?, ?, ?, ?, 'support', 'active', ?)`)
          .bind(
            userId,
            distributorId,
            'Replay Test User',
            `${blockedStatus}-${entity}-replay@tests.example`,
            '2026-09-02',
          )
          .run();
        userCreated = true;
        const user = await loadActiveUserFixture(database, userId);
        await fixture.trackTemporaryIncident(incidentId, user);
        const session = await fixture.session(user);
        const fetchMock = fixture.mockModel(
          'This reply must not be generated.',
        );
        await saveSupportExchange(
          database,
          user,
          incidentId,
          messageId,
          customerMessage,
          privateReply,
          0,
        );
        const savedIncident = await fixture.findIncident(incidentId);
        const savedMessages = await fixture.messages(incidentId);
        const savedSessions = await findSessions();
        const savedUser = await findUser();
        const savedDistributor = await findDistributor();
        expect(savedUser).toMatchObject({
          status: 'active',
          distributor_id: distributorId,
        });
        expect(savedDistributor).toMatchObject({ account_status: 'active' });
        expect(savedIncident).toMatchObject({ user_id: userId });
        expect(savedMessages.results).toHaveLength(2);
        expect(savedSessions.results).toHaveLength(1);
        expect(savedSessions.results[0]).toMatchObject({
          user_id: userId,
          revoked_at: null,
        });
        expect(
          Date.parse(String(savedSessions.results[0].expires_at)),
        ).toBeGreaterThan(Date.now());

        // Only account status changes: the cookie, session record, and request stay the same.
        for (const [status, expectedStatus] of [
          ['active', 200],
          [blockedStatus, 401],
          // Repeat the denial for closed accounts; suspension can be lifted.
          blockedStatus === 'closed' ? ['closed', 401] : ['active', 200],
        ] as const) {
          if (entity === 'user')
            await database
              .prepare('UPDATE users SET status = ? WHERE user_id = ?')
              .bind(status, userId)
              .run();
          else
            await database
              .prepare(
                'UPDATE distributors SET account_status = ? WHERE customer_id = ?',
              )
              .bind(status, distributorId)
              .run();
          const response = await POST(
            session.request({
              expectedRevision: 0,
              incidentId,
              messageId,
              message: customerMessage,
            }),
          );
          expect(response.status).toBe(expectedStatus);
          expect(await response.json()).toEqual(
            status === 'active'
              ? {
                  revision: 1,
                  message: privateReply,
                  customerCreatedAt: expect.any(String),
                  assistantCreatedAt: expect.any(String),
                  incidentUpdatedAt: expect.any(String),
                }
              : {
                  error: 'Authentication required.',
                  code: 'request_not_saved',
                },
          );
          expect(fetchMock).not.toHaveBeenCalled();
          expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
          expect((await fixture.messages(incidentId)).results).toEqual(
            savedMessages.results,
          );
          expect((await findSessions()).results).toEqual(savedSessions.results);
          expect(await findUser()).toEqual({
            ...savedUser,
            status: entity === 'user' ? status : 'active',
          });
          expect(await findDistributor()).toEqual({
            ...savedDistributor,
            account_status: entity === 'distributor' ? status : 'active',
          });
        }
      } finally {
        try {
          await fixture.cleanup();
        } finally {
          try {
            if (userCreated)
              await database
                .prepare('DELETE FROM users WHERE user_id = ?')
                .bind(userId)
                .run();
          } finally {
            if (distributorCreated)
              await database
                .prepare('DELETE FROM distributors WHERE customer_id = ?')
                .bind(distributorId)
                .run();
          }
        }
      }
      expect(await findUser()).toBeNull();
      if (entity === 'distributor') expect(await findDistributor()).toBeNull();
      expect((await findSessions()).results).toEqual([]);
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );
});

test.for(['http', 'https'])(
  '%s sessions have explicit cookie attributes and logout revokes only the presented session',
  async (protocol, { database, onTestFinished }) => {
    const url = `${protocol}://localhost/api/auth/logout`;
    const requests: Request[] = [];
    onTestFinished(async () => {
      for (const request of requests) await revokeSession(database, request);
    });
    for (let index = 0; index < 2; index += 1) {
      const cookie = await createSession(
        database,
        calderPikeUser.userId,
        new Request(url),
      );
      const [credential, ...attributes] = cookie.split('; ');
      expect(attributes).toEqual([
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=43200',
        ...(protocol === 'https' ? ['Secure'] : []),
      ]);
      const request = new Request(url, {
        method: 'POST',
        headers: { Cookie: credential, Origin: new URL(url).origin },
      });
      requests.push(request);
      expect(await getAuthenticatedUser(database, request)).toMatchObject({
        userId: calderPikeUser.userId,
      });
    }
    expect(requests[0].headers.get('Cookie')).not.toBe(
      requests[1].headers.get('Cookie'),
    );
    const response = await logout(requests[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBe(
      `sable_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${protocol === 'https' ? '; Secure' : ''}`,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await getAuthenticatedUser(database, requests[0])).toBeNull();
    expect(await getAuthenticatedUser(database, requests[1])).toMatchObject({
      userId: calderPikeUser.userId,
    });
  },
);
