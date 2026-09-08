import { describe, expect, it, vi } from 'vitest';

import { createConcurrentSupportFixture } from '../fixtures/concurrent-support';

describe('concurrent support fixture', () => {
  it('restores fetch and clears timers even when the cleanup callback fails', async () => {
    const originalFetch = globalThis.fetch;
    const failure = new Error('Underlying cleanup failed');
    const events: string[] = [];
    const cleanup = vi.fn(async () => {
      events.push('cleanup');
      expect(globalThis.fetch).toBe(originalFetch);
      expect(vi.getTimerCount()).toBe(0);
      throw failure;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const concurrent = createConcurrentSupportFixture(
      { cleanup },
      () => 'How can I help?',
    );
    let cleanupOutcome: Promise<PromiseSettledResult<void>[]> | undefined;

    try {
      const run = concurrent.run(
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
        () => Promise.resolve(new Response(null, { status: 403 })),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(concurrent.fetchMock).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(concurrent.fetchMock);
      expect(events).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      // Observe the intentional rejection immediately, including in teardown.
      cleanupOutcome = Promise.allSettled([concurrent.cleanup()]);
      const [outcome] = await cleanupOutcome;
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected')
        throw new Error('Expected cleanup to fail');
      expect(outcome.reason).toBe(failure);
      const responses = await run;
      expect(responses.map((response) => response.status)).toEqual([200, 403]);
      expect(await responses[0].json()).toEqual({
        choices: [{ message: { content: 'How can I help?' } }],
      });
      expect(events).toEqual(['model-finished', 'cleanup']);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(originalFetch);
      expect(concurrent.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try {
        await (cleanupOutcome ?? Promise.allSettled([concurrent.cleanup()]));
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('preserves an operation error and drains its waiting peer before cleanup', async () => {
    const originalFetch = globalThis.fetch;
    const failure = new Error('Request setup failed');
    const events: string[] = [];
    const cleanup = vi.fn(async () => {
      events.push('cleanup');
    });
    let finishOperation = () => {};
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const concurrent = createConcurrentSupportFixture(
      { cleanup },
      () => 'How can I help?',
    );
    let cleanupPromise: Promise<void> | undefined;

    try {
      const run = concurrent.run(
        async () => {
          const response = await fetch('http://localhost/model', {
            method: 'POST',
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'Hello.' }],
            }),
          });
          events.push('model-released');
          // Simulate work still in progress after inference, such as persistence.
          await operationGate;
          events.push('operation-finished');
          return response;
        },
        () => {
          events.push('operation-threw');
          throw failure;
        },
      );
      await expect(run).rejects.toBe(failure);
      expect(concurrent.fetchMock).toHaveBeenCalledOnce();
      expect(concurrent.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(events).toEqual(['operation-threw']);
      expect(cleanup).not.toHaveBeenCalled();

      cleanupPromise = concurrent.cleanup();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['operation-threw', 'model-released']);
      expect(cleanup).not.toHaveBeenCalled();
      expect(globalThis.fetch).toBe(concurrent.fetchMock);
      expect(concurrent.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      finishOperation();
      await cleanupPromise;
      expect(events).toEqual([
        'operation-threw',
        'model-released',
        'operation-finished',
        'cleanup',
      ]);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(originalFetch);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishOperation();
      try {
        await (cleanupPromise ?? concurrent.cleanup());
      } finally {
        vi.useRealTimers();
      }
    }
  });

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
