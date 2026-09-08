import { describe, expect, it } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import {
  createSupportApiFixture,
  type SupportApiSession,
} from '../fixtures/support-api';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

describe('support response safety', () => {
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
