import { describe, expect, it } from 'vitest';

import { DELETE, GET } from '@/app/api/incidents/route';
import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import type { SupportIncident } from '@/lib/support-incidents';
import { createSupportApiFixture } from '../fixtures/support-api';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('support incident API', () => {
  it('deletes an owned incident and all its messages while preserving unrelated history', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
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

    try {
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
    } finally {
      await fixture.cleanup();
    }
  });

  it('lists only the authenticated user’s incidents with messages in conversation order', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const createdUserIds: string[] = [];
    const ownerId = 'USR-INCIDENT-LIST-OWNER';
    const colleagueId = 'USR-INCIDENT-LIST-COLLEAGUE';
    const recentId = 'INC-LIST-OWNER-A';
    const olderId = 'INC-LIST-OWNER-Z';
    const colleagueIncidentId = 'INC-LIST-COLLEAGUE';

    try {
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
        [
          recentId,
          ownerId,
          'Recent shipment discussion',
          '2000-01-02T09:00:00Z',
        ],
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
        (await fixture.incidents(recentId, olderId, colleagueIncidentId))
          .results,
      ).toEqual(incidentsBefore.results);
      expect(
        (await fixture.messages(recentId, olderId, colleagueIncidentId))
          .results,
      ).toEqual(messagesBefore.results);
    } finally {
      try {
        await fixture.cleanup();
      } finally {
        // Foreign-key cascades remove only these test users' incidents/messages.
        if (createdUserIds.length) {
          await database.batch(
            createdUserIds.map((id) =>
              database.prepare('DELETE FROM users WHERE user_id = ?').bind(id),
            ),
          );
        }
      }
    }
  });
});
