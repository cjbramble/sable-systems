import { afterEach, expect, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import * as support from '@/db/support';
import * as runtime from '@/lib/support-model-runtime';
import { createSupportModelRequest } from '@/lib/support-model';
import { getSupportModelConfig } from '@/lib/support-model-config.mjs';
import { calderPikeUser } from '../fixtures/users';
import { test } from '../fixtures/support-integration';

const message = 'Show order SBL-2022-000118.';
const history = [{ role: 'user' as const, content: message }];
const config = getSupportModelConfig({
  OPENROUTER_API_KEY: 'test-key-not-a-secret',
});
afterEach(() => vi.restoreAllMocks());

for (const correctionOverflow of [false, true]) {
  test(
    correctionOverflow
      ? 'rejects correction overflow before a second fetch or save, with one quota charge'
      : 'rejects mandatory-record overflow before fetch, quota, or save',
    async ({ database, supportApi }) => {
      const incidentId = `INC-BUDGET-${correctionOverflow ? 'CORRECTION' : 'RECORDS'}`;
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const context = await support.buildSupportContext(
        database,
        history,
        calderPikeUser,
      );
      if (context.kind === 'clarification') throw new Error('Expected records');
      const runtimeConfig = vi
        .spyOn(runtime, 'supportModelConfig')
        .mockReturnValue(config);
      const initial = createSupportModelRequest({
        distributorName: calderPikeUser.distributorDisplayName,
        distributorId: calderPikeUser.distributorId,
        authorizedContext: context.records,
        messages: history,
      });
      if (initial.kind !== 'ready')
        throw new Error('Expected first request to fit');
      if (correctionOverflow)
        runtimeConfig.mockReturnValue({
          ...config,
          contextTokens: initial.estimatedTokens,
        });
      else
        vi.spyOn(support, 'buildSupportContext').mockResolvedValue({
          ...context,
          records: context.records + 'x'.repeat(30_000),
        });
      const model = supportApi.mockModel(
        'Contact the SABLE Systems returns specialist.',
      );
      const response = await POST(
        session.request({
          incidentId,
          messageId: 'MSG-BUDGET-CURRENT',
          expectedRevision: 0,
          message,
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        code: 'request_not_saved',
        error: expect.stringMatching(
          /estimated.*budget.*one order or product/i,
        ),
      });
      expect(model).toHaveBeenCalledTimes(correctionOverflow ? 1 : 0);
      expect(await supportApi.findIncident(incidentId)).toBeNull();
      expect((await supportApi.messageContents(incidentId)).results).toEqual(
        [],
      );
      const attempts = await database
        .prepare('SELECT attempts FROM request_limits WHERE quota_key = ?')
        .bind(`chat:${calderPikeUser.userId}`)
        .first<number>('attempts');
      expect(attempts).toBe(correctionOverflow ? 1 : null);
    },
  );
}

test('classifies model-configuration failures as model failures before quota consumption', async ({
  database,
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  vi.spyOn(runtime, 'supportModelConfig').mockReturnValue({
    ...config,
    apiKey: '',
  });
  const model = supportApi.mockModel('A reply.');
  const response = await POST(session.request({ message }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: 'request_not_saved',
    error: 'The support model is unavailable. Please try again.',
  });
  expect(model).not.toHaveBeenCalled();
  expect(
    await database
      .prepare('SELECT attempts FROM request_limits WHERE quota_key = ?')
      .bind(`chat:${calderPikeUser.userId}`)
      .first(),
  ).toBeNull();
});
