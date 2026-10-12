import { hasGroundedSupportIdentifiers } from '@/lib/support-response';
import { requireSupportRecords } from '../assertions/support-context';
import { describe, it, expect } from 'vitest';
import { getDatabase } from '@/db/database';
import { buildSupportContext } from '@/db/support';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import { calderPikeUser } from '../fixtures/users';
import {
  liveSupportScenarios,
  expectLiveSupportContext,
  expectLiveSupportAnswer,
} from '../assertions/live-support';

describe('expanded live scenario ground truth', () => {
  for (const scenario of liveSupportScenarios) {
    it(`grounds ${scenario.id} in real authorized database facts and rejects its defective control`, async () => {
      const evidence = requireSupportRecords(
        await buildSupportContext(
          await getDatabase(),
          scenario.messages as ChatHistoryMessage[],
          calderPikeUser,
        ),
      );
      const context = evidence.records;
      expect(
        hasGroundedSupportIdentifiers(
          scenario.controlAnswers.acceptable,
          evidence,
        ),
      ).toBe(true);
      expectLiveSupportContext(scenario, context);
      expect(() =>
        expectLiveSupportAnswer(
          scenario,
          scenario.controlAnswers.acceptable,
          context,
        ),
      ).not.toThrow();
      expect(() =>
        expectLiveSupportAnswer(
          scenario,
          scenario.controlAnswers.defective,
          context,
        ),
      ).toThrow();
    });
  }
});
