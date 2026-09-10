import { describe, expect, vi } from 'vitest';

import { DELETE, GET } from '@/app/api/incidents/route';
import { saveSupportExchange } from '@/db/incidents';
import type { SupportIncident } from '@/lib/support-incidents';
import type { SupportApiSession } from '../fixtures/support-api';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('support incident API', () => {
  test('denies incident listing and deletion at session expiry without disclosing or changing history', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-EXPIRED-SESSION-HISTORY';
    const messageId = 'MSG-EXPIRED-SESSION-HISTORY';
    const customerMessage = 'Keep my private incident history.';
    const assistantMessage = 'This discussion belongs to your account.';
    const makeRequest = (
      session: SupportApiSession,
      method: 'GET' | 'DELETE',
    ) => {
      const headers = new Headers(session.request({}).headers);
      headers.set('Origin', 'http://localhost');
      headers.set('Sec-Fetch-Site', 'same-origin');
      return new Request('http://localhost/api/incidents', {
        method,
        headers,
        ...(method === 'DELETE'
          ? { body: JSON.stringify({ incidentId }) }
          : {}),
      });
    };

    try {
      // Freeze only Date so real database I/O and timers continue normally.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        messageId,
        customerMessage,
        assistantMessage,
      );
      const session = await fixture.session(calderPikeUser);
      const beforeIncident = await fixture.findIncident(incidentId);
      const beforeMessages = (await fixture.messages(incidentId)).results;
      expect(beforeIncident).toMatchObject({ user_id: calderPikeUser.userId });
      expect(beforeMessages).toHaveLength(2);

      vi.setSystemTime(new Date('2026-09-02T23:59:59.999Z'));
      const allowed = await GET(makeRequest(session, 'GET'));
      expect(allowed.status).toBe(200);
      const payload = (await allowed.json()) as {
        incidents: SupportIncident[];
      };
      expect(
        payload.incidents.find((incident) => incident.id === incidentId),
      ).toMatchObject({
        id: incidentId,
        title: customerMessage,
        messages: [
          { id: messageId, role: 'user', content: customerMessage },
          {
            id: `AST-${messageId}`,
            role: 'assistant',
            content: assistantMessage,
          },
        ],
      });

      // Reuse the original cookie; expiration alone must invalidate both routes.
      vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
      for (const method of ['GET', 'DELETE'] as const) {
        const request = makeRequest(session, method);
        const denied = await (method === 'GET'
          ? GET(request)
          : DELETE(request));
        expect(denied.status, method).toBe(401);
        expect(await denied.json(), method).toEqual({
          error: 'Authentication required.',
        });
        expect(await fixture.findIncident(incidentId), method).toEqual(
          beforeIncident,
        );
        expect((await fixture.messages(incidentId)).results, method).toEqual(
          beforeMessages,
        );
      }

      // A new session for the same owner proves the target is still deletable.
      const freshSession = await fixture.session(calderPikeUser);
      const deleted = await DELETE(makeRequest(freshSession, 'DELETE'));
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe('');
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects cross-origin deletion before database work and accepts the same-origin control', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-DELETE-CROSS-ORIGIN';

    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-DELETE-CROSS-ORIGIN',
      'Keep this incident safe.',
      'This conversation belongs to your account.',
    );
    const session = await fixture.session(calderPikeUser);
    const beforeIncident = await fixture.findIncident(incidentId);
    const beforeMessages = (await fixture.messages(incidentId)).results;
    expect(beforeIncident).toMatchObject({
      incident_id: incidentId,
      user_id: calderPikeUser.userId,
    });
    expect(beforeMessages).toHaveLength(2);
    const requestDeletion = (origin: string) => {
      const headers = new Headers(session.request({}).headers);
      headers.set('Origin', origin);
      return new Request('http://localhost/api/incidents', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ incidentId }),
      });
    };

    // Observe real D1 calls; do not replace database behavior with a mock.
    const prepareSpy = vi.spyOn(database, 'prepare');
    const batchSpy = vi.spyOn(database, 'batch');
    try {
      const rejected = await DELETE(
        requestDeletion('https://untrusted.example'),
      );
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({
        error: 'Cross-origin access denied.',
      });
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(batchSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
      batchSpy.mockRestore();
    }
    expect(await fixture.findIncident(incidentId)).toEqual(beforeIncident);
    expect((await fixture.messages(incidentId)).results).toEqual(
      beforeMessages,
    );

    // Only the Origin changes; the session, incident, and body stay identical.
    const accepted = await DELETE(requestDeletion('http://localhost'));
    expect(accepted.status).toBe(204);
    expect(await accepted.text()).toBe('');
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  test('leaves another user’s incident untouched for same-distributor and cross-distributor deletion attempts', async ({
    database,
    supportApi: fixture,
    onTestFinished,
  }) => {
    const incidentId = 'INC-DELETE-FOREIGN-TARGET';
    const colleagueId = 'USR-DELETE-FOREIGN-COLLEAGUE';
    let colleagueCreated = false;
    // Runs after fixture teardown, so sessions are revoked before the user goes.
    onTestFinished(async () => {
      if (colleagueCreated) {
        await database
          .prepare('DELETE FROM users WHERE user_id = ?')
          .bind(colleagueId)
          .run();
      }
    });
    const requestDeletion = (session: SupportApiSession) => {
      const headers = new Headers(session.request({}).headers);
      headers.set('Origin', 'http://localhost');
      headers.set('Sec-Fetch-Site', 'same-origin');
      return DELETE(
        new Request('http://localhost/api/incidents', {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ incidentId }),
        }),
      );
    };

    await database
      .prepare(`INSERT INTO users (
          user_id, distributor_id, display_name, email, role, status, created_on
        ) VALUES (?, ?, 'Deletion test colleague', ?, 'account_admin', 'active', '2000-01-01')`)
      .bind(
        colleagueId,
        calderPikeUser.distributorId,
        'delete-foreign-colleague@example.test',
      )
      .run();
    colleagueCreated = true;
    const colleague = await loadActiveUserFixture(database, colleagueId);
    const externalUser = await loadActiveUserFixture(database, 'USR-MCS-001');
    expect(colleague.userId).not.toBe(calderPikeUser.userId);
    expect(colleague.distributorId).toBe(calderPikeUser.distributorId);
    expect(externalUser.distributorId).not.toBe(calderPikeUser.distributorId);

    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-DELETE-FOREIGN-FIRST',
      'Keep this private shipment discussion.',
      'Which shipment should I trace?',
    );
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-DELETE-FOREIGN-SECOND',
      'I will send the details later.',
      'This incident remains open.',
    );
    const beforeIncident = await fixture.findIncident(incidentId);
    const beforeMessages = (await fixture.messages(incidentId)).results;
    expect(beforeIncident).toMatchObject({
      incident_id: incidentId,
      user_id: calderPikeUser.userId,
    });
    expect(beforeMessages).toHaveLength(4);

    for (const requester of [colleague, externalUser]) {
      const session = await fixture.session(requester);
      const response = await requestDeletion(session);
      // An inaccessible ID is a non-disclosing no-op, not a deletion.
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(await fixture.findIncident(incidentId)).toEqual(beforeIncident);
      expect((await fixture.messages(incidentId)).results).toEqual(
        beforeMessages,
      );
    }

    // Change only the session: the real owner can delete the same target.
    const ownerSession = await fixture.session(calderPikeUser);
    const ownerResponse = await requestDeletion(ownerSession);
    expect(ownerResponse.status).toBe(204);
    expect(await ownerResponse.text()).toBe('');
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  test('deletes an owned incident and all its messages while preserving unrelated history', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-DELETE-OWNED-TARGET';
    const retainedId = 'INC-DELETE-OWNED-RETAINED';
    const snapshotIncidents = () =>
      database
        .prepare('SELECT * FROM support_incidents ORDER BY incident_id')
        .all<{ incident_id: string }>();
    const snapshotMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages ORDER BY incident_id, sequence_number',
        )
        .all<{ incident_id: string }>();

    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await fixture.trackTemporaryIncident(retainedId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-DELETE-OWNED-FIRST',
      'Trace my shipment.',
      'Which shipment should I trace?',
    );
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-DELETE-OWNED-SECOND',
      'Never mind, this incident is resolved.',
      'Understood.',
    );
    await saveSupportExchange(
      database,
      calderPikeUser,
      retainedId,
      'MSG-DELETE-OWNED-KEEP',
      'Keep this separate incident.',
      'This conversation should remain.',
    );
    const incidentsBefore = (await snapshotIncidents()).results;
    const messagesBefore = (await snapshotMessages()).results;
    expect(await fixture.findIncidentOwner(incidentId)).toEqual({
      user_id: calderPikeUser.userId,
    });
    expect(
      messagesBefore.filter((row) => row.incident_id === incidentId),
    ).toHaveLength(4);
    expect(
      messagesBefore.filter((row) => row.incident_id === retainedId),
    ).toHaveLength(2);
    expect(
      incidentsBefore.some(
        (row) =>
          row.incident_id !== incidentId && row.incident_id !== retainedId,
      ),
    ).toBe(true);

    const session = await fixture.session(calderPikeUser);
    const headers = new Headers(session.request({}).headers);
    headers.set('Origin', 'http://localhost');
    headers.set('Sec-Fetch-Site', 'same-origin');
    const response = await DELETE(
      new Request('http://localhost/api/incidents', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ incidentId }),
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
    // Compare full rows, including metadata and every other user's history.
    expect((await snapshotIncidents()).results).toEqual(
      incidentsBefore.filter((row) => row.incident_id !== incidentId),
    );
    expect((await snapshotMessages()).results).toEqual(
      messagesBefore.filter((row) => row.incident_id !== incidentId),
    );
  });

  test('lists only the authenticated user’s incidents with messages in conversation order', async ({
    database,
    supportApi: fixture,
    onTestFinished,
  }) => {
    const createdUserIds: string[] = [];
    const ownerId = 'USR-INCIDENT-LIST-OWNER';
    const colleagueId = 'USR-INCIDENT-LIST-COLLEAGUE';
    const recentId = 'INC-LIST-OWNER-A';
    const olderId = 'INC-LIST-OWNER-Z';
    const colleagueIncidentId = 'INC-LIST-COLLEAGUE';
    onTestFinished(async () => {
      // Fixture teardown revokes sessions first; cascades remove test history.
      if (createdUserIds.length) {
        await database.batch(
          createdUserIds.map((id) =>
            database.prepare('DELETE FROM users WHERE user_id = ?').bind(id),
          ),
        );
      }
    });

    // Fresh users give us an exact result set without removing seed history.
    for (const userId of [ownerId, colleagueId]) {
      await database
        .prepare(`INSERT INTO users (
            user_id, distributor_id, display_name, email, role, status, created_on
          ) VALUES (?, ?, ?, ?, 'support', 'active', '2000-01-01')`)
        .bind(
          userId,
          calderPikeUser.distributorId,
          userId,
          `${userId.toLowerCase()}@example.test`,
        )
        .run();
      // Only successfully inserted test users may be removed in cleanup.
      createdUserIds.push(userId);
    }
    const owner = await loadActiveUserFixture(database, ownerId);
    const colleague = await loadActiveUserFixture(database, colleagueId);
    expect(owner.distributorId).toBe(colleague.distributorId);
    expect(owner.userId).not.toBe(colleague.userId);

    const externalIncident = await database
      .prepare(`SELECT i.incident_id FROM support_incidents i
          JOIN users u ON u.user_id = i.user_id
          WHERE u.distributor_id <> ? ORDER BY i.incident_id LIMIT 1`)
      .bind(owner.distributorId)
      .first<{ incident_id: string }>();
    expect(externalIncident).not.toBeNull();

    // Insert oldest first, and include an empty incident to exercise the join.
    for (const [id, userId, title, updatedAt] of [
      [olderId, ownerId, 'Older empty incident', '2000-01-01T09:00:00Z'],
      [recentId, ownerId, 'Recent shipment discussion', '2000-01-02T09:00:00Z'],
      [
        colleagueIncidentId,
        colleagueId,
        'Private colleague discussion',
        '2000-01-03T09:00:00Z',
      ],
    ]) {
      await database
        .prepare(`INSERT INTO support_incidents (
            incident_id, user_id, title, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, userId, title, updatedAt, updatedAt)
        .run();
    }
    // IDs, insertion order, and timestamps intentionally differ from sequence.
    for (const [sequence, id, role, content, time] of [
      [3, 'MSG-LIST-B', 'user', 'What is the next milestone?', '09:01'],
      [1, 'MSG-LIST-D', 'user', 'Trace my shipment.', '09:03'],
      [
        4,
        'MSG-LIST-A',
        'assistant',
        'The next milestone is carrier pickup.',
        '09:00',
      ],
      [2, 'MSG-LIST-C', 'assistant', 'The shipment is packed.', '09:02'],
    ] as const) {
      await database
        .prepare(`INSERT INTO support_messages (
            message_id, incident_id, sequence_number, role, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, recentId, sequence, role, content, `2000-01-02T${time}:00Z`)
        .run();
    }
    await database
      .prepare(`INSERT INTO support_messages (
          message_id, incident_id, sequence_number, role, content, created_at
        ) VALUES (?, ?, 1, 'user', ?, '2000-01-03T09:00:00Z')`)
      .bind(
        'MSG-LIST-COLLEAGUE',
        colleagueIncidentId,
        'Private colleague message.',
      )
      .run();

    const incidentsBefore = await fixture.incidents(
      recentId,
      olderId,
      colleagueIncidentId,
    );
    const messagesBefore = await fixture.messages(
      recentId,
      olderId,
      colleagueIncidentId,
    );
    const ownerSession = await fixture.session(owner);
    const colleagueSession = await fixture.session(colleague);
    const expectedOwner = [
      {
        id: recentId,
        title: 'Recent shipment discussion',
        messages: [
          { id: 'MSG-LIST-D', role: 'user', content: 'Trace my shipment.' },
          {
            id: 'MSG-LIST-C',
            role: 'assistant',
            content: 'The shipment is packed.',
          },
          {
            id: 'MSG-LIST-B',
            role: 'user',
            content: 'What is the next milestone?',
          },
          {
            id: 'MSG-LIST-A',
            role: 'assistant',
            content: 'The next milestone is carrier pickup.',
          },
        ],
      },
      { id: olderId, title: 'Older empty incident', messages: [] },
    ];
    const expectedColleague = [
      {
        id: colleagueIncidentId,
        title: 'Private colleague discussion',
        messages: [
          {
            id: 'MSG-LIST-COLLEAGUE',
            role: 'user',
            content: 'Private colleague message.',
          },
        ],
      },
    ];

    for (const [session, expected] of [
      [ownerSession, expectedOwner],
      [colleagueSession, expectedColleague],
    ] as const) {
      const response = await GET(
        new Request('http://localhost/api/incidents', {
          headers: session.request({}).headers,
        }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        incidents: SupportIncident[];
      };
      expect(
        payload.incidents.map(({ id, title, messages }) => ({
          id,
          title,
          messages: messages.map(({ id, role, content }) => ({
            id,
            role,
            content,
          })),
        })),
      ).toEqual(expected);
      expect(JSON.stringify(payload)).not.toContain(
        externalIncident!.incident_id,
      );
    }
    expect(
      (await fixture.incidents(recentId, olderId, colleagueIncidentId)).results,
    ).toEqual(incidentsBefore.results);
    expect(
      (await fixture.messages(recentId, olderId, colleagueIncidentId)).results,
    ).toEqual(messagesBefore.results);
  });
});
