import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/status/route';

afterEach(() => vi.restoreAllMocks());

describe('model status endpoint', () => {
  it.each([
    {
      name: 'valid key metadata',
      response: () => Response.json({ data: { limit_remaining: 1 } }),
      ready: true,
    },
    {
      name: 'missing key metadata',
      response: () => Response.json({}),
      ready: false,
    },
    {
      name: 'array instead of key metadata',
      response: () => Response.json({ data: [] }),
      ready: false,
    },
    {
      name: 'scalar key metadata',
      response: () => Response.json({ data: 'not metadata' }),
      ready: false,
    },
    {
      name: 'null metadata',
      response: () => Response.json(null),
      ready: false,
    },
    {
      name: 'malformed JSON',
      response: () => new Response('not JSON'),
      ready: false,
    },
    {
      name: 'HTTP failure',
      response: () => Response.json({ data: {} }, { status: 503 }),
      ready: false,
    },
  ])('reports readiness for $name', async ({ response, ready }) => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response());
    const result = await GET();
    expect(result.status).toBe(ready ? 200 : 503);
    expect(await result.json()).toEqual({ ready });
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer offline-test-key',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports unavailable transport without exposing upstream details', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('private transport details'),
    );
    const result = await GET();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ready: false });
  });

  it.each(['headers', 'body'])(
    'bounds the %s read by the status timeout',
    async (phase) => {
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(controller.signal);
      const reason = new DOMException(
        'controlled status timeout',
        'TimeoutError',
      );
      let bodyRead = false;
      const waitForAbort = (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort(reason));
        });
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        async (_url, options) => {
          expect(options?.signal).toBe(controller.signal);
          if (phase === 'headers') return waitForAbort(controller.signal);
          const response = new Response('');
          vi.spyOn(response, 'json').mockImplementationOnce(() => {
            bodyRead = true;
            return waitForAbort(controller.signal);
          });
          return response;
        },
      );
      const result = await GET();
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ ready: false });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(2500);
      expect(controller.signal.aborted).toBe(true);
      expect(bodyRead).toBe(phase === 'body');
    },
  );
});
