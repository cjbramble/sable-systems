import { vi } from 'vitest';

import type { createSupportApiFixture } from './support-api';

// One fixture per test. Both requests must reach the model before either can
// persist; a timeout releases the barrier for cleanup, never as proof of overlap.
export function createConcurrentSupportFixture(
  fixture: ReturnType<typeof createSupportApiFixture>,
  replyForRequest: (prompt: string, callIndex: number) => string,
) {
  let releaseModels = () => {};
  const modelGate = new Promise<void>((resolve) => {
    releaseModels = resolve;
  });
  let arrivals = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  const pending: Promise<Response>[] = [];
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, options) => {
      if (typeof options?.body !== 'string')
        throw new Error('Expected a JSON model request');
      const body = JSON.parse(options.body);
      const prompt: unknown = body.messages?.at(-1)?.content;
      if (typeof prompt !== 'string')
        throw new Error('Expected a customer prompt');
      const reply = replyForRequest(prompt, arrivals);
      if (++arrivals === 2) releaseModels();
      await modelGate;
      return Response.json({ choices: [{ message: { content: reply } }] });
    });

  return {
    fetchMock,
    get timedOut() {
      return timedOut;
    },
    async run(first: () => Promise<Response>, second: () => Promise<Response>) {
      if (started) throw new Error('Create a fresh fixture for each race');
      started = true;
      timer = setTimeout(() => {
        timedOut = true;
        releaseModels();
      }, 2000);
      // Register both operations before invoking either, including sync failures.
      pending.push(
        Promise.resolve().then(first),
        Promise.resolve().then(second),
      );
      try {
        return await Promise.all(pending);
      } finally {
        clearTimeout(timer);
      }
    },
    async cleanup() {
      clearTimeout(timer);
      releaseModels();
      await Promise.allSettled(pending);
      fetchMock.mockRestore();
      // Drain requests before deleting incidents or revoking their sessions.
      await fixture.cleanup();
    },
  };
}
