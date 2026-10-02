import { describe, it, expect } from 'vitest';
import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
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
      const context = await buildAuthorizedContext(
        await getDatabase(),
        scenario.messages as ChatHistoryMessage[],
        calderPikeUser,
      );
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
