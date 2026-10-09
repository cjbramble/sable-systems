import { afterEach, describe, expect, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { GET } from '@/app/api/status/route';
import {
  getSupportModelConfig,
  OPENROUTER_CHAT_URL,
  OPENROUTER_KEY_URL,
} from '@/lib/support-model-config.mjs';
import * as runtime from '@/lib/support-model-runtime';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

afterEach(() => vi.restoreAllMocks());

for (const endpoint of ['completion', 'readiness'] as const) {
  describe(`real Worker ${endpoint} transport`, () => {
    const cases = [
      { status: 200, origin: 'same' },
      ...[301, 302, 303, 307, 308].flatMap((status) =>
        ['same', 'cross'].map((origin) => ({ status, origin })),
      ),
    ];
    test.for(cases)(
      'handles HTTP $status with a $origin-origin destination',
      async ({ status, origin }, { supportApi }) => {
        const id = crypto.randomUUID();
        const incidentId = `INC-TRANSPORT-${id}`;
        const observedUrl = `https://model-transport.test/${id}`;
        vi.spyOn(runtime, 'supportModelConfig').mockReturnValue(
          getSupportModelConfig({
            OPENROUTER_API_KEY: `transport-test:${id}:${status}:${origin}`,
          }),
        );
        await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
        try {
          const session = await supportApi.session(calderPikeUser);
          const response =
            endpoint === 'completion'
              ? await POST(
                  session.request({
                    expectedRevision: 0,
                    incidentId,
                    messageId: `MSG-${id}`,
                    message: 'Help with a shipment.',
                  }),
                )
              : await GET();

          // These observations come from the outbound service, not RequestInit.
          expect(await (await fetch(observedUrl)).json()).toEqual([
            endpoint === 'completion'
              ? OPENROUTER_CHAT_URL
              : OPENROUTER_KEY_URL,
          ]);
          expect(response.status).toBe(status === 200 ? 200 : 503);
          expect(await response.json()).toMatchObject(
            endpoint === 'readiness'
              ? { ready: status === 200 }
              : status === 200
                ? { message: 'Please provide the shipment reference.' }
                : {
                    error:
                      'The support model is unavailable. Please try again.',
                  },
          );
          if (status === 200 && endpoint === 'completion') {
            expect(
              (await supportApi.messageContents(incidentId)).results.map(
                (row) => row.content,
              ),
            ).toEqual([
              'Help with a shipment.',
              'Please provide the shipment reference.',
            ]);
          } else {
            expect(await supportApi.findIncident(incidentId)).toBeNull();
            expect((await supportApi.messages(incidentId)).results).toEqual([]);
          }
        } finally {
          await fetch(observedUrl, { method: 'DELETE' });
        }
      },
    );
  });
}
