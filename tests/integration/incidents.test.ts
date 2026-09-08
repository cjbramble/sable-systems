import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import { createSupportApiFixture } from '../fixtures/support-api';
import { calderPikeUser } from '../fixtures/users';

describe('support incident persistence', () => {
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
