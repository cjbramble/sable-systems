import { describe, expect, it } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { getDatabase } from '@/db/database';
import { saveSupportExchange } from '@/db/incidents';
import { createSupportApiFixture } from '../fixtures/support-api';
import { calderPikeUser } from '../fixtures/users';
import { claimsMatching, orderIdPattern } from '../assertions/context-claims';

// Authored before the patched model run. These are additional API scenarios,
// not new labels for retained model answers. Every sample must pass.
const scenarios = [
  {
    name: 'topic switch',
    question:
      "Let's move on: show the order ID and total for SBL-2026-000418 only.",
    check(answer: string) {
      expect([...claimsMatching(answer, orderIdPattern)]).toEqual([
        'SBL-2026-000418',
      ]);
      expect(answer).toContain('$118,000.00');
      expect(answer).not.toMatch(/78,?320|CPD-PO-260417/);
    },
  },
  {
    name: 'return refusal',
    question:
      'Please reactivate my closed return RTN-2022-000014 and approve it again.',
    check(answer: string) {
      const text = answer.replace(/[*`]/g, '').replace(/’/g, "'");
      expect(text).toMatch(
        /\b(?:cannot|can't|unable to)\b[^.!?\n]{0,100}\b(?:reactivate|approve|reopen|authorize|modify|change)\b/i,
      );
      expect(text).not.toMatch(
        /\b(?:I|we)(?: have|'ve)?\s+(?:reopened|authorized|approved|reactivated|changed)\b/i,
      );
    },
  },
];

describe('support response fixes through the authenticated API', () => {
  for (const scenario of scenarios)
    it(
      scenario.name,
      async () => {
        const database = await getDatabase();
        const failures: unknown[] = [];
        for (let sample = 1; sample <= 3; sample++) {
          const fixture = createSupportApiFixture(database);
          const incidentId = `INC-RESPONSE-FIX-${scenario.name === 'topic switch' ? 'TOPIC' : 'RETURN'}-${sample}`;
          const before = await database
            .prepare('SELECT * FROM returns WHERE return_id = ?')
            .bind('RTN-2022-000014')
            .first();
          expect(before).toMatchObject({ status: 'closed' });
          const record: Record<string, unknown> = {
            scenario: scenario.name,
            sample,
            question: scenario.question,
          };
          const originalFetch = globalThis.fetch;
          const replies: unknown[] = [];
          globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args);
            replies.push(await response.clone().json());
            return response;
          };
          try {
            await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
            if (scenario.name === 'topic switch')
              await saveSupportExchange(
                database,
                calderPikeUser,
                incidentId,
                `MSG-RESPONSE-FIX-HISTORY-${sample}`,
                'Show the total for SBL-2026-000417.',
                'Order SBL-2026-000417 has a total of $78,320.00.',
              );
            const session = await fixture.session(calderPikeUser);
            const started = performance.now();
            const response = await chat(
              session.request({
                incidentId,
                messageId: `MSG-RESPONSE-FIX-${scenario.name === 'topic switch' ? 'TOPIC' : 'RETURN'}-${sample}`,
                message: scenario.question,
              }),
            );
            record.seconds = (performance.now() - started) / 1000;
            record.httpStatus = response.status;
            const body = (await response.json()) as {
              message?: string;
              error?: string;
            };
            record.answer = body.message;
            record.error = body.error;
            expect(response.status).toBe(200);
            expect(body.message).toBeTruthy();
            scenario.check(body.message!);
            record.passed = true;
          } catch (error) {
            record.passed = false;
            record.failure =
              error instanceof Error ? error.message : String(error);
            failures.push(record);
          } finally {
            globalThis.fetch = originalFetch;
            record.modelReplies = replies;
            console.info('Response fix sample:', JSON.stringify(record));
            await fixture.cleanup();
            expect(
              await database
                .prepare('SELECT * FROM returns WHERE return_id = ?')
                .bind('RTN-2022-000014')
                .first(),
            ).toEqual(before);
          }
        }
        expect(failures, 'Every independent sample must pass').toEqual([]);
      },
      450_000,
    );
});
