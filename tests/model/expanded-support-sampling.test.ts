import { hasGroundedSupportIdentifiers } from '@/lib/support-response';
import { requireSupportRecords } from '../assertions/support-context';
import { describe, expect, it } from 'vitest';
import { getDatabase } from '@/db/database';
import { buildSupportContext } from '@/db/support';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import { calderPikeUser } from '../fixtures/users';
import { expectFiveNormalGenerationSamples } from '../fixtures/model-sampling';
import {
  liveSupportScenarios,
  expectLiveSupportContext,
  expectLiveSupportAnswer,
} from '../assertions/live-support';

describe('expanded live support sampling', () => {
  for (const scenario of liveSupportScenarios) {
    it(scenario.testName, { timeout: 650_000, retry: 0 }, async () => {
      const database = await getDatabase();
      const messages = scenario.messages as ChatHistoryMessage[];
      const context = requireSupportRecords(
        await buildSupportContext(database, messages, calderPikeUser),
      );
      const authorizedContext = context.records;
      expectLiveSupportContext(scenario, authorizedContext);
      await expectFiveNormalGenerationSamples({
        messages,
        authorizedContext,
        logPrefix: scenario.label,
        checkResponse: (answer, records) => {
          expect(hasGroundedSupportIdentifiers(answer, context)).toBe(true);
          expectLiveSupportAnswer(scenario, answer, records);
        },
      });
    });
  }
});
