import { describe, expect, vi } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

describe('server error logging', () => {
  test('logs an unexpected model transport failure without request content', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-ERROR-LOGGING';
    const message = 'Show order SBL-2022-000118.';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network connection lost.'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await chat(
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId: 'MSG-ERROR-LOGGING',
          message,
        }),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: 'request_not_saved',
        error: 'The support model is unavailable. Please try again.',
      });
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[support answer (model)] TypeError: Network connection lost.',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(message);
    } finally {
      transport.mockRestore();
      log.mockRestore();
    }
  });
});
