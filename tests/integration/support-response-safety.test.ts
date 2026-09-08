import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { createSession, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { deleteSupportIncident, saveSupportExchange } from '@/db/incidents';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('support response safety', () => {
  it('returns and saves a grounded response under the authenticated user incident', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const incidentId = 'INC-VALID-RESPONSE-REGRESSION';
    const messageId = 'MSG-VALID-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return **RTN-2022-000014** is closed. Linked order: `SBL-2022-000118`; customer PO: `CPD-PO-220118`.';
    const findIncident = () =>
      database
        .prepare('SELECT user_id FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first<{ user_id: string }>();
    const savedMessages = () =>
      database
        .prepare(`SELECT message_id, sequence_number, role, content
        FROM support_messages WHERE incident_id = ? ORDER BY sequence_number`)
        .bind(incidentId)
        .all();
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie.split(';')[0],
      },
      body: JSON.stringify({
        incidentId,
        messageId,
        messages: [{ role: 'user', content: customerMessage }],
      }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        choices: [{ message: { content: assistantMessage } }],
      }),
    );

    try {
      const response = await POST(request);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: assistantMessage });
      expect(await findIncident()).toEqual({ user_id: calderPikeUser.userId });
      expect((await savedMessages()).results).toEqual([
        {
          message_id: messageId,
          sequence_number: 1,
          role: 'user',
          content: customerMessage,
        },
        {
          message_id: `AST-${messageId}`,
          sequence_number: 2,
          role: 'assistant',
          content: assistantMessage,
        },
      ]);
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      await revokeSession(database, request);
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('does not duplicate the saved exchange when the same chat message is retried', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const incidentId = 'INC-RETRY-RESPONSE-REGRESSION';
    const messageId = 'MSG-RETRY-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () =>
      database
        .prepare('SELECT user_id FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first<{ user_id: string }>();
    const savedMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all();
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const makeRequest = () =>
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie.split(';')[0],
        },
        body: JSON.stringify({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        }),
      });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: assistantMessage } }],
        }),
      ),
    );

    try {
      const firstResponse = await POST(makeRequest());
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toEqual({ message: assistantMessage });
      const originalMessages = await savedMessages();
      expect(originalMessages.results).toMatchObject([
        {
          message_id: messageId,
          sequence_number: 1,
          role: 'user',
          content: customerMessage,
        },
        {
          message_id: `AST-${messageId}`,
          sequence_number: 2,
          role: 'assistant',
          content: assistantMessage,
        },
      ]);
      expect(originalMessages.results).toHaveLength(2);

      const retryResponse = await POST(makeRequest());
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toEqual({ message: assistantMessage });
      expect((await savedMessages()).results).toEqual(originalMessages.results);
      expect(await findIncident()).toEqual({ user_id: calderPikeUser.userId });
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      await revokeSession(database, makeRequest());
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('replays the original saved reply without regenerating it on a completed retry', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const incidentId = 'INC-REPLAY-RESPONSE-REGRESSION';
    const messageId = 'MSG-REPLAY-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const regeneratedReply =
      'The linked order is SBL-2022-000118. Return RTN-2022-000014 has status closed.';
    const savedMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all();
    expect(
      await database
        .prepare('SELECT incident_id FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first(),
    ).toBeNull();

    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const makeRequest = () =>
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie.split(';')[0],
        },
        body: JSON.stringify({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        }),
      });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: originalReply } }] }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ choices: [{ message: { content: regeneratedReply } }] }),
        ),
      );

    try {
      const firstResponse = await POST(makeRequest());
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toEqual({ message: originalReply });
      const originalMessages = await savedMessages();
      expect(originalMessages.results).toHaveLength(2);
      expect(originalMessages.results[1]).toMatchObject({
        message_id: `AST-${messageId}`,
        role: 'assistant',
        content: originalReply,
      });

      const retryResponse = await POST(makeRequest());
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toEqual({ message: originalReply });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      await revokeSession(database, makeRequest());
    }
    expect((await savedMessages()).results).toEqual([]);
  });

  it('denies another user replaying a saved reply with the same incident and message IDs', async () => {
    const database = await getDatabase();
    const otherUser = await loadActiveUserFixture(database, 'USR-MCS-001');
    expect(otherUser.distributorId).not.toBe(calderPikeUser.distributorId);
    const url = 'http://localhost/api/chat';
    const incidentId = 'INC-REPLAY-ISOLATION-REGRESSION';
    const messageId = 'MSG-REPLAY-ISOLATION-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const privateReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () =>
      database
        .prepare('SELECT * FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first();
    const savedMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all();
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const cookies: string[] = [];
    const makeRequest = (cookie: string) =>
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie.split(';')[0],
        },
        body: JSON.stringify({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        }),
      });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: 'No authorized return was found.' } }],
        }),
      ),
    );

    try {
      for (const user of [calderPikeUser, otherUser]) {
        cookies.push(await createSession(database, user.userId, new Request(url)));
      }
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        messageId,
        customerMessage,
        privateReply,
      );
      const originalIncident = await findIncident();
      const originalMessages = await savedMessages();
      expect(originalIncident).toMatchObject({ user_id: calderPikeUser.userId });
      expect(originalMessages.results).toHaveLength(2);

      // Positive control: this exact request replays successfully for its owner.
      const ownerResponse = await POST(makeRequest(cookies[0]));
      expect(ownerResponse.status).toBe(200);
      expect(await ownerResponse.json()).toEqual({ message: privateReply });
      expect(fetchMock).not.toHaveBeenCalled();

      // Only the session changes; knowing the IDs and prompt grants no access.
      const otherResponse = await POST(makeRequest(cookies[1]));
      expect(otherResponse.status).toBe(403);
      expect(await otherResponse.json()).toEqual({
        error: 'Incident access denied.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      for (const cookie of cookies)
        await revokeSession(database, makeRequest(cookie));
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects reuse of a saved message ID with different customer text', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const incidentId = 'INC-MESSAGE-CONFLICT-REGRESSION';
    const messageId = 'MSG-MESSAGE-CONFLICT-REGRESSION';
    const originalText = 'Show return RTN-2022-000014.';
    const changedText = 'Which order is linked to return RTN-2022-000014?';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () =>
      database
        .prepare('SELECT * FROM support_incidents WHERE incident_id = ?')
        .bind(incidentId)
        .first();
    const savedMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all();
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const makeRequest = (content: string) =>
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie.split(';')[0],
        },
        body: JSON.stringify({
          incidentId,
          messageId,
          messages: [{ role: 'user', content }],
        }),
      });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: 'The linked order is SBL-2022-000118.' } }],
        }),
      ),
    );

    try {
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        messageId,
        originalText,
        originalReply,
      );
      const originalIncident = await findIncident();
      const originalMessages = await savedMessages();
      expect(originalIncident).toMatchObject({ user_id: calderPikeUser.userId });
      expect(originalMessages.results).toHaveLength(2);
      expect(originalMessages.results[0]).toMatchObject({
        message_id: messageId,
        role: 'user',
        content: originalText,
      });

      const response = await POST(makeRequest(changedText));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error:
          'This message ID was already used for different text. Send a new message.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);

      // Rejecting the conflicting request must not break a legitimate retry.
      const retry = await POST(makeRequest(originalText));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: originalReply });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, incidentId);
      await revokeSession(database, makeRequest(originalText));
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects reuse of a saved message ID in a different incident', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const sourceId = 'INC-CROSS-INCIDENT-SOURCE-REGRESSION';
    const targetId = 'INC-CROSS-INCIDENT-TARGET-REGRESSION';
    const messageId = 'MSG-CROSS-INCIDENT-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const incidents = () =>
      database
        .prepare(
          'SELECT * FROM support_incidents WHERE incident_id IN (?, ?) ORDER BY incident_id',
        )
        .bind(sourceId, targetId)
        .all();
    const savedMessages = () =>
      database
        .prepare(`SELECT * FROM support_messages WHERE incident_id IN (?, ?)
          ORDER BY incident_id, sequence_number`)
        .bind(sourceId, targetId)
        .all();
    expect((await incidents()).results).toEqual([]);
    expect((await savedMessages()).results).toEqual([]);

    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const makeRequest = (incidentId: string) =>
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie.split(';')[0],
        },
        body: JSON.stringify({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        }),
      });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: originalReply } }] }),
      ),
    );

    try {
      await saveSupportExchange(
        database,
        calderPikeUser,
        sourceId,
        messageId,
        customerMessage,
        originalReply,
      );
      await saveSupportExchange(
        database,
        calderPikeUser,
        targetId,
        'MSG-CROSS-INCIDENT-TARGET-REGRESSION',
        'Hello.',
        'How can I help?',
      );
      const originalIncidents = await incidents();
      const originalMessages = await savedMessages();
      expect(originalIncidents.results).toHaveLength(2);
      expect(originalMessages.results).toHaveLength(4);

      // Same user, message ID, and text; only the destination incident changes.
      const response = await POST(makeRequest(targetId));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This message ID is already in use. Send a new message.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await incidents()).results).toEqual(originalIncidents.results);
      expect((await savedMessages()).results).toEqual(originalMessages.results);

      const retry = await POST(makeRequest(sourceId));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: originalReply });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      fetchMock.mockRestore();
      await deleteSupportIncident(database, calderPikeUser, sourceId);
      await deleteSupportIncident(database, calderPikeUser, targetId);
      await revokeSession(database, makeRequest(sourceId));
    }
    expect((await incidents()).results).toEqual([]);
    expect((await savedMessages()).results).toEqual([]);
  });

  it('blocks a corrupted order ID before returning or persisting the response', async () => {
    const database = await getDatabase();
    const url = 'http://localhost/api/chat';
    const cookie = await createSession(
      database,
      calderPikeUser.userId,
      new Request(url),
    );
    const incidentId = 'INC-USR-CPD-001-01';
    const existingMessages = () =>
      database
        .prepare(
          'SELECT * FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all();
    const before = await existingMessages();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content:
                'Return RTN-2022-000014. Linked order: SBL-2022-0000118.',
            },
          },
        ],
      }),
    );
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie.split(';')[0],
      },
      body: JSON.stringify({
        incidentId,
        messageId: 'MSG-RETURN-SAFETY-REGRESSION',
        messages: [{ role: 'user', content: 'Show return RTN-2022-000014.' }],
      }),
    });

    try {
      const response = await POST(request);
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = fetchMock.mock.calls[0][1]?.body;
      expect(typeof body).toBe('string');
      if (typeof body !== 'string')
        throw new Error('Expected a JSON model request');
      const requestBody = JSON.parse(body);
      expect(requestBody.messages[0].content).toContain('SBL-2022-000118');
      expect(requestBody.messages[0].content).not.toContain('SBL-2022-0000118');
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error:
          'The response contained an unverified record reference. Please try again.',
      });
      expect((await existingMessages()).results).toEqual(before.results);
    } finally {
      fetchMock.mockRestore();
      await revokeSession(database, request);
    }
  });
});
