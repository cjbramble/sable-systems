import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/status/route';
import { MODEL_READINESS_CACHE_MS } from '@/lib/model-readiness.mjs';
import {
  signedInStatusRequest,
  uncachedModelStatus,
} from '../fixtures/model-status';

afterEach(() => vi.restoreAllMocks());

describe('model status endpoint', () => {
  it('requires a signed-in session before contacting the provider', async () => {
    const transport = vi.spyOn(globalThis, 'fetch');
    const result = await GET(new Request('http://localhost/api/status'));
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: 'Authentication required.' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('shares one readiness check across polls for a few seconds', async () => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: {} }));
    const request = await signedInStatusRequest();
    // Start well past any result an earlier test cached.
    const start = Date.now() + 5 * 60_000;
    const statusAt = async (time: number) => {
      vi.setSystemTime(time);
      return (await GET(request)).json();
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(await statusAt(start)).toEqual({ ready: true });
      transport.mockResolvedValue(Response.json({}));
      expect(await statusAt(start + MODEL_READINESS_CACHE_MS - 1)).toEqual({
        ready: true,
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(await statusAt(start + MODEL_READINESS_CACHE_MS)).toEqual({
        ready: false,
      });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a non-JSON 200 response as not ready without logging', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>Sign in to the network</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await uncachedModelStatus();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ready: false });
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['TimeoutError', 'AbortError'])(
    'reports offline without logging a %s',
    async (name) => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new DOMException('The operation timed out.', name),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await uncachedModelStatus();

      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ ready: false });
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('logs an unexpected readiness failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('Network connection lost.'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await uncachedModelStatus();

    expect(result.status).toBe(503);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[model status] TypeError: Network connection lost.',
    );
  });

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
    const result = await uncachedModelStatus();
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
    const result = await uncachedModelStatus();
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
      const result = await uncachedModelStatus();
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ ready: false });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(2500);
      expect(controller.signal.aborted).toBe(true);
      expect(bodyRead).toBe(phase === 'body');
    },
  );
});
