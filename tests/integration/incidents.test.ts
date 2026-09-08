import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import { createSupportApiFixture } from '../fixtures/support-api';
import { calderPikeUser } from '../fixtures/users';

describe('support incident persistence', () => {
  it('preserves existing history and metadata when the final incident update fails', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-EXISTING-WRITE-ROLLBACK';
    const messageId = 'MSG-EXISTING-WRITE-ROLLBACK';
    const customerMessage = 'Help with a return.';
    const assistantMessage = 'Which return do you need help with?';
    const findTrigger = () =>
      database
        .prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'test_support_metadata_rollback'`)
        .first();
    const dropTrigger = () =>
      database.prepare('DROP TRIGGER test_support_metadata_rollback').run();
    let triggerCreated = false;

    expect(await findTrigger()).toBeNull();
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        'MSG-EXISTING-ROLLBACK-SETUP',
        'Hello.',
        'How can I help?',
      );
      // Both title and timestamp must visibly change on a successful write.
      await database
        .prepare(`UPDATE support_incidents SET title = ?, updated_at = ?
        WHERE incident_id = ? AND user_id = ?`)
        .bind(
          'New service incident',
          '2026-01-01T00:00:00.000Z',
          incidentId,
          calderPikeUser.userId,
        )
        .run();
      const beforeIncident = await fixture.findIncident(incidentId);
      const beforeMessages = await fixture.messages(incidentId);
      expect(beforeMessages.results).toHaveLength(2);
      expect(beforeIncident).toMatchObject({
        title: 'New service incident',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      // Fire only after both new messages and the metadata changes are visible
      // inside the transaction. The failed D1 batch must roll back all writes.
      await database
        .prepare(`CREATE TRIGGER test_support_metadata_rollback
        AFTER UPDATE ON support_incidents
        WHEN NEW.incident_id = 'INC-EXISTING-WRITE-ROLLBACK'
          AND NEW.user_id = 'USR-CPD-001'
          AND NEW.title = 'Help with a return.' AND NEW.updated_at <> OLD.updated_at
          AND EXISTS (
            SELECT 1 FROM support_messages customer
            JOIN support_messages assistant ON assistant.incident_id = customer.incident_id
            WHERE customer.incident_id = NEW.incident_id
              AND customer.message_id = 'MSG-EXISTING-WRITE-ROLLBACK'
              AND customer.role = 'user' AND customer.sequence_number = 3
              AND assistant.message_id = 'AST-MSG-EXISTING-WRITE-ROLLBACK'
              AND assistant.role = 'assistant' AND assistant.sequence_number = 4
          )
        BEGIN
          SELECT RAISE(ABORT, 'test: metadata update failed after both message writes');
        END`)
        .run();
      triggerCreated = true;
      const save = () =>
        saveSupportExchange(
          database,
          calderPikeUser,
          incidentId,
          messageId,
          customerMessage,
          assistantMessage,
        );

      await expect(save()).rejects.toThrow(
        'test: metadata update failed after both message writes',
      );
      expect(await fixture.findIncident(incidentId)).toEqual(beforeIncident);
      expect((await fixture.messages(incidentId)).results).toEqual(
        beforeMessages.results,
      );

      await dropTrigger();
      triggerCreated = false;
      expect(await findTrigger()).toBeNull();
      await expect(save()).resolves.toBe(assistantMessage);
      const saved = await fixture.messages(incidentId);
      expect(saved.results).toHaveLength(4);
      expect(saved.results.slice(0, 2)).toEqual(beforeMessages.results);
      expect(saved.results.slice(2)).toMatchObject([
        {
          message_id: messageId,
          sequence_number: 3,
          role: 'user',
          content: customerMessage,
        },
        {
          message_id: `AST-${messageId}`,
          sequence_number: 4,
          role: 'assistant',
          content: assistantMessage,
        },
      ]);
      const savedIncident = await fixture.findIncident(incidentId);
      expect(savedIncident).toMatchObject({
        ...beforeIncident,
        title: customerMessage,
        updated_at: expect.any(String),
      });
      expect(savedIncident?.updated_at).not.toBe(beforeIncident?.updated_at);
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

  it('rolls back a new incident and its customer message when the reply insert fails', async () => {
    const database = await getDatabase();
    const fixture = createSupportApiFixture(database);
    const incidentId = 'INC-WRITE-ROLLBACK';
    const messageId = 'MSG-WRITE-ROLLBACK';
    const customerMessage = 'Help with a shipment.';
    const assistantMessage = 'Which shipment do you need help with?';
    const findTrigger = () =>
      database
        .prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'test_support_reply_rollback'`)
        .first();
    const dropTrigger = () =>
      database.prepare('DROP TRIGGER test_support_reply_rollback').run();
    let triggerCreated = false;

    expect(await findTrigger()).toBeNull();
    expect(await fixture.findIncident(incidentId)).toBeNull();
    expect((await fixture.messages(incidentId)).results).toEqual([]);
    try {
      await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
      // Fail inside SQLite, not in a mocked batch call. The trigger only fires
      // after this test's incident and customer message exist in the transaction.
      await database
        .prepare(`CREATE TRIGGER test_support_reply_rollback
        BEFORE INSERT ON support_messages
        WHEN NEW.message_id = 'AST-MSG-WRITE-ROLLBACK'
          AND NEW.incident_id = 'INC-WRITE-ROLLBACK'
          AND NEW.role = 'assistant'
          AND EXISTS (
            SELECT 1 FROM support_messages m
            JOIN support_incidents i ON i.incident_id = m.incident_id
            WHERE m.message_id = 'MSG-WRITE-ROLLBACK'
              AND m.incident_id = NEW.incident_id AND m.role = 'user'
              AND m.sequence_number = 1 AND i.user_id = 'USR-CPD-001'
          )
        BEGIN
          SELECT RAISE(ABORT, 'test: reply insert failed after customer write');
        END`)
        .run();
      triggerCreated = true;
      const save = () =>
        saveSupportExchange(
          database,
          calderPikeUser,
          incidentId,
          messageId,
          customerMessage,
          assistantMessage,
        );

      await expect(save()).rejects.toThrow(
        'test: reply insert failed after customer write',
      );
      expect(await fixture.findIncident(incidentId)).toBeNull();
      expect((await fixture.messages(incidentId)).results).toEqual([]);

      // Removing the injected fault must allow a clean retry with the same IDs.
      await dropTrigger();
      triggerCreated = false;
      expect(await findTrigger()).toBeNull();
      await expect(save()).resolves.toBe(assistantMessage);
      expect(await fixture.findIncident(incidentId)).toMatchObject({
        incident_id: incidentId,
        user_id: calderPikeUser.userId,
        title: customerMessage,
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
});
