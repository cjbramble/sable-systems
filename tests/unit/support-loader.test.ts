import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '@/lib/contracts';
import type { SupportIncident } from '@/lib/support-incidents';
import {
  loadSupportSnapshot,
  SupportSessionExpiredError,
} from '@/lib/support-loader';

const account: AccountSummary = {
  customerId: 'CUST-LOADER',
  displayName: 'Loader customer',
  accountTier: 'Enterprise',
  userId: 'USER-LOADER',
  userDisplayName: 'Loader user',
  userRole: 'buyer',
  paymentTerms: 'Net 30',
  currency: 'USD',
  region: 'US',
  totalOrders: 5,
  activeOrders: 2,
  scheduledOrders: 1,
  inventoryAlerts: 0,
  seedAsOfDate: '2026-10-09',
  retrievedAt: '2026-10-09T12:00:00.000Z',
};
const incidents: SupportIncident[] = [
  {
    id: 'INC-LOADER',
    title: 'Shipment status',
    updatedAt: '2026-10-09T12:00:00.000Z',
    revision: 1,
    messages: [
      {
        id: 'MSG-LOADER',
        role: 'user',
        content: 'Where is my shipment?',
        createdAt: '2026-10-09T12:00:00.000Z',
      },
      {
        id: 'AST-MSG-LOADER',
        role: 'assistant',
        content: 'It is in transit.',
        createdAt: '2026-10-09T12:00:00.000Z',
      },
    ],
  },
];
const endpointErrors = {
  '/api/account':
    'Support account details could not be loaded. Please try again.',
  '/api/incidents': 'Support history could not be loaded. Please try again.',
};
const timeoutMessage =
  'Support account and history took too long to load. Please try again.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observe(promise: ReturnType<typeof loadSupportSnapshot>) {
  const outcomes: Array<
    | { status: 'fulfilled'; value: Awaited<typeof promise> }
    | { status: 'rejected'; error: unknown }
  > = [];
  void promise.then(
    (value) => outcomes.push({ status: 'fulfilled', value }),
    (error: unknown) => outcomes.push({ status: 'rejected', error }),
  );
  return outcomes;
}

