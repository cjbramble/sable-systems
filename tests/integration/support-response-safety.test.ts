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

      let releaseModels = () => {};
      const modelGate = new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
      let arrivals = 0;
      let gateTimedOut = false;
      let gateTimer: ReturnType<typeof setTimeout> | undefined;
      const pending: Promise<Response>[] = [];
      const fetchMock = fixture.mockModel(replies[0]);
      fetchMock.mockImplementation(async () => {
        const reply = replies[Math.min(arrivals++, replies.length - 1)];
        if (arrivals === 2) releaseModels();
        await modelGate;
        return Response.json({ choices: [{ message: { content: reply } }] });
      });

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
        // Both requests must reach inference before either can save. The timer
        // only releases a broken barrier for cleanup; it cannot make the test pass.
        gateTimer = setTimeout(() => {
          gateTimedOut = true;
          releaseModels();
        }, 2000);
        pending.push(POST(makeRequest()), POST(makeRequest()));
        const responses = await Promise.all(pending);
        clearTimeout(gateTimer);
        expect(gateTimedOut).toBe(false);
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
        clearTimeout(gateTimer);
        releaseModels();
        await Promise.allSettled(pending);
        await fixture.cleanup();
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

    let releaseModels = () => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    let arrivals = 0;
    let gateTimedOut = false;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: Promise<Response>[] = [];
    const fetchMock = fixture.mockModel(participants[0].reply);
    fetchMock.mockImplementation(async (_url, options) => {
      if (typeof options?.body !== 'string')
        throw new Error('Expected a JSON model request');
      const body = JSON.parse(options.body);
      const participant = participants.find(
        (entry) => entry.prompt === body.messages.at(-1)?.content,
      );
      if (!participant) throw new Error('Unexpected model request');
      if (++arrivals === 2) releaseModels();
      await modelGate;
      return Response.json({
        choices: [{ message: { content: participant.reply } }],
      });
    });

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
      gateTimer = setTimeout(() => {
        gateTimedOut = true;
        releaseModels();
      }, 2000);
      pending.push(POST(makeRequest(0)), POST(makeRequest(1)));
      const responses = await Promise.all(pending);
      clearTimeout(gateTimer);
      expect(gateTimedOut).toBe(false);
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
      clearTimeout(gateTimer);
      releaseModels();
      await Promise.allSettled(pending);
      await fixture.cleanup();
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

    let releaseModels = () => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    let arrivals = 0;
    let gateTimedOut = false;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: Promise<Response>[] = [];
    const fetchMock = fixture.mockModel(exchanges[0].reply);
    fetchMock.mockImplementation(async (_url, options) => {
      if (typeof options?.body !== 'string')
        throw new Error('Expected a JSON model request');
      const body = JSON.parse(options.body);
      const exchange = exchanges.find(
        (entry) => entry.prompt === body.messages.at(-1)?.content,
      );
      if (!exchange) throw new Error('Unexpected model request');
      if (++arrivals === 2) releaseModels();
      await modelGate;
      return Response.json({
        choices: [{ message: { content: exchange.reply } }],
      });
    });

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
      gateTimer = setTimeout(() => {
        gateTimedOut = true;
        releaseModels();
      }, 2000);
      pending.push(...exchanges.map((exchange) => POST(makeRequest(exchange))));
      const responses = await Promise.all(pending);
      clearTimeout(gateTimer);
      expect(gateTimedOut).toBe(false);
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
      clearTimeout(gateTimer);
      releaseModels();
      await Promise.allSettled(pending);
      await fixture.cleanup();
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

    let releaseModels = () => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    let arrivals = 0;
    let gateTimedOut = false;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: Promise<Response>[] = [];
    const fetchMock = fixture.mockModel(exchanges[0].reply);
    fetchMock.mockImplementation(async (_url, options) => {
      if (typeof options?.body !== 'string')
        throw new Error('Expected a JSON model request');
      const body = JSON.parse(options.body);
      const exchange = exchanges.find(
        (entry) => entry.prompt === body.messages.at(-1)?.content,
      );
      if (!exchange) throw new Error('Unexpected model request');
      if (++arrivals === 2) releaseModels();
      await modelGate;
      return Response.json({
        choices: [{ message: { content: exchange.reply } }],
      });
    });

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
      gateTimer = setTimeout(() => {
        gateTimedOut = true;
        releaseModels();
      }, 2000);
      pending.push(...exchanges.map((exchange) => POST(makeRequest(exchange))));
      const responses = await Promise.all(pending);
      clearTimeout(gateTimer);
      expect(gateTimedOut).toBe(false);
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
      clearTimeout(gateTimer);
      releaseModels();
      await Promise.allSettled(pending);
      await fixture.cleanup();
    }
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
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
