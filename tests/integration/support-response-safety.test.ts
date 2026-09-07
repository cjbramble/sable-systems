import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { createSession, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { deleteSupportIncident } from '@/db/incidents';
import { calderPikeUser } from '../fixtures/users';

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
