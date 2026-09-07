import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { createSession, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { calderPikeUser } from '../fixtures/users';

describe('support response safety', () => {
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
