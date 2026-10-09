import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startSupportStatusPolling,
  type SupportRuntimeState,
} from '../../lib/support-status';

class VisibilityDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  changeVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('support status polling', () => {
  let visibility: VisibilityDocument;
  let fetchStatus: ReturnType<typeof vi.fn<typeof fetch>>;
  let states: SupportRuntimeState[];
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = new VisibilityDocument();
    fetchStatus = vi.fn<typeof fetch>();
    states = [];
    vi.stubGlobal('document', visibility);
    vi.stubGlobal('fetch', fetchStatus);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function start() {
    stop = startSupportStatusPolling((status) => states.push(status));
  }

  it('checks immediately and waits ten seconds after settlement before polling again', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchStatus
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    start();

    expect(fetchStatus).toHaveBeenCalledExactlyOnceWith('/api/status', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    first.resolve(Response.json({ ready: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(states).toEqual(['ready']);

    second.resolve(Response.json({ ready: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['ready', 'offline']);
  });

  it.each([
    ['not ready', '{"ready":false}', 200],
    ['missing readiness', '{}', 200],
    ['string readiness', '{"ready":"true"}', 200],
    ['numeric readiness', '{"ready":1}', 200],
    ['null payload', 'null', 200],
    ['array payload', '[{"ready":true}]', 200],
    ['boolean payload', 'true', 200],
    ['malformed JSON', '{', 200],
    ['unsuccessful response', '{"ready":true}', 503],
  ])('reports offline for %s', async (_description, body, status) => {
    fetchStatus.mockResolvedValue(new Response(body, { status }));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['offline']);
  });

  it('reports a network failure as offline and recovers on the next check', async () => {
    fetchStatus
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(Response.json({ ready: true }));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['offline']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(['offline', 'ready']);
  });

  it('aborts an unread error body and reports offline without waiting for the deadline', async () => {
    fetchStatus
      .mockResolvedValueOnce(
        new Response(new ReadableStream(), { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ ready: true }));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['offline']);
    expect(fetchStatus.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(['offline', 'ready']);
  });

  it('ends a hung fetch after five seconds even when it ignores cancellation', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchStatus
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    start();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    const firstSignal = fetchStatus.mock.calls[0][1]?.signal;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(states).toEqual([]);
    expect(firstSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(['offline']);
    expect(firstSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    first.resolve(Response.json({ ready: true }));
    await vi.advanceTimersByTimeAsync(0);
    visibility.changeVisibility('visible');
    expect(states).toEqual(['offline']);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states).toEqual(['offline', 'offline']);
    expect(fetchStatus.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it('includes body reading in the original five second deadline and ignores its late result', async () => {
    const response = deferred<Response>();
    const next = deferred<Response>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    fetchStatus
      .mockReturnValueOnce(response.promise)
      .mockReturnValueOnce(next.promise);
    start();
    await vi.advanceTimersByTimeAsync(4_000);
    response.resolve(new Response(stream));
    await vi.advanceTimersByTimeAsync(999);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(['offline']);
    expect(fetchStatus.mock.calls[0][1]?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    body.enqueue(new TextEncoder().encode('{"ready":true}'));
    body.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['offline']);
    next.resolve(Response.json({ ready: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['offline', 'ready']);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('starts only when visible and ignores repeated visible events', async () => {
    visibility.visibilityState = 'hidden';
    const response = deferred<Response>();
    fetchStatus.mockReturnValue(response.promise);
    start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(states).toEqual([]);

    visibility.changeVisibility('visible');
    visibility.changeVisibility('visible');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    response.resolve(Response.json({ ready: true }));
    await vi.advanceTimersByTimeAsync(0);
    visibility.changeVisibility('visible');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores an old request that %ss after hiding and resuming',
    async (settlement) => {
      const old = deferred<Response>();
      const current = deferred<Response>();
      fetchStatus
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      start();
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      visibility.changeVisibility('hidden');
      expect(fetchStatus.mock.calls[0][1]?.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(states).toEqual([]);

      visibility.changeVisibility('visible');
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      if (settlement === 'resolve')
        old.resolve(Response.json({ ready: false }));
      else old.reject(new Error('Late cancellation'));
      await vi.advanceTimersByTimeAsync(0);
      visibility.changeVisibility('visible');
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      expect(states).toEqual([]);

      current.resolve(Response.json({ ready: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toEqual(['ready']);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      fetchStatus.mockResolvedValue(Response.json({ ready: false }));
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
      expect(states).toEqual(['ready', 'offline']);
    },
  );

  it('retains the last observation while hidden and refreshes immediately on return', async () => {
    fetchStatus
      .mockResolvedValueOnce(Response.json({ ready: true }))
      .mockResolvedValueOnce(Response.json({ ready: false }));
    start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    visibility.changeVisibility('hidden');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['ready']);

    visibility.changeVisibility('visible');
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(states).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['ready', 'offline']);
  });

  it('cleanup aborts the active request and ignores late results and visibility events', async () => {
    const response = deferred<Response>();
    fetchStatus.mockReturnValue(response.promise);
    start();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    stop?.();
    expect(fetchStatus.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(Response.json({ ready: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    visibility.changeVisibility('hidden');
    visibility.changeVisibility('visible');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleanup clears the next scheduled poll after a completed check', async () => {
    fetchStatus.mockResolvedValue(Response.json({ ready: true }));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['ready']);
    stop?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['ready']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
