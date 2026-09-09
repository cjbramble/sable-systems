import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import { createConcurrentSupportFixture } from '../fixtures/concurrent-support';
import {
  createSupportApiFixture,
  type SupportApiSession,
} from '../fixtures/support-api';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('support response safety', () => {
  it.each([
    { invalid: '13 chat messages', caseId: 'MESSAGE-COUNT-BOUNDARY' },
    {
      invalid: 'an assistant-final history',
      caseId: 'ASSISTANT-FINAL-HISTORY',
    },
    {
      invalid: 'a 4,001-character message',
      caseId: 'MESSAGE-LENGTH-BOUNDARY',
    },
    {
      invalid: 'a whitespace-only customer message',
      caseId: 'WHITESPACE-MESSAGE',
    },
    {
      invalid: 'a client-supplied system message',
      caseId: 'SYSTEM-ROLE-MESSAGE',
    },
    {
      invalid: 'an empty chat history',
      caseId: 'MINIMUM-HISTORY-BOUNDARY',
      validCount: 1,
    },
    {
      invalid: 'numeric customer message content',
      caseId: 'NUMERIC-MESSAGE-CONTENT',
      validCustomerContent: '123',
    },
    {
      invalid: 'a null message-history entry',
      caseId: 'NULL-HISTORY-ENTRY',
    },
    {
      invalid: 'a messages object instead of an array',
      caseId: 'NON-ARRAY-HISTORY',
      validCount: 1,
    },
    {
      invalid: 'a missing messages field',
      caseId: 'MISSING-HISTORY',
      validCount: 1,
    },
    {
      invalid: 'an explicit null messages field',
      caseId: 'NULL-HISTORY',
      validCount: 1,
    },
  ])(
    'rejects $invalid without side effects and accepts its valid-history control',
    async ({
      caseId,
      validCount = 12,
      validCustomerContent = 'Help with a shipment.',
    }) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-${caseId}`;
      const messageId = `MSG-${caseId}`;
      const customerMessage =
        caseId === 'MESSAGE-LENGTH-BOUNDARY'
          ? 'x'.repeat(4_000)
          : validCustomerContent;
      const assistantMessage = 'Which shipment do you need help with?';
      // The count case differs from the control only by the oldest entry.
      const oversizedHistory = Array.from({ length: 13 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content:
          index === 12
            ? customerMessage
            : `Shipment discussion turn ${index + 1}.`,
      }));
      const allowedHistory = oversizedHistory.slice(-validCount);
      expect(oversizedHistory).toHaveLength(13);
      expect(allowedHistory).toHaveLength(validCount);
      let rejectedHistory:
        | Array<{ role: string; content: unknown } | null>
        | { role: string; content: unknown }
        | null
        | undefined = oversizedHistory;
      if (caseId === 'ASSISTANT-FINAL-HISTORY') {
        // Keep all 12 entries and their content, changing only the final role.
        rejectedHistory = allowedHistory.map((message, index) =>
          index === allowedHistory.length - 1
            ? { ...message, role: 'assistant' }
            : message,
        );
      } else if (caseId === 'MESSAGE-LENGTH-BOUNDARY') {
        // Add one non-whitespace character; roles and message count stay valid.
        rejectedHistory = allowedHistory.map((message, index) =>
          index === allowedHistory.length - 1
            ? { ...message, content: `${message.content}x` }
            : message,
        );
        expect(allowedHistory.at(-1)?.content).toHaveLength(4_000);
        expect(rejectedHistory.at(-1)?.content).toHaveLength(4_001);
      } else if (caseId === 'WHITESPACE-MESSAGE') {
        // A nonempty string of spaces, tabs, and line breaks is still blank content.
        const whitespace = ' \t\r\n ';
        expect(whitespace.length).toBeGreaterThan(0);
        expect(whitespace.trim()).toBe('');
        rejectedHistory = allowedHistory.map((message, index) =>
          index === allowedHistory.length - 1
            ? { ...message, content: whitespace }
            : message,
        );
      } else if (caseId === 'SYSTEM-ROLE-MESSAGE') {
        // Change an earlier role so the final-user check cannot mask this rejection.
        rejectedHistory = allowedHistory.map((message, index) =>
          index === 0 ? { ...message, role: 'system' } : message,
        );
        expect(rejectedHistory).toHaveLength(12);
        expect(rejectedHistory.at(-1)?.role).toBe('user');
      } else if (caseId === 'MINIMUM-HISTORY-BOUNDARY') {
        rejectedHistory = [];
        expect(allowedHistory).toEqual([
          { role: 'user', content: customerMessage },
        ]);
      } else if (caseId === 'NUMERIC-MESSAGE-CONTENT') {
        // The control uses '123'; the rejected payload changes only its JSON type.
        rejectedHistory = allowedHistory.map((message, index) =>
          index === allowedHistory.length - 1
            ? { ...message, content: 123 }
            : message,
        );
      } else if (caseId === 'NULL-HISTORY-ENTRY') {
        // Keep the count and final customer message valid; an earlier entry is null.
        rejectedHistory = allowedHistory.map((message, index) =>
          index === 0 ? null : message,
        );
        expect(rejectedHistory).toHaveLength(12);
        expect(rejectedHistory[0]).toBeNull();
        expect(rejectedHistory.at(-1)?.role).toBe('user');
      } else if (caseId === 'NON-ARRAY-HISTORY') {
        // Only the array wrapper is missing; the message itself is valid.
        rejectedHistory = { role: 'user', content: customerMessage };
        expect(allowedHistory).toEqual([rejectedHistory]);
      } else if (caseId === 'MISSING-HISTORY') {
        // JSON serialization omits this field rather than sending null or [].
        rejectedHistory = undefined;
      } else if (caseId === 'NULL-HISTORY') {
        rejectedHistory = null;
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(assistantMessage);
        const makeRequest = (messages: typeof rejectedHistory) => {
          const request = session.request({ incidentId, messageId, messages });
          request.headers.set('Origin', new URL(request.url).origin);
          request.headers.set('Sec-Fetch-Site', 'same-origin');
          return request;
        };
        const rejectedRequest = makeRequest(rejectedHistory);
        if (caseId === 'MISSING-HISTORY') {
          expect(await rejectedRequest.clone().json()).toEqual({
            incidentId,
            messageId,
          });
        } else if (caseId === 'NULL-HISTORY') {
          // Verify null survives serialization; it is not an omitted field.
          expect(await rejectedRequest.clone().json()).toEqual({
            incidentId,
            messageId,
            messages: null,
          });
        }
        const prepareSpy = vi.spyOn(database, 'prepare');
        try {
          const rejected = await POST(rejectedRequest);
          expect(rejected.status).toBe(400);
          expect(await rejected.json()).toEqual({
            error:
              'Send 1–12 valid messages, with the latest message from the customer.',
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(prepareSpy).not.toHaveBeenCalled();
        } finally {
          prepareSpy.mockRestore();
        }
        expect(await fixture.findIncident(incidentId)).toBeNull();
        expect((await fixture.messages(incidentId)).results).toEqual([]);

        const accepted = await POST(makeRequest(allowedHistory));
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledOnce();
        const modelBody = fetchMock.mock.calls[0][1]?.body;
        if (typeof modelBody !== 'string')
          throw new Error('Expected a JSON model request body');
        const modelRequest = JSON.parse(modelBody);
        // The server adds one system message and preserves every submitted entry.
        expect(modelRequest.messages).toHaveLength(validCount + 1);
        expect(modelRequest.messages[0]).toMatchObject({ role: 'system' });
        expect(modelRequest.messages.slice(1)).toEqual(allowedHistory);
        expect(await fixture.findIncident(incidentId)).toMatchObject({
          user_id: calderPikeUser.userId,
        });
        const savedMessages = await fixture.messages(incidentId);
        expect(savedMessages.results).toHaveLength(2);
        expect(savedMessages.results).toMatchObject([
          {
            message_id: messageId,
            role: 'user',
            content: customerMessage,
            sequence_number: 1,
          },
          {
            message_id: `AST-${messageId}`,
            role: 'assistant',
            content: assistantMessage,
            sequence_number: 2,
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );

  it.each([
    { invalid: 'a missing message ID', caseId: 'MISSING-MESSAGE-ID' },
    { invalid: 'a missing incident ID', caseId: 'MISSING-INCIDENT-ID' },
    { invalid: 'a malformed incident ID', caseId: 'MALFORMED-INCIDENT-ID' },
    { invalid: 'a malformed message ID', caseId: 'MALFORMED-MESSAGE-ID' },
  ])(
    'rejects $invalid in a paired-ID request before model or database activity and allows a corrected retry',
    async ({ caseId }) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-${caseId}`;
      const messageId = `MSG-${caseId}`;
      // Append one forbidden character while preserving the valid prefix and length.
      const malformedIncidentId = `${incidentId}!`;
      const rejectedIds =
        caseId === 'MISSING-MESSAGE-ID'
          ? { incidentId }
          : caseId === 'MISSING-INCIDENT-ID'
            ? { messageId }
            : caseId === 'MALFORMED-INCIDENT-ID'
              ? { incidentId: malformedIncidentId, messageId }
              : { incidentId, messageId: `${messageId}!` };
      const checkedIncidentIds: [string, ...string[]] = [incidentId];
      if (caseId === 'MALFORMED-INCIDENT-ID')
        checkedIncidentIds.push(malformedIncidentId);
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      const messages = [{ role: 'user', content: customerMessage }];
      expect((await fixture.incidents(...checkedIncidentIds)).results).toEqual(
        [],
      );
      expect((await fixture.messages(...checkedIncidentIds)).results).toEqual(
        [],
      );

      try {
        for (const id of checkedIncidentIds)
          await fixture.trackTemporaryIncident(id, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(assistantMessage);
        const makeRequest = (corrected: boolean) => {
          const request = session.request({
            messages,
            ...(corrected ? { incidentId, messageId } : rejectedIds),
          });
          request.headers.set('Origin', new URL(request.url).origin);
          request.headers.set('Sec-Fetch-Site', 'same-origin');
          return request;
        };
        const rejectedRequest = makeRequest(false);
        expect(await rejectedRequest.clone().json()).toEqual({
          ...rejectedIds,
          messages,
        });
        const prepareSpy = vi.spyOn(database, 'prepare');
        try {
          const rejected = await POST(rejectedRequest);
          expect(rejected.status).toBe(400);
          expect(await rejected.json()).toEqual({
            error: 'Enter a valid incident and message ID.',
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(prepareSpy).not.toHaveBeenCalled();
        } finally {
          prepareSpy.mockRestore();
        }
        expect(
          (await fixture.incidents(...checkedIncidentIds)).results,
        ).toEqual([]);
        expect((await fixture.messages(...checkedIncidentIds)).results).toEqual(
          [],
        );

        // Correct only the invalid ID field; the message now saves as one exchange.
        const retried = await POST(makeRequest(true));
        expect(retried.status).toBe(200);
        expect(await retried.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(await fixture.findIncident(incidentId)).toMatchObject({
          user_id: calderPikeUser.userId,
        });
        const savedMessages = await fixture.messages(incidentId);
        expect(savedMessages.results).toHaveLength(2);
        expect(savedMessages.results).toMatchObject([
          {
            message_id: messageId,
            role: 'user',
            content: customerMessage,
            sequence_number: 1,
          },
          {
            message_id: `AST-${messageId}`,
            role: 'assistant',
            content: assistantMessage,
            sequence_number: 2,
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
      expect((await fixture.incidents(...checkedIncidentIds)).results).toEqual(
        [],
      );
      expect((await fixture.messages(...checkedIncidentIds)).results).toEqual(
        [],
      );
    },
  );

  it('rejects malformed request JSON without model calls or saved messages and allows a corrected retry', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-MALFORMED-REQUEST-JSON';
    const messageId = 'MSG-MALFORMED-REQUEST-JSON';
    const customerMessage = 'Help with a shipment.';
    const assistantMessage = 'Which shipment do you need help with?';
    const payload = {
      incidentId,
      messageId,
      messages: [{ role: 'user', content: customerMessage }],
    };
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const fetchMock = fixture.mockModel(assistantMessage);
      const makeRequest = (malformed: boolean) => {
        const request = session.request(payload);
        request.headers.set('Origin', new URL(request.url).origin);
        request.headers.set('Sec-Fetch-Site', 'same-origin');
        // Preserve the valid session and payload fields; remove only the closing brace.
        return malformed
          ? new Request(request, {
              method: 'POST',
              body: JSON.stringify(payload).slice(0, -1),
            })
          : request;
      };

      const prepareSpy = vi.spyOn(database, 'prepare');
      try {
        const rejected = await POST(makeRequest(true));
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({
          error: 'The request was not valid JSON.',
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(prepareSpy).not.toHaveBeenCalled();
      } finally {
        prepareSpy.mockRestore();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      // Correcting only the JSON syntax must allow one complete exchange to save.
      const retried = await POST(makeRequest(false));
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await fixture.findIncident(incidentId)).toMatchObject({
        user_id: calderPikeUser.userId,
      });
      const savedMessages = await fixture.messages(incidentId);
      expect(savedMessages.results).toHaveLength(2);
      expect(savedMessages.results).toMatchObject([
        {
          message_id: messageId,
          role: 'user',
          content: customerMessage,
          sequence_number: 1,
        },
        {
          message_id: `AST-${messageId}`,
          role: 'assistant',
          content: assistantMessage,
          sequence_number: 2,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it.each(['missing', 'unknown'])(
    'rejects chat requests when the session token is %s before generating, saving, or replaying replies',
    async (tokenState) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-${tokenState.toUpperCase()}-SESSION-COOKIE`;
      const messageId = `MSG-${tokenState.toUpperCase()}-SESSION-COOKIE`;
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        // A valid-length token with no corresponding session, not a malformed cookie.
        const unknownToken = 'A'.repeat(43);
        if (tokenState === 'unknown') {
          const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(unknownToken),
          );
          const tokenHash = btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          expect(
            await database
              .prepare('SELECT session_id FROM sessions WHERE token_hash = ?')
              .bind(tokenHash)
              .first(),
          ).toBeNull();
        }
        const fetchMock = fixture.mockModel(assistantMessage);
        const makeRequest = (authenticated: boolean) => {
          const request = session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });
          request.headers.set('Origin', new URL(request.url).origin);
          request.headers.set('Sec-Fetch-Site', 'same-origin');
          expect(request.headers.has('Cookie')).toBe(true);
          // Only the session cookie changes; origin, IDs, and payload remain valid.
          if (!authenticated) {
            if (tokenState === 'missing') request.headers.delete('Cookie');
            else {
              const unknownCookie = `sable_session=${unknownToken}`;
              expect(request.headers.get('Cookie')).not.toBe(unknownCookie);
              request.headers.set('Cookie', unknownCookie);
            }
          }
          expect(request.headers.has('Cookie')).toBe(
            authenticated || tokenState === 'unknown',
          );
          return request;
        };
        const batchSpy = vi.spyOn(database, 'batch');
        try {
          const denied = await POST(makeRequest(false));
          expect(denied.status).toBe(401);
          expect(await denied.json()).toEqual({
            error: 'Authentication required.',
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(batchSpy).not.toHaveBeenCalled();
          expect(await fixture.findIncident(incidentId)).toBeNull();
          expect((await fixture.messages(incidentId)).results).toEqual([]);

          // Positive control: signing in allows the exact same request to save once.
          const allowed = await POST(makeRequest(true));
          expect(allowed.status).toBe(200);
          expect(await allowed.json()).toEqual({ message: assistantMessage });
          expect(fetchMock).toHaveBeenCalledOnce();
          const savedIncident = await fixture.findIncident(incidentId);
          const savedMessages = await fixture.messages(incidentId);
          expect(savedIncident).toMatchObject({
            user_id: calderPikeUser.userId,
          });
          expect(savedMessages.results).toHaveLength(2);
          expect(savedMessages.results).toMatchObject([
            {
              message_id: messageId,
              role: 'user',
              content: customerMessage,
              sequence_number: 1,
            },
            {
              message_id: `AST-${messageId}`,
              role: 'assistant',
              content: assistantMessage,
              sequence_number: 2,
            },
          ]);

          // Knowing saved IDs must not allow an anonymous caller to replay a reply.
          batchSpy.mockClear();
          const deniedReplay = await POST(makeRequest(false));
          expect(deniedReplay.status).toBe(401);
          expect(await deniedReplay.json()).toEqual({
            error: 'Authentication required.',
          });
          expect(fetchMock).toHaveBeenCalledOnce();
          expect(batchSpy).not.toHaveBeenCalled();
          expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
          expect((await fixture.messages(incidentId)).results).toEqual(
            savedMessages.results,
          );
        } finally {
          batchSpy.mockRestore();
        }
      } finally {
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );

  it.each(['Origin', 'Sec-Fetch-Site', 'same-site-Origin'])(
    'rejects untrusted %s chat requests with a valid session without generating, saving, or replaying replies',
    async (header) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-UNTRUSTED-${header.toUpperCase()}`;
      const messageId = `MSG-UNTRUSTED-${header.toUpperCase()}`;
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(assistantMessage);
        const makeRequest = (untrusted: boolean) => {
          const request = session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });
          // Change only the selected header; the cookie and payload stay identical.
          if (header === 'same-site-Origin') {
            const appUrl = new URL(request.url);
            const otherPortUrl = new URL(request.url);
            otherPortUrl.port = '8080';
            expect(otherPortUrl.hostname).toBe(appUrl.hostname);
            expect(otherPortUrl.origin).not.toBe(appUrl.origin);
            // Keep same-site metadata constant; only Origin changes for the control.
            request.headers.set('Sec-Fetch-Site', 'same-site');
            request.headers.set(
              'Origin',
              untrusted ? otherPortUrl.origin : appUrl.origin,
            );
          } else if (header === 'Origin')
            request.headers.set(
              'Origin',
              untrusted
                ? 'https://untrusted.example'
                : new URL(request.url).origin,
            );
          else {
            // Exercise fetch metadata independently of the Origin check.
            expect(request.headers.has('Origin')).toBe(false);
            request.headers.set(
              'Sec-Fetch-Site',
              untrusted ? 'cross-site' : 'same-origin',
            );
          }
          return request;
        };

        const denied = await POST(makeRequest(true));
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({
          error: 'Cross-origin access denied.',
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await fixture.findIncident(incidentId)).toBeNull();
        expect((await fixture.messages(incidentId)).results).toEqual([]);

        // Positive control: the same session and IDs work from the app's own origin.
        const allowed = await POST(makeRequest(false));
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledOnce();
        const savedIncident = await fixture.findIncident(incidentId);
        const savedMessages = await fixture.messages(incidentId);
        expect(savedIncident).toMatchObject({ user_id: calderPikeUser.userId });
        expect(savedMessages.results).toHaveLength(2);
        expect(savedMessages.results).toMatchObject([
          {
            message_id: messageId,
            role: 'user',
            content: customerMessage,
            sequence_number: 1,
          },
          {
            message_id: `AST-${messageId}`,
            role: 'assistant',
            content: assistantMessage,
            sequence_number: 2,
          },
        ]);

        // Completed exchanges must not bypass request trust checks through cached replay.
        const deniedReplay = await POST(makeRequest(true));
        expect(deniedReplay.status).toBe(403);
        expect(await deniedReplay.json()).toEqual({
          error: 'Cross-origin access denied.',
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
        expect((await fixture.messages(incidentId)).results).toEqual(
          savedMessages.results,
        );
      } finally {
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );

  it.each([
    {
      failure: 'timeout',
      expectedStatus: 504,
      expectedError:
        'The local model took too long to respond. Please try again.',
    },
    {
      failure: 'timeout-existing-incident',
      expectedStatus: 504,
      expectedError:
        'The local model took too long to respond. Please try again.',
    },
    {
      failure: 'body-timeout',
      expectedStatus: 504,
      expectedError:
        'The local model took too long to respond. Please try again.',
    },
    {
      failure: 'body-connection',
      expectedStatus: 502,
      expectedError:
        'The local model returned an invalid response. Please try again.',
    },
    {
      failure: 'connection',
      expectedStatus: 503,
      expectedError:
        'The local model is not reachable. Start the app with `npm run dev` and try again.',
    },
    {
      failure: 'HTTP',
      expectedStatus: 502,
      expectedError:
        'The local model could not complete that request. Please try again.',
    },
    {
      failure: 'malformed-JSON',
      expectedStatus: 502,
      expectedError:
        'The local model returned an invalid response. Please try again.',
    },
    {
      failure: 'empty-reply',
      replyContent: '',
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'whitespace-only-reply',
      replyContent: ' \t\r\n ',
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'non-string-reply',
      replyContent: { text: 'This structured reply must not be saved.' },
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'missing-choices',
      replyPayload: {
        error: { message: 'test: private upstream diagnostics' },
      },
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'empty-choices',
      replyPayload: { choices: [] },
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'missing-message',
      replyPayload: { choices: [{ index: 0, finish_reason: 'stop' }] },
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
    {
      failure: 'missing-content',
      replyPayload: { choices: [{ message: { role: 'assistant' } }] },
      expectedStatus: 502,
      expectedError:
        'The local model returned an empty response. Please try again.',
    },
  ])(
    'handles model $failure failures without changing saved records and permits a clean retry',
    async ({
      failure,
      replyContent,
      replyPayload,
      expectedStatus,
      expectedError,
    }) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-MODEL-${failure.toUpperCase()}-FAILURE`;
      const messageId = `MSG-MODEL-${failure.toUpperCase()}-FAILURE`;
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      let restoreTimeout: (() => void) | undefined;
      let verifyTimeout: (() => void) | undefined;
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const hasExistingIncident = failure === 'timeout-existing-incident';
        if (hasExistingIncident) {
          await saveSupportExchange(
            database,
            calderPikeUser,
            incidentId,
            `PRIOR-${messageId}`,
            'Existing shipment investigation.',
            'Please provide the shipment reference.',
          );
          await database
            .prepare(
              'UPDATE support_incidents SET updated_at = ? WHERE incident_id = ?',
            )
            .bind('2026-01-01T00:00:00.000Z', incidentId)
            .run();
        }
        const initialIncident = await fixture.findIncident(incidentId);
        const initialMessages = await fixture.messages(incidentId);
        const initialContents = await fixture.messageContents(incidentId);
        expect(initialMessages.results).toHaveLength(
          hasExistingIncident ? 2 : 0,
        );
        if (hasExistingIncident) expect(initialIncident).not.toBeNull();
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(assistantMessage);
        let modelResponse: Response | undefined;
        if (
          failure === 'timeout' ||
          failure === 'body-timeout' ||
          hasExistingIncident
        ) {
          const controller = new AbortController();
          let bodyReadStarted = false;
          const timeoutReason = new DOMException(
            'test: private upstream timeout details',
            'TimeoutError',
          );
          // Keep the configured deadline under test without waiting two minutes.
          const timeoutMock = vi
            .spyOn(AbortSignal, 'timeout')
            .mockReturnValueOnce(controller.signal);
          restoreTimeout = () => timeoutMock.mockRestore();
          verifyTimeout = () => {
            expect(timeoutMock).toHaveBeenCalledExactlyOnceWith(120_000);
            expect(controller.signal.aborted).toBe(true);
            expect(controller.signal.reason).toBe(timeoutReason);
            expect(bodyReadStarted).toBe(failure === 'body-timeout');
          };
          fetchMock.mockImplementationOnce((_url, request) => {
            const signal = request?.signal;
            if (signal !== controller.signal)
              throw new Error(
                'test: model request did not use the timeout signal',
              );
            if (failure === 'body-timeout') {
              const body = new ReadableStream<Uint8Array>(
                {
                  start(stream) {
                    stream.enqueue(new TextEncoder().encode('{"choices":['));
                  },
                  pull(stream) {
                    bodyReadStarted = true;
                    signal.addEventListener(
                      'abort',
                      () => stream.error(signal.reason),
                      { once: true },
                    );
                    queueMicrotask(() => controller.abort(timeoutReason));
                  },
                },
                // Do not trigger the timeout until the consumer reads the body.
                { highWaterMark: 0 },
              );
              modelResponse = new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
              return Promise.resolve(modelResponse);
            }
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
              queueMicrotask(() => controller.abort(timeoutReason));
            });
          });
        } else if (failure === 'body-connection') {
          const body = new ReadableStream<Uint8Array>(
            {
              start(stream) {
                stream.enqueue(new TextEncoder().encode('{"choices":['));
              },
              pull(stream) {
                stream.error(
                  new TypeError('test: private upstream socket reset'),
                );
              },
            },
            { highWaterMark: 0 },
          );
          modelResponse = new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
          fetchMock.mockResolvedValueOnce(modelResponse);
        } else if (failure === 'connection') {
          fetchMock.mockRejectedValueOnce(
            new TypeError('fetch failed', {
              cause: new Error('test: private model connection details'),
            }),
          );
        } else if (failure === 'HTTP') {
          // Even a success-shaped payload must be ignored on an HTTP error.
          modelResponse = Response.json(
            {
              error: { message: 'test: private upstream diagnostics' },
              choices: [
                {
                  message: {
                    content: 'This error response must not be saved.',
                  },
                },
              ],
            },
            { status: 503 },
          );
          fetchMock.mockResolvedValueOnce(modelResponse);
        } else if (failure === 'malformed-JSON') {
          modelResponse = new Response(
            '{"privateDiagnostics":"test: private upstream details","choices":',
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
          fetchMock.mockResolvedValueOnce(modelResponse);
        } else {
          modelResponse = Response.json(
            replyPayload ?? {
              choices: [{ message: { content: replyContent } }],
            },
          );
          fetchMock.mockResolvedValueOnce(modelResponse);
        }
        const makeRequest = () =>
          session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });

        const failed = await POST(makeRequest());
        verifyTimeout?.();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(failed.status).toBe(expectedStatus);
        expect(await failed.json()).toEqual({ error: expectedError });
        if (modelResponse)
          expect(modelResponse.bodyUsed).toBe(failure !== 'HTTP');
        expect(await fixture.findIncident(incidentId)).toEqual(initialIncident);
        expect((await fixture.messages(incidentId)).results).toEqual(
          initialMessages.results,
        );

        // The same IDs remain usable after the model server recovers.
        const retry = await POST(makeRequest());
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await fixture.findIncidentOwner(incidentId)).toEqual({
          user_id: calderPikeUser.userId,
        });
        expect((await fixture.messageContents(incidentId)).results).toEqual([
          ...initialContents.results,
          {
            message_id: messageId,
            sequence_number: initialMessages.results.length + 1,
            role: 'user',
            content: customerMessage,
          },
          {
            message_id: `AST-${messageId}`,
            sequence_number: initialMessages.results.length + 2,
            role: 'assistant',
            content: assistantMessage,
          },
        ]);
        const savedIncident = await fixture.findIncident(incidentId);
        const savedMessages = await fixture.messages(incidentId);
        expect(
          savedMessages.results.slice(0, initialMessages.results.length),
        ).toEqual(initialMessages.results);
        const replay = await POST(makeRequest());
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
        expect((await fixture.messages(incidentId)).results).toEqual(
          savedMessages.results,
        );
      } finally {
        restoreTimeout?.();
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
    },
  );

  it.each(['failure', 'timeout'])(
    'reports a pre-inference database lookup %s without calling the model or saving an incident',
    async (failure) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-PREFLIGHT-READ-${failure.toUpperCase()}`;
      const messageId = `MSG-PREFLIGHT-READ-${failure.toUpperCase()}`;
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
      const originalPrepare = database.prepare.bind(database);
      let exchangeReads = 0;
      const prepareMock = vi
        .spyOn(database, 'prepare')
        .mockImplementation((sql) => {
          if (/SELECT\s+customer\.content AS customerMessage/i.test(sql)) {
            exchangeReads += 1;
            if (exchangeReads === 1)
              throw failure === 'timeout'
                ? new DOMException(
                    'test: private preflight timeout details',
                    'TimeoutError',
                  )
                : new Error('test: private preflight lookup failure');
          }
          return originalPrepare(sql);
        });

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(assistantMessage);
        const makeRequest = () =>
          session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });
        const failed = await POST(makeRequest());
        expect(exchangeReads).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({
          error: 'Support records could not be loaded. Please try again.',
        });
        expect(await fixture.findIncident(incidentId)).toBeNull();
        expect((await fixture.messages(incidentId)).results).toEqual([]);

        const retry = await POST(makeRequest());
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ message: assistantMessage });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(exchangeReads).toBe(3);
        expect(await fixture.findIncidentOwner(incidentId)).toEqual({
          user_id: calderPikeUser.userId,
        });
        expect((await fixture.messageContents(incidentId)).results).toEqual([
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
        prepareMock.mockRestore();
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
      expect(prepareMock).not.toHaveBeenCalled();
    },
  );

  it.each(['failure', 'timeout'])(
    'replays a committed exchange after a confirmation read %s without generating or saving duplicates',
    async (failure) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentId = `INC-CONFIRMATION-READ-${failure.toUpperCase()}`;
      const messageId = `MSG-CONFIRMATION-READ-${failure.toUpperCase()}`;
      const customerMessage = 'Help with a shipment.';
      const assistantMessage = 'Which shipment do you need help with?';
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
      const originalPrepare = database.prepare.bind(database);
      let exchangeReads = 0;
      const prepareMock = vi
        .spyOn(database, 'prepare')
        .mockImplementation((sql) => {
          // The first exchange lookup is preflight. Only fail the second lookup,
          // which confirms the committed write; execute all writes against real D1.
          if (/SELECT\s+customer\.content AS customerMessage/i.test(sql)) {
            exchangeReads += 1;
            if (exchangeReads === 2)
              throw failure === 'timeout'
                ? new DOMException(
                    'test: private confirmation timeout details',
                    'TimeoutError',
                  )
                : new Error('test: private confirmation read failure');
          }
          return originalPrepare(sql);
        });

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        const fetchMock = fixture.mockModel(
          assistantMessage,
          'This must not replace the saved reply.',
        );
        const makeRequest = () =>
          session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });
        const failed = await POST(makeRequest());
        expect(exchangeReads).toBe(2);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({
          error:
            'We could not confirm your support message was saved. Please try again.',
        });
        // Independent queries prove the transaction committed despite the error.
        const savedIncident = await fixture.findIncident(incidentId);
        const savedMessages = await fixture.messages(incidentId);
        expect(savedIncident).toMatchObject({
          incident_id: incidentId,
          user_id: calderPikeUser.userId,
          title: customerMessage,
        });
        expect(savedMessages.results).toHaveLength(2);
        expect(savedMessages.results).toMatchObject([
          {
            incident_id: incidentId,
            message_id: messageId,
            sequence_number: 1,
            role: 'user',
            content: customerMessage,
          },
          {
            incident_id: incidentId,
            message_id: `AST-${messageId}`,
            sequence_number: 2,
            role: 'assistant',
            content: assistantMessage,
          },
        ]);

        for (let retry = 0; retry < 2; retry += 1) {
          const response = await POST(makeRequest());
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ message: assistantMessage });
          expect(fetchMock).toHaveBeenCalledOnce();
          expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
          expect((await fixture.messages(incidentId)).results).toEqual(
            savedMessages.results,
          );
        }
        expect(exchangeReads).toBe(4);
      } finally {
        prepareMock.mockRestore();
        await fixture.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);
      expect(prepareMock).not.toHaveBeenCalled();
    },
  );

  it('reports a database save failure without blaming the healthy model or exposing storage details', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-API-SAVE-FAILURE';
    const messageId = 'MSG-API-SAVE-FAILURE';
    const customerMessage = 'Help with a shipment.';
    const assistantMessage = 'Which shipment do you need help with?';
    const findTrigger = () =>
      database
        .prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'test_support_api_save_failure'`)
        .first();
    const dropTrigger = () =>
      database.prepare('DROP TRIGGER test_support_api_save_failure').run();
    let triggerCreated = false;
    expect(await findTrigger()).toBeNull();
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const fetchMock = fixture.mockModel(assistantMessage);
      await database
        .prepare(`CREATE TRIGGER test_support_api_save_failure
        BEFORE INSERT ON support_messages
        WHEN NEW.message_id = 'AST-MSG-API-SAVE-FAILURE'
          AND NEW.incident_id = 'INC-API-SAVE-FAILURE' AND NEW.role = 'assistant'
          AND EXISTS (SELECT 1 FROM support_messages
            WHERE message_id = 'MSG-API-SAVE-FAILURE'
              AND incident_id = NEW.incident_id AND role = 'user')
        BEGIN
          SELECT RAISE(ABORT, 'test: private storage failure details');
        END`)
        .run();
      triggerCreated = true;
      const makeRequest = () =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });

      const failed = await POST(makeRequest());
      expect(fetchMock).toHaveBeenCalledOnce();
      // Exact public response: no generated answer, SQL details, or model advice.
      expect(await failed.json()).toEqual({
        error:
          'We could not confirm your support message was saved. Please try again.',
      });
      expect(failed.status).toBe(500);
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      await dropTrigger();
      triggerCreated = false;
      expect(await findTrigger()).toBeNull();
      const retry = await POST(makeRequest());
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await fixture.findIncidentOwner(incidentId)).toEqual({
        user_id: calderPikeUser.userId,
      });
      expect((await fixture.messageContents(incidentId)).results).toEqual([
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
      const savedIncident = await fixture.findIncident(incidentId);
      const savedMessages = await fixture.messages(incidentId);
      const replay = await POST(makeRequest());
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
      expect((await fixture.messages(incidentId)).results).toEqual(
        savedMessages.results,
      );
    } finally {
      try {
        if (triggerCreated) await dropTrigger();
      } finally {
        await fixture.cleanup();
      }
    }
    expect(await findTrigger()).toBeNull();
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it('reports a database save timeout as a persistence failure and permits a clean retry', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-API-SAVE-TIMEOUT';
    const messageId = 'MSG-API-SAVE-TIMEOUT';
    const customerMessage = 'Help with a shipment.';
    const assistantMessage = 'Which shipment do you need help with?';
    let restoreBatch: (() => void) | undefined;
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const fetchMock = fixture.mockModel(assistantMessage);
      // Reject before executing the transaction. Subsequent batches use real D1.
      const batchMock = vi
        .spyOn(database, 'batch')
        .mockRejectedValueOnce(
          new DOMException(
            'test: private storage timeout details',
            'TimeoutError',
          ),
        );
      restoreBatch = () => batchMock.mockRestore();
      const makeRequest = () =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });

      const failed = await POST(makeRequest());
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(batchMock).toHaveBeenCalledOnce();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({
        error:
          'We could not confirm your support message was saved. Please try again.',
      });
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      const retry = await POST(makeRequest());
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(batchMock).toHaveBeenCalledTimes(2);
      expect(await fixture.findIncidentOwner(incidentId)).toEqual({
        user_id: calderPikeUser.userId,
      });
      expect((await fixture.messageContents(incidentId)).results).toEqual([
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
      const savedIncident = await fixture.findIncident(incidentId);
      const savedMessages = await fixture.messages(incidentId);
      const replay = await POST(makeRequest());
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(batchMock).toHaveBeenCalledTimes(2);
      expect(await fixture.findIncident(incidentId)).toEqual(savedIncident);
      expect((await fixture.messages(incidentId)).results).toEqual(
        savedMessages.results,
      );
    } finally {
      restoreBatch?.();
      await fixture.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it('returns and saves a grounded response under the authenticated user incident', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-VALID-RESPONSE-REGRESSION';
    const messageId = 'MSG-VALID-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return **RTN-2022-000014** is closed. Linked order: `SBL-2022-000118`; customer PO: `CPD-PO-220118`.';
    const findIncident = () => fixture.findIncidentOwner(incidentId);
    const savedMessages = () => fixture.messageContents(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const fetchMock = fixture.mockModel(assistantMessage);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const request = session.request({
        incidentId,
        messageId,
        messages: [{ role: 'user', content: customerMessage }],
      });
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
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('does not duplicate the saved exchange when the same chat message is retried', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-RETRY-RESPONSE-REGRESSION';
    const messageId = 'MSG-RETRY-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () => fixture.findIncidentOwner(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    fixture.mockModel(assistantMessage);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = () =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
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
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('replays the original saved reply without regenerating it on a completed retry', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-REPLAY-RESPONSE-REGRESSION';
    const messageId = 'MSG-REPLAY-RESPONSE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const regeneratedReply =
      'The linked order is SBL-2022-000118. Return RTN-2022-000014 has status closed.';
    const savedMessages = () => fixture.messages(incidentId);
    expect(await fixture.findIncident(incidentId)).toBeNull();

    const fetchMock = fixture.mockModel(originalReply, regeneratedReply);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = () =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
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
      await fixture.cleanup();
    }
    expect((await savedMessages()).results).toEqual([]);
  });

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
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
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
        expect(await beforeInvalidation.json()).toEqual({
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
        expect(await recovered.json()).toEqual({ message: privateReply });
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
              incidentId,
              messageId,
              messages: [{ role: 'user', content: customerMessage }],
            }),
          );
          expect(response.status).toBe(expectedStatus);
          expect(await response.json()).toEqual(
            status === 'active'
              ? { message: privateReply }
              : { error: 'Authentication required.' },
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

  it('denies another user replaying a saved reply with the same incident and message IDs', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const otherUser = await loadActiveUserFixture(database, 'USR-MCS-001');
    expect(otherUser.distributorId).not.toBe(calderPikeUser.distributorId);
    const incidentId = 'INC-REPLAY-ISOLATION-REGRESSION';
    const messageId = 'MSG-REPLAY-ISOLATION-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const privateReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const sessions: SupportApiSession[] = [];
    const makeRequest = (session: SupportApiSession) =>
      session.request({
        incidentId,
        messageId,
        messages: [{ role: 'user', content: customerMessage }],
      });
    const fetchMock = fixture.mockModel('No authorized return was found.');

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      for (const user of [calderPikeUser, otherUser]) {
        sessions.push(await fixture.session(user));
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
      expect(originalIncident).toMatchObject({
        user_id: calderPikeUser.userId,
      });
      expect(originalMessages.results).toHaveLength(2);

      // Positive control: this exact request replays successfully for its owner.
      const ownerResponse = await POST(makeRequest(sessions[0]));
      expect(ownerResponse.status).toBe(200);
      expect(await ownerResponse.json()).toEqual({ message: privateReply });
      expect(fetchMock).not.toHaveBeenCalled();

      // Only the session changes; knowing the IDs and prompt grants no access.
      const otherResponse = await POST(makeRequest(sessions[1]));
      expect(otherResponse.status).toBe(403);
      expect(await otherResponse.json()).toEqual({
        error: 'Incident access denied.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects reuse of a saved message ID with different customer text', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-MESSAGE-CONFLICT-REGRESSION';
    const messageId = 'MSG-MESSAGE-CONFLICT-REGRESSION';
    const originalText = 'Show return RTN-2022-000014.';
    const changedText = 'Which order is linked to return RTN-2022-000014?';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);

    const fetchMock = fixture.mockModel('The linked order is SBL-2022-000118.');

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = (content: string) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content }],
        });
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
      expect(originalIncident).toMatchObject({
        user_id: calderPikeUser.userId,
      });
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
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects reuse of a saved message ID in a different incident', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const sourceId = 'INC-CROSS-INCIDENT-SOURCE-REGRESSION';
    const targetId = 'INC-CROSS-INCIDENT-TARGET-REGRESSION';
    const messageId = 'MSG-CROSS-INCIDENT-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const incidents = () => fixture.incidents(sourceId, targetId);
    const savedMessages = () => fixture.messages(sourceId, targetId);
    expect((await incidents()).results).toEqual([]);
    expect((await savedMessages()).results).toEqual([]);

    const fetchMock = fixture.mockModel(originalReply);

    try {
      await fixture.trackTemporaryIncident(sourceId, calderPikeUser);
      await fixture.trackTemporaryIncident(targetId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = (incidentId: string) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
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
      await fixture.cleanup();
    }
    expect((await incidents()).results).toEqual([]);
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects a customer message ID that belongs to a saved assistant message', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-MESSAGE-ROLE-COLLISION-REGRESSION';
    const originalMessageId = 'MSG-MESSAGE-ROLE-COLLISION-REGRESSION';
    const assistantMessageId = `AST-${originalMessageId}`;
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
    const fetchMock = fixture.mockModel(originalReply);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = (messageId: string) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        originalMessageId,
        customerMessage,
        originalReply,
      );
      const originalIncident = await findIncident();
      const originalMessages = await savedMessages();
      expect(originalMessages.results).toHaveLength(2);
      expect(originalMessages.results[1]).toMatchObject({
        message_id: assistantMessageId,
        role: 'assistant',
        content: originalReply,
      });

      const response = await POST(makeRequest(assistantMessageId));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This message ID is already in use. Send a new message.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);

      const retry = await POST(makeRequest(originalMessageId));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: originalReply });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects a new exchange when its generated assistant ID is already in use', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-GENERATED-ID-COLLISION-REGRESSION';
    const newMessageId = 'MSG-GENERATED-ID-COLLISION-REGRESSION';
    const occupiedId = `AST-${newMessageId}`;
    const customerMessage = 'Show return RTN-2022-000014.';
    const originalReply =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
    const fetchMock = fixture.mockModel(originalReply);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = (messageId: string) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
      // This is a valid saved customer ID, but it occupies the slot that the
      // next request would use for its generated assistant reply.
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        occupiedId,
        customerMessage,
        originalReply,
      );
      const originalIncident = await findIncident();
      const originalMessages = await savedMessages();
      expect(originalMessages.results).toHaveLength(2);
      expect(originalMessages.results[0]).toMatchObject({
        message_id: occupiedId,
        role: 'user',
        content: customerMessage,
      });
      expect(
        originalMessages.results.some((row) => row.message_id === newMessageId),
      ).toBe(false);

      const response = await POST(makeRequest(newMessageId));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This message ID is already in use. Send a new message.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);

      const retry = await POST(makeRequest(occupiedId));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: originalReply });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('completes a saved customer message without duplicating it or leaving a sequence gap', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-INCOMPLETE-EXCHANGE-REGRESSION';
    const messageId = 'MSG-INCOMPLETE-EXCHANGE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const createdAt = '2026-09-01T12:00:00.000Z';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
    const fetchMock = fixture.mockModel(
      assistantMessage,
      'The linked order is SBL-2022-000118.',
    );

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = () =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
      // Model an interrupted exchange directly; do not use the saving function
      // under test to manufacture the missing-reply state.
      await database.batch([
        database
          .prepare(`INSERT INTO support_incidents
          (incident_id, user_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`)
          .bind(
            incidentId,
            calderPikeUser.userId,
            'Return inquiry',
            createdAt,
            createdAt,
          ),
        database
          .prepare(`INSERT INTO support_messages
          (message_id, incident_id, sequence_number, role, content, created_at)
          VALUES (?, ?, 1, 'user', ?, ?)`)
          .bind(messageId, incidentId, customerMessage, createdAt),
      ]);
      const before = await savedMessages();
      expect(before.results).toEqual([
        {
          message_id: messageId,
          incident_id: incidentId,
          sequence_number: 1,
          role: 'user',
          content: customerMessage,
          created_at: createdAt,
        },
      ]);

      const response = await POST(makeRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledOnce();
      const completed = await savedMessages();
      expect(completed.results).toHaveLength(2);
      expect(completed.results[0]).toEqual(before.results[0]);
      expect(completed.results[1]).toMatchObject({
        message_id: `AST-${messageId}`,
        incident_id: incidentId,
        sequence_number: 2,
        role: 'assistant',
        content: assistantMessage,
      });
      expect(await findIncident()).toMatchObject({
        user_id: calderPikeUser.userId,
        title: 'Return inquiry',
        created_at: createdAt,
      });

      const retry = await POST(makeRequest());
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((await savedMessages()).results).toEqual(completed.results);
    } finally {
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it('rejects recovery when another message occupies the missing reply position', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-OCCUPIED-REPLY-POSITION-REGRESSION';
    const messageId = 'MSG-OCCUPIED-REPLY-POSITION-REGRESSION';
    const laterMessageId = 'MSG-LATER-EXCHANGE-REGRESSION';
    const customerMessage = 'Show return RTN-2022-000014.';
    const assistantMessage =
      'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.';
    const createdAt = '2026-09-01T12:00:00.000Z';
    const findIncident = () => fixture.findIncident(incidentId);
    const savedMessages = () => fixture.messages(incidentId);
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
    const fetchMock = fixture.mockModel(assistantMessage);

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      const makeRequest = (id: string) =>
        session.request({
          incidentId,
          messageId: id,
          messages: [{ role: 'user', content: customerMessage }],
        });
      await database.batch([
        database
          .prepare(`INSERT INTO support_incidents
          (incident_id, user_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`)
          .bind(
            incidentId,
            calderPikeUser.userId,
            'Return inquiry',
            createdAt,
            createdAt,
          ),
        database
          .prepare(`INSERT INTO support_messages
          (message_id, incident_id, sequence_number, role, content, created_at)
          VALUES (?, ?, 1, 'user', ?, ?)`)
          .bind(messageId, incidentId, customerMessage, createdAt),
      ]);
      // A later exchange now occupies positions 2 and 3. Recovering the first
      // message must neither overwrite these rows nor silently skip its reply.
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        laterMessageId,
        customerMessage,
        assistantMessage,
      );
      const originalIncident = await findIncident();
      const originalMessages = await savedMessages();
      expect(originalMessages.results).toHaveLength(3);
      expect(originalMessages.results).toMatchObject([
        { message_id: messageId, role: 'user', sequence_number: 1 },
        { message_id: laterMessageId, role: 'user', sequence_number: 2 },
        {
          message_id: `AST-${laterMessageId}`,
          role: 'assistant',
          sequence_number: 3,
        },
      ]);

      const response = await POST(makeRequest(messageId));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This message ID is already in use. Send a new message.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findIncident()).toEqual(originalIncident);
      expect((await savedMessages()).results).toEqual(originalMessages.results);

      const laterRetry = await POST(makeRequest(laterMessageId));
      expect(laterRetry.status).toBe(200);
      expect(await laterRetry.json()).toEqual({ message: assistantMessage });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await savedMessages()).results).toEqual(originalMessages.results);
    } finally {
      await fixture.cleanup();
    }
    expect(await findIncident()).toBeNull();
    expect((await savedMessages()).results).toEqual([]);
  });

  it.each(['an existing', 'a new'] as const)(
    'returns the single saved reply to simultaneous duplicate requests in %s incident',
    async (incidentState) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const isExisting = incidentState === 'an existing';
      const suffix = isExisting ? 'EXISTING' : 'NEW';
      const incidentId = `INC-CONCURRENT-RETRY-${suffix}`;
      const messageId = `MSG-CONCURRENT-RETRY-${suffix}`;
      const customerMessage = 'Show return RTN-2022-000014.';
      const replies = [
        'Return RTN-2022-000014 is closed. Linked order: SBL-2022-000118.',
        'The linked order is SBL-2022-000118. Return RTN-2022-000014 is closed.',
      ];
      const savedMessages = () => fixture.messages(incidentId);
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await savedMessages()).results).toEqual([]);

      const concurrent = createConcurrentSupportFixture(
        fixture,
        (_prompt, callIndex) =>
          replies[Math.min(callIndex, replies.length - 1)],
      );
      const { fetchMock } = concurrent;

      try {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await fixture.session(calderPikeUser);
        if (isExisting) {
          await saveSupportExchange(
            database,
            calderPikeUser,
            incidentId,
            'MSG-CONCURRENT-RETRY-SETUP',
            'Hello.',
            'How can I help?',
          );
        }
        const before = await savedMessages();
        const priorCount = isExisting ? 2 : 0;
        expect(before.results).toHaveLength(priorCount);
        const makeRequest = () =>
          session.request({
            incidentId,
            messageId,
            messages: [{ role: 'user', content: customerMessage }],
          });
        const responses = await concurrent.run(
          () => POST(makeRequest()),
          () => POST(makeRequest()),
        );
        expect(concurrent.timedOut).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(responses.map((response) => response.status)).toEqual([
          200, 200,
        ]);

        const completed = await savedMessages();
        expect(completed.results).toHaveLength(priorCount + 2);
        expect(completed.results.slice(0, priorCount)).toEqual(before.results);
        expect(completed.results.slice(priorCount)).toMatchObject([
          {
            message_id: messageId,
            role: 'user',
            sequence_number: priorCount + 1,
            content: customerMessage,
          },
          {
            message_id: `AST-${messageId}`,
            role: 'assistant',
            sequence_number: priorCount + 2,
          },
        ]);
        const savedReply = completed.results[priorCount + 1].content;
        expect(replies).toContain(savedReply);
        expect(
          await Promise.all(responses.map((response) => response.json())),
        ).toEqual([{ message: savedReply }, { message: savedReply }]);
        expect(await fixture.findIncidentOwner(incidentId)).toEqual({
          user_id: calderPikeUser.userId,
        });
        expect((await fixture.incidents(incidentId)).results).toHaveLength(1);

        const retry = await POST(makeRequest());
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ message: savedReply });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await savedMessages()).results).toEqual(completed.results);
      } finally {
        await concurrent.cleanup();
      }
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await savedMessages()).results).toEqual([]);
    },
  );

  it('isolates concurrent claims to the same new incident by different users', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-CONCURRENT-OWNER-REGRESSION';
    const otherUser = await loadActiveUserFixture(database, 'USR-MCS-001');
    const participants = [
      {
        user: calderPikeUser,
        messageId: 'MSG-CONCURRENT-OWNER-CALDER',
        prompt: 'I need help with my Calder Pike account.',
        reply: 'How can I help with your Calder Pike account?',
      },
      {
        user: otherUser,
        messageId: 'MSG-CONCURRENT-OWNER-MERIDIAN',
        prompt: 'I need help with my Meridian account.',
        reply: 'How can I help with your Meridian account?',
      },
    ];
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    const concurrent = createConcurrentSupportFixture(fixture, (prompt) => {
      const participant = participants.find((entry) => entry.prompt === prompt);
      if (!participant) throw new Error('Unexpected model request');
      return participant.reply;
    });
    const { fetchMock } = concurrent;

    try {
      const sessions: SupportApiSession[] = [];
      for (const participant of participants) {
        // Either user may win; register both scoped cleanups while the ID is absent.
        await fixture.trackTemporaryIncident(incidentId, participant.user);
        sessions.push(await fixture.session(participant.user));
      }
      const makeRequest = (sessionIndex: number, messageIndex = sessionIndex) =>
        sessions[sessionIndex].request({
          incidentId,
          messageId: participants[messageIndex].messageId,
          messages: [
            { role: 'user', content: participants[messageIndex].prompt },
          ],
        });
      // Both authenticated requests pass preflight before either can persist.
      const responses = await concurrent.run(
        () => POST(makeRequest(0)),
        () => POST(makeRequest(1)),
      );
      expect(concurrent.timedOut).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const owner = await fixture.findIncidentOwner(incidentId);
      const winnerIndex = participants.findIndex(
        (entry) => entry.user.userId === owner?.user_id,
      );
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      const loserIndex = 1 - winnerIndex;
      const winner = participants[winnerIndex];
      const savedIncidents = await fixture.incidents(incidentId);
      expect(savedIncidents.results).toHaveLength(1);
      const savedMessages = await fixture.messages(incidentId);
      expect(savedMessages.results).toHaveLength(2);
      expect(savedMessages.results).toMatchObject([
        {
          message_id: winner.messageId,
          sequence_number: 1,
          role: 'user',
          content: winner.prompt,
        },
        {
          message_id: `AST-${winner.messageId}`,
          sequence_number: 2,
          role: 'assistant',
          content: winner.reply,
        },
      ]);
      expect(responses[winnerIndex].status).toBe(200);
      expect(await responses[winnerIndex].json()).toEqual({
        message: winner.reply,
      });
      expect(responses[loserIndex].status).toBe(403);
      expect(await responses[loserIndex].json()).toEqual({
        error: 'Incident access denied.',
      });

      // Knowing the winner's exact message ID and prompt must not enable replay.
      const deniedRetry = await POST(makeRequest(loserIndex, winnerIndex));
      expect(deniedRetry.status).toBe(403);
      expect(await deniedRetry.json()).toEqual({
        error: 'Incident access denied.',
      });
      const ownerRetry = await POST(makeRequest(winnerIndex));
      expect(ownerRetry.status).toBe(200);
      expect(await ownerRetry.json()).toEqual({ message: winner.reply });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await fixture.incidents(incidentId)).results).toEqual(
        savedIncidents.results,
      );
      expect((await fixture.messages(incidentId)).results).toEqual(
        savedMessages.results,
      );
    } finally {
      await concurrent.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it('preserves both distinct exchanges submitted concurrently to the same incident', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-CONCURRENT-DISTINCT-REGRESSION';
    const exchanges = [
      {
        messageId: 'MSG-CONCURRENT-DISTINCT-ONE',
        prompt: 'Help with a shipment.',
        reply: 'Which shipment do you need help with?',
      },
      {
        messageId: 'MSG-CONCURRENT-DISTINCT-TWO',
        prompt: 'Help with a return.',
        reply: 'Which return do you need help with?',
      },
    ];
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    const concurrent = createConcurrentSupportFixture(fixture, (prompt) => {
      const exchange = exchanges.find((entry) => entry.prompt === prompt);
      if (!exchange) throw new Error('Unexpected model request');
      return exchange.reply;
    });
    const { fetchMock } = concurrent;

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-CONCURRENT-DISTINCT-SETUP',
        'Hello.',
        'How can I help?',
      );
      const before = await fixture.messages(incidentId);
      expect(before.results).toHaveLength(2);
      const makeRequest = (exchange: (typeof exchanges)[number]) =>
        session.request({
          incidentId,
          messageId: exchange.messageId,
          messages: [{ role: 'user', content: exchange.prompt }],
        });
      // Release both model responses together to overlap persistence, not inference.
      const responses = await concurrent.run(
        () => POST(makeRequest(exchanges[0])),
        () => POST(makeRequest(exchanges[1])),
      );
      expect(concurrent.timedOut).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const saved = await fixture.messages(incidentId);
      expect(saved.results).toHaveLength(6);
      expect(saved.results.slice(0, 2)).toEqual(before.results);
      expect(saved.results.map((row) => row.sequence_number)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      for (const [index, exchange] of exchanges.entries()) {
        const customerIndex = saved.results.findIndex(
          (row) => row.message_id === exchange.messageId,
        );
        expect([2, 4]).toContain(customerIndex);
        expect(
          saved.results.slice(customerIndex, customerIndex + 2),
        ).toMatchObject([
          {
            message_id: exchange.messageId,
            role: 'user',
            content: exchange.prompt,
          },
          {
            message_id: `AST-${exchange.messageId}`,
            role: 'assistant',
            content: exchange.reply,
          },
        ]);
        expect(responses[index].status).toBe(200);
        expect(await responses[index].json()).toEqual({
          message: exchange.reply,
        });
        const retry = await POST(makeRequest(exchange));
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ message: exchange.reply });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await fixture.messages(incidentId)).results).toEqual(
        saved.results,
      );
      expect((await fixture.incidents(incidentId)).results).toHaveLength(1);
      expect(await fixture.findIncidentOwner(incidentId)).toEqual({
        user_id: calderPikeUser.userId,
      });
    } finally {
      await concurrent.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it('rejects concurrent reuse of the same message ID with different text', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-CONCURRENT-TEXT-CONFLICT';
    const messageId = 'MSG-CONCURRENT-TEXT-CONFLICT';
    const exchanges = [
      {
        prompt: 'Help with a shipment.',
        reply: 'Which shipment do you need help with?',
      },
      {
        prompt: 'Help with a return.',
        reply: 'Which return do you need help with?',
      },
    ];
    const conflictBody = {
      error:
        'This message ID was already used for different text. Send a new message.',
    };
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);

    const concurrent = createConcurrentSupportFixture(fixture, (prompt) => {
      const exchange = exchanges.find((entry) => entry.prompt === prompt);
      if (!exchange) throw new Error('Unexpected model request');
      return exchange.reply;
    });
    const { fetchMock } = concurrent;

    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await fixture.session(calderPikeUser);
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-CONCURRENT-TEXT-SETUP',
        'Hello.',
        'How can I help?',
      );
      const before = await fixture.messages(incidentId);
      expect(before.results).toHaveLength(2);
      const makeRequest = (exchange: (typeof exchanges)[number]) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: exchange.prompt }],
        });
      // Both requests must pass the unsaved-message check before either saves.
      const responses = await concurrent.run(
        () => POST(makeRequest(exchanges[0])),
        () => POST(makeRequest(exchanges[1])),
      );
      expect(concurrent.timedOut).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const saved = await fixture.messages(incidentId);
      expect(saved.results).toHaveLength(4);
      expect(saved.results.slice(0, 2)).toEqual(before.results);
      const winnerIndex = exchanges.findIndex(
        (entry) => entry.prompt === saved.results[2].content,
      );
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      const winner = exchanges[winnerIndex];
      expect(saved.results.slice(2)).toMatchObject([
        {
          message_id: messageId,
          sequence_number: 3,
          role: 'user',
          content: winner.prompt,
        },
        {
          message_id: `AST-${messageId}`,
          sequence_number: 4,
          role: 'assistant',
          content: winner.reply,
        },
      ]);
      expect(responses[winnerIndex].status).toBe(200);
      expect(await responses[winnerIndex].json()).toEqual({
        message: winner.reply,
      });
      expect(responses[1 - winnerIndex].status).toBe(409);
      expect(await responses[1 - winnerIndex].json()).toEqual(conflictBody);
      const savedIncidents = await fixture.incidents(incidentId);
      expect(savedIncidents.results).toHaveLength(1);
      expect(await fixture.findIncidentOwner(incidentId)).toEqual({
        user_id: calderPikeUser.userId,
      });

      // Retry behavior must agree with the concurrent outcome without inference.
      for (const [index, exchange] of exchanges.entries()) {
        const retry = await POST(makeRequest(exchange));
        expect(retry.status).toBe(index === winnerIndex ? 200 : 409);
        expect(await retry.json()).toEqual(
          index === winnerIndex ? { message: winner.reply } : conflictBody,
        );
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await fixture.messages(incidentId)).results).toEqual(
        saved.results,
      );
      expect((await fixture.incidents(incidentId)).results).toEqual(
        savedIncidents.results,
      );
    } finally {
      await concurrent.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
  });

  it('rejects simultaneous reuse of one message ID across different incidents', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentIds = [
      'INC-CROSS-INCIDENT-RACE-A',
      'INC-CROSS-INCIDENT-RACE-B',
    ] as const;
    const messageId = 'MSG-CROSS-INCIDENT-RACE';
    const customerMessage = 'Help with a shipment.';
    const assistantMessage = 'Which shipment do you need help with?';
    const conflictBody = {
      error: 'This message ID is already in use. Send a new message.',
    };
    expect((await fixture.incidents(...incidentIds)).results).toEqual([]);
    expect((await fixture.messages(...incidentIds)).results).toEqual([]);
    const concurrent = createConcurrentSupportFixture(
      fixture,
      () => assistantMessage,
    );
    const { fetchMock } = concurrent;

    try {
      const session = await fixture.session(calderPikeUser);
      for (const [index, incidentId] of incidentIds.entries()) {
        await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
        await saveSupportExchange(
          database,
          calderPikeUser,
          incidentId,
          `MSG-CROSS-INCIDENT-SETUP-${index}`,
          'Hello.',
          'How can I help?',
        );
      }
      // A fixed timestamp makes an unwanted metadata write observable even if
      // setup and the race happen in the same clock tick.
      await database
        .prepare(`UPDATE support_incidents SET updated_at = ?
        WHERE incident_id IN (?, ?)`)
        .bind('2026-01-01T00:00:00.000Z', ...incidentIds)
        .run();
      const beforeMessages = await fixture.messages(...incidentIds);
      const beforeIncidents = await fixture.incidents(...incidentIds);
      expect(beforeMessages.results).toHaveLength(4);
      expect(beforeIncidents.results).toHaveLength(2);
      const makeRequest = (incidentId: string) =>
        session.request({
          incidentId,
          messageId,
          messages: [{ role: 'user', content: customerMessage }],
        });
      const responses = await concurrent.run(
        () => POST(makeRequest(incidentIds[0])),
        () => POST(makeRequest(incidentIds[1])),
      );
      expect(concurrent.timedOut).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const saved = await fixture.messages(...incidentIds);
      expect(saved.results).toHaveLength(6);
      const exchange = saved.results.filter(
        (row) =>
          row.message_id === messageId || row.message_id === `AST-${messageId}`,
      );
      expect(exchange).toHaveLength(2);
      const winnerIndex = incidentIds.findIndex(
        (id) => id === exchange[0].incident_id,
      );
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      const winnerId = incidentIds[winnerIndex];
      const loserId = incidentIds[1 - winnerIndex];
      expect(exchange).toMatchObject([
        {
          incident_id: winnerId,
          message_id: messageId,
          sequence_number: 3,
          role: 'user',
          content: customerMessage,
        },
        {
          incident_id: winnerId,
          message_id: `AST-${messageId}`,
          sequence_number: 4,
          role: 'assistant',
          content: assistantMessage,
        },
      ]);
      expect(
        saved.results.filter(
          (row) =>
            row.message_id !== messageId &&
            row.message_id !== `AST-${messageId}`,
        ),
      ).toEqual(beforeMessages.results);
      expect(responses[winnerIndex].status).toBe(200);
      expect(await responses[winnerIndex].json()).toEqual({
        message: assistantMessage,
      });
      expect(responses[1 - winnerIndex].status).toBe(409);
      expect(await responses[1 - winnerIndex].json()).toEqual(conflictBody);
      // A rejected write must not modify the losing incident's metadata either.
      expect(await fixture.findIncident(loserId)).toEqual(
        beforeIncidents.results.find((row) => row.incident_id === loserId),
      );
      const savedIncidents = await fixture.incidents(...incidentIds);
      expect(savedIncidents.results).toHaveLength(2);
      expect(
        savedIncidents.results.every(
          (row) => row.user_id === calderPikeUser.userId,
        ),
      ).toBe(true);

      for (const [index, incidentId] of incidentIds.entries()) {
        const retry = await POST(makeRequest(incidentId));
        expect(retry.status).toBe(index === winnerIndex ? 200 : 409);
        expect(await retry.json()).toEqual(
          index === winnerIndex ? { message: assistantMessage } : conflictBody,
        );
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await fixture.messages(...incidentIds)).results).toEqual(
        saved.results,
      );
      expect((await fixture.incidents(...incidentIds)).results).toEqual(
        savedIncidents.results,
      );
    } finally {
      await concurrent.cleanup();
    }
    expect((await fixture.incidents(...incidentIds)).results).toEqual([]);
    expect((await fixture.messages(...incidentIds)).results).toEqual([]);
  });

  it.each([
    'different incidents',
    'the same incident',
    'a new incident',
  ] as const)(
    'rejects a concurrent generated reply ID collision in %s without saving a partial exchange',
    async (scope) => {
      const database = await getDatabase();
      const fixture = createSupportApiFixture(database);
      const incidentIds = [
        'INC-REPLY-ID-RACE-A',
        scope === 'the same incident'
          ? 'INC-REPLY-ID-RACE-A'
          : 'INC-REPLY-ID-RACE-B',
      ] as const;
      const uniqueIncidentIds = [...new Set(incidentIds)];
      const priorIncidentCount =
        uniqueIncidentIds.length - (scope === 'a new incident' ? 1 : 0);
      const messageIds = [
        'MSG-REPLY-ID-RACE',
        'AST-MSG-REPLY-ID-RACE',
      ] as const;
      const prompts = ['Help with a shipment.', 'Help with a return.'] as const;
      const assistantMessage = 'Which item do you need help with?';
      const conflictBody = {
        error: 'This message ID is already in use. Send a new message.',
      };
      const concurrent = createConcurrentSupportFixture(
        fixture,
        () => assistantMessage,
      );
      const { fetchMock } = concurrent;
      let afterWinner:
        | Awaited<ReturnType<typeof fixture.incidents>>
        | undefined;
      let releaseReply = () => {};
      const replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      const modelImplementation = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (...args) => {
        const response = await modelImplementation(...args);
        // Both preflight checks finish before either model returns. Then B must
        // persist its customer ID before A tries to use that ID for its reply.
        const body = JSON.parse(args[1]!.body as string);
        if (body.messages.at(-1).content === prompts[0]) await replyGate;
        return response;
      });

      try {
        const session = await fixture.session(calderPikeUser);
        for (const [index, incidentId] of uniqueIncidentIds.entries()) {
          await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
          // A's first exchange must not create an incident when its reply ID
          // is claimed by B after both requests have passed preflight.
          if (scope === 'a new incident' && index === 0) continue;
          await saveSupportExchange(
            database,
            calderPikeUser,
            incidentId,
            `MSG-REPLY-ID-SETUP-${index}`,
            'Hello.',
            'How can I help?',
          );
        }
        await database
          .prepare(`UPDATE support_incidents SET updated_at = ?
        WHERE incident_id IN (?, ?)`)
          .bind('2026-01-01T00:00:00.000Z', ...incidentIds)
          .run();
        const beforeMessages = await fixture.messages(...incidentIds);
        const beforeIncidents = await fixture.incidents(...incidentIds);
        expect(beforeMessages.results).toHaveLength(priorIncidentCount * 2);
        expect(beforeIncidents.results).toHaveLength(priorIncidentCount);
        const makeRequest = (index: number) =>
          session.request({
            incidentId: incidentIds[index],
            messageId: messageIds[index],
            messages: [{ role: 'user', content: prompts[index] }],
          });
        const [loser, winner] = await concurrent.run(
          () => POST(makeRequest(0)),
          async () => {
            try {
              const response = await POST(makeRequest(1));
              // Make a losing metadata write visible even in the same clock tick.
              // Only temporary test incidents are touched, while A is still gated.
              await database
                .prepare(`UPDATE support_incidents SET updated_at = ?
              WHERE incident_id = ?`)
                .bind('2026-01-02T00:00:00.000Z', incidentIds[1])
                .run();
              afterWinner = await fixture.incidents(...incidentIds);
              return response;
            } finally {
              releaseReply();
            }
          },
        );
        expect(concurrent.timedOut).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(winner.status).toBe(200);
        expect(await winner.json()).toEqual({ message: assistantMessage });
        expect(loser.status).toBe(409);
        expect(await loser.json()).toEqual(conflictBody);
        if (scope === 'a new incident')
          expect(await fixture.findIncident(incidentIds[0])).toBeNull();

        const saved = await fixture.messages(...incidentIds);
        expect(saved.results).toHaveLength(beforeMessages.results.length + 2);
        expect(
          saved.results.filter(
            (row) => row.sequence_number === 1 || row.sequence_number === 2,
          ),
        ).toEqual(beforeMessages.results);
        expect(
          saved.results.filter(
            (row) => row.sequence_number === 3 || row.sequence_number === 4,
          ),
        ).toMatchObject([
          {
            incident_id: incidentIds[1],
            message_id: messageIds[1],
            sequence_number: 3,
            role: 'user',
            content: prompts[1],
          },
          {
            incident_id: incidentIds[1],
            message_id: `AST-${messageIds[1]}`,
            sequence_number: 4,
            role: 'assistant',
            content: assistantMessage,
          },
        ]);
        const savedIncidents = await fixture.incidents(...incidentIds);
        expect(afterWinner).toBeDefined();
        expect(savedIncidents.results).toEqual(afterWinner?.results);
        for (const index of [0, 1]) {
          const retry = await POST(makeRequest(index));
          expect(retry.status).toBe(index === 0 ? 409 : 200);
          expect(await retry.json()).toEqual(
            index === 0 ? conflictBody : { message: assistantMessage },
          );
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await fixture.messages(...incidentIds)).results).toEqual(
          saved.results,
        );
        expect((await fixture.incidents(...incidentIds)).results).toEqual(
          savedIncidents.results,
        );
      } finally {
        releaseReply();
        await concurrent.cleanup();
      }
      expect((await fixture.incidents(...incidentIds)).results).toEqual([]);
      expect((await fixture.messages(...incidentIds)).results).toEqual([]);
    },
  );

  it('blocks a corrupted order ID before returning or persisting the response', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-USR-CPD-001-01';
    const existingMessages = () => fixture.messages(incidentId);
    const before = await existingMessages();
    const fetchMock = fixture.mockModel(
      'Return RTN-2022-000014. Linked order: SBL-2022-0000118.',
    );

    try {
      const session = await fixture.session(calderPikeUser);
      const request = session.request({
        incidentId,
        messageId: 'MSG-RETURN-SAFETY-REGRESSION',
        messages: [{ role: 'user', content: 'Show return RTN-2022-000014.' }],
      });
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
      await fixture.cleanup();
    }
  });
});
