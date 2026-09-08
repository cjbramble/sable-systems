import { vi } from 'vitest';

import {
  createSession,
  revokeSession,
  type AuthenticatedUser,
} from '@/db/auth';
import { deleteSupportIncident } from '@/db/incidents';

const CHAT_URL = 'http://localhost/api/chat';

export type SupportApiSession = {
  request: (body: unknown) => Request;
};

// Test-local state only: never share this fixture across test cases.
export function createSupportApiFixture(database: D1Database) {
  const cleanups: Array<() => void | Promise<void>> = [];
  const findIncident = (incidentId: string) =>
    database
      .prepare('SELECT * FROM support_incidents WHERE incident_id = ?')
      .bind(incidentId)
      .first();

  return {
    findIncident,
    findIncidentOwner: (incidentId: string) =>
      database
        .prepare('SELECT user_id FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first<{ user_id: string }>(),
    incidents: (...ids: [string, ...string[]]) =>
      database
        .prepare(`SELECT * FROM support_incidents
          WHERE incident_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY incident_id`)
        .bind(...ids)
        .all(),
    messages: (...ids: [string, ...string[]]) =>
      database
        .prepare(`SELECT * FROM support_messages
          WHERE incident_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY incident_id, sequence_number`)
        .bind(...ids)
        .all(),
    messageContents: (incidentId: string) =>
      database
        .prepare(`SELECT message_id, sequence_number, role, content
          FROM support_messages WHERE incident_id = ? ORDER BY sequence_number`)
        .bind(incidentId)
        .all(),

    // Register before the test creates an incident. Existing seed records may
    // be inspected, but must never be registered for deletion.
    async trackTemporaryIncident(incidentId: string, user: AuthenticatedUser) {
      if (await findIncident(incidentId))
        throw new Error(
          `Refusing to clean up an existing incident: ${incidentId}`,
        );
      cleanups.push(() => deleteSupportIncident(database, user, incidentId));
    },

    async session(user: AuthenticatedUser): Promise<SupportApiSession> {
      const cookie = await createSession(
        database,
        user.userId,
        new Request(CHAT_URL),
      );
      const request = (body: unknown) =>
        new Request(CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie.split(';')[0],
          },
          body: JSON.stringify(body),
        });
      cleanups.push(() => revokeSession(database, request({})));
      return { request };
    },

    // Each fetch receives a fresh Response body. After the supplied sequence,
    // repeat its final reply so unexpected calls remain visible to assertions.
    mockModel(...replies: [string, ...string[]]) {
      let call = 0;
      const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                message: {
                  content: replies[Math.min(call++, replies.length - 1)],
                },
              },
            ],
          }),
        ),
      );
      cleanups.push(() => {
        mock.mockRestore();
      });
      return mock;
    },

    async cleanup() {
      const errors: unknown[] = [];
      // Attempt every cleanup even if an earlier one fails, then report failures.
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Support API fixture cleanup failed');
    },
  };
}
