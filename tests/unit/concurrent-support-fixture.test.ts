import { describe, expect, it, vi } from 'vitest';

import { createConcurrentSupportFixture } from '../fixtures/concurrent-support';

describe('concurrent support fixture', () => {
  it('reports a timeout when only one request reaches the model and cleans up safely', async () => {
    const originalFetch = globalThis.fetch;
    const events: string[] = [];
    const cleanup = vi.fn(async () => {
      events.push('cleanup');
    });
    const replyForRequest = vi.fn(() => 'How can I help?');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const concurrent = createConcurrentSupportFixture(
      { cleanup },
      replyForRequest,
    );
    let cleaned = false;
    let completed = false;

    try {
      const run = concurrent
        .run(
          async () => {
            const response = await fetch('http://localhost/model', {
              method: 'POST',
              body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello.' }],
              }),
            });
            events.push('model-finished');
            return response;
          },
          // Simulate an API rejection before inference; no second model arrival.
          () =>
            Promise.resolve(
              Response.json(
                { error: 'Incident access denied.' },
                { status: 403 },
              ),
            ),
        )
        .then((responses) => {
          completed = true;
          return responses;
        });

      await vi.advanceTimersByTimeAsync(1999);
      expect(concurrent.fetchMock).toHaveBeenCalledOnce();
      expect(replyForRequest).toHaveBeenCalledExactlyOnceWith('Hello.', 0);
      expect(concurrent.timedOut).toBe(false);
      expect(completed).toBe(false);
      expect(events).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(concurrent.timedOut).toBe(true);
      expect(completed).toBe(true);
      expect(concurrent.fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const responses = await run;
      expect(responses.map((response) => response.status)).toEqual([200, 403]);
      expect(await responses[0].json()).toEqual({
        choices: [{ message: { content: 'How can I help?' } }],
      });
      expect(await responses[1].json()).toEqual({
        error: 'Incident access denied.',
      });
      expect(events).toEqual(['model-finished']);
      expect(cleanup).not.toHaveBeenCalled();

      await concurrent.cleanup();
      cleaned = true;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(events).toEqual(['model-finished', 'cleanup']);
      expect(globalThis.fetch).toBe(originalFetch);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try {
        if (!cleaned) await concurrent.cleanup();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