describe('support snapshot loading', () => {
  let fetchSnapshot: ReturnType<typeof vi.fn<typeof fetch>>;
  let caller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSnapshot = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSnapshot);
    caller = new AbortController();
  });

  afterEach(() => {
    caller.abort();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['account', 'incidents'] as const)(
    'waits for the complete validated pair when %s arrives first',
    async (first) => {
      const accountResponse = deferred<Response>();
      const incidentsResponse = deferred<Response>();
      fetchSnapshot
        .mockReturnValueOnce(accountResponse.promise)
        .mockReturnValueOnce(incidentsResponse.promise);
      const outcomes = observe(loadSupportSnapshot(caller.signal));

      expect(fetchSnapshot.mock.calls.map(([url]) => url)).toEqual([
        '/api/account',
        '/api/incidents',
      ]);
      for (const [, options] of fetchSnapshot.mock.calls) {
        expect(options?.cache).toBe('no-store');
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        expect(options?.signal).not.toBe(caller.signal);
      }

      if (first === 'account') accountResponse.resolve(Response.json(account));
      else incidentsResponse.resolve(Response.json({ incidents }));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toEqual([]);

      if (first === 'account')
        incidentsResponse.resolve(Response.json({ incidents }));
      else accountResponse.resolve(Response.json(account));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toEqual([
        { status: 'fulfilled', value: { account, incidents } },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(caller.signal.aborted).toBe(false);
    },
  );

  describe.each(['/api/account', '/api/incidents'] as const)(
    '%s failure while its sibling never responds',
    (endpoint) => {
      it.each(['401', '503', 'malformed JSON', 'invalid payload', 'network'])(
        'rejects promptly for %s and cancels both internal requests',
        async (failure) => {
          const failed = deferred<Response>();
          const sibling = deferred<Response>();
          fetchSnapshot.mockImplementation((url) =>
            url === endpoint ? failed.promise : sibling.promise,
          );
          const outcomes = observe(loadSupportSnapshot(caller.signal));
          await vi.advanceTimersByTimeAsync(0);
          expect(outcomes).toEqual([]);

          if (failure === 'network')
            failed.reject(new TypeError('Sensitive transport failure'));
          else if (failure === 'malformed JSON')
            failed.resolve(new Response('{'));
          else if (failure === 'invalid payload')
            failed.resolve(Response.json({}));
          else
            failed.resolve(
              new Response(new ReadableStream(), {
                status: Number(failure),
              }),
            );
          await vi.advanceTimersByTimeAsync(0);

          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]).toMatchObject({
            status: 'rejected',
            error:
              failure === '401'
                ? expect.any(SupportSessionExpiredError)
                : new Error(endpointErrors[endpoint]),
          });
          expect(fetchSnapshot).toHaveBeenCalledTimes(2);
          for (const [, options] of fetchSnapshot.mock.calls)
            expect(options?.signal?.aborted).toBe(true);
          expect(caller.signal.aborted).toBe(false);
          expect(vi.getTimerCount()).toBe(0);

          // An abort-ignoring transport can still reject later. Its rejection
          // must be consumed without replacing the first terminal outcome.
          sibling.reject(new Error('Late sibling failure'));
          await vi.advanceTimersByTimeAsync(20_000);
          expect(outcomes).toHaveLength(1);
        },
      );
    },
  );

  it('expires hung headers at ten seconds even when both transports ignore abort', async () => {
    fetchSnapshot.mockReturnValue(new Promise(() => {}));
    const outcomes = observe(loadSupportSnapshot(caller.signal));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcomes).toEqual([
      { status: 'rejected', error: new Error(timeoutMessage) },
    ]);
    for (const [, options] of fetchSnapshot.mock.calls)
      expect(options?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['/api/account', '/api/incidents'] as const)(
    'includes the %s body in the original shared deadline',
    async (endpoint) => {
      const response = deferred<Response>();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      });
      fetchSnapshot.mockImplementation((url) =>
        url === endpoint
          ? response.promise
          : Promise.resolve(
              Response.json(url === '/api/account' ? account : { incidents }),
            ),
      );
      const outcomes = observe(loadSupportSnapshot(caller.signal));
      await vi.advanceTimersByTimeAsync(8_000);
      response.resolve(new Response(stream));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual([
        { status: 'rejected', error: new Error(timeoutMessage) },
      ]);

      body.enqueue(
        new TextEncoder().encode(
          JSON.stringify(endpoint === '/api/account' ? account : { incidents }),
        ),
      );
      body.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('rejects a pre-aborted caller without starting requests or a deadline', async () => {
    caller.abort();
    await expect(loadSupportSnapshot(caller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'rejects external cancellation promptly and ignores late header %s',
    async (lateOutcome) => {
      const accountResponse = deferred<Response>();
      const incidentsResponse = deferred<Response>();
      fetchSnapshot
        .mockReturnValueOnce(accountResponse.promise)
        .mockReturnValueOnce(incidentsResponse.promise);
      const outcomes = observe(loadSupportSnapshot(caller.signal));
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toMatchObject([
        { status: 'rejected', error: { name: 'AbortError' } },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      for (const [, options] of fetchSnapshot.mock.calls)
        expect(options?.signal?.aborted).toBe(true);

      if (lateOutcome === 'resolve') {
        accountResponse.resolve(Response.json(account));
        incidentsResponse.resolve(Response.json({ incidents }));
      } else {
        accountResponse.reject(new Error('Late account failure'));
        incidentsResponse.reject(new Error('Late history failure'));
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expect(outcomes).toHaveLength(1);
    },
  );

  it('rejects external cancellation during body reading without waiting for the body', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    fetchSnapshot
      .mockResolvedValueOnce(Response.json(account))
      .mockResolvedValueOnce(new Response(stream));
    const outcomes = observe(loadSupportSnapshot(caller.signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([]);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toMatchObject([
      { status: 'rejected', error: { name: 'AbortError' } },
    ]);
    body.enqueue(new TextEncoder().encode(JSON.stringify({ incidents })));
    body.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcomes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'failure', 'timeout', 'abort'] as const)(
    'removes the caller abort listener after %s',
    async (outcome) => {
      const added = vi.spyOn(caller.signal, 'addEventListener');
      const removed = vi.spyOn(caller.signal, 'removeEventListener');
      if (outcome === 'success')
        fetchSnapshot
          .mockResolvedValueOnce(Response.json(account))
          .mockResolvedValueOnce(Response.json({ incidents }));
      else if (outcome === 'failure')
        fetchSnapshot.mockResolvedValue(new Response(null, { status: 503 }));
      else fetchSnapshot.mockReturnValue(new Promise(() => {}));

      const outcomes = observe(loadSupportSnapshot(caller.signal));
      if (outcome === 'abort') caller.abort();
      await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? 10_000 : 0);
      expect(outcomes).toHaveLength(1);
      const abortListener = added.mock.calls.find(([type]) => type === 'abort');
      expect(abortListener).toBeDefined();
      expect(removed).toHaveBeenCalledWith('abort', abortListener?.[1]);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome !== 'abort') expect(caller.signal.aborted).toBe(false);

      if (outcome === 'success') {
        caller.abort();
        for (const [, options] of fetchSnapshot.mock.calls)
          expect(options?.signal?.aborted).toBe(false);
      }
    },
  );
});
