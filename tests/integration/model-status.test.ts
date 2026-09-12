import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/status/route';

afterEach(() => vi.restoreAllMocks());

describe('model status endpoint', () => {
  it.each([
    {
      name: 'expected model',
      response: () =>
        Response.json({ data: [{ id: 'customer-support-local' }] }),
      ready: true,
    },
    {
      name: 'expected model among other entries',
      response: () =>
        Response.json({
          data: [null, { id: 'other' }, { id: 'customer-support-local' }],
        }),
      ready: true,
    },
    {
      name: 'unrelated and similarly named models',
      response: () =>
        Response.json({
          data: [{ id: 'other' }, { id: 'customer-support-local-extra' }],
        }),
      ready: false,
    },
    {
      name: 'missing model list',
      response: () => Response.json({}),
      ready: false,
    },
    {
      name: 'non-array model list',
      response: () => Response.json({ data: { id: 'customer-support-local' } }),
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
      name: 'HTTP failure with an expected-model body',
      response: () =>
        Response.json(
          { data: [{ id: 'customer-support-local' }] },
          { status: 503 },
        ),
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
      'http://127.0.0.1:8017/v1/models',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
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
