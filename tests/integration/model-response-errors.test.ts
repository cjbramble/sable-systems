import { afterEach, describe, expect, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

afterEach(() => vi.restoreAllMocks());

describe('model response failures', () => {
  const interruptions = ['TimeoutError', 'AbortError'].flatMap((reason) =>
    [null, 200, 400, 503].map((status) => ({ reason, status })),
  );

  test.for(interruptions)(
    'preserves $reason while reading $status (null means headers)',
    async ({ reason, status }, { supportApi }) => {
      const id = crypto.randomUUID();
      const incidentId = `INC-INTERRUPTED-${id}`;
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const controller = new AbortController();
      const interruption = new DOMException(
        'Private provider diagnostics',
        reason,
      );
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(controller.signal);
      let modelResponse: Response | undefined;
      let bodyReadStarted = false;
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce((_url, request) => {
          const signal = request?.signal;
          if (signal !== controller.signal)
            throw new Error('Missing model deadline');
          if (status === null) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
              queueMicrotask(() => controller.abort(interruption));
            });
          }

          const body = new ReadableStream<Uint8Array>(
            {
              start(stream) {
                stream.enqueue(new TextEncoder().encode('{"error":'));
              },
              pull(stream) {
                bodyReadStarted = true;
                signal.addEventListener(
                  'abort',
                  () => stream.error(signal.reason),
                  { once: true },
                );
                queueMicrotask(() => controller.abort(interruption));
              },
            },
            { highWaterMark: 0 },
          );
          modelResponse = new Response(body, { status });
          return Promise.resolve(modelResponse);
        });

      const response = await POST(
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId: `MSG-${id}`,
          message: 'Help with a shipment.',
        }),
      );

      expect(response.status).toBe(reason === 'TimeoutError' ? 504 : 503);
      expect(await response.json()).toEqual({
        error:
          reason === 'TimeoutError'
            ? 'The support model took too long to respond. Please try again.'
            : 'The support model is unavailable. Please try again.',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledExactlyOnceWith(120_000);
      expect(controller.signal.reason).toBe(interruption);
      expect(bodyReadStarted).toBe(status !== null);
      if (modelResponse) expect(modelResponse.bodyUsed).toBe(true);
      expect(await supportApi.findIncident(incidentId)).toBeNull();
      expect((await supportApi.messages(incidentId)).results).toEqual([]);
    },
  );

  const providerFailure =
    'The support model could not complete that request. Please try again.';
  const contextFailure =
    'That message is too long for the support model. Shorten it and try again.';
  const errorBodies = [
    {
      label: 'malformed HTTP 400',
      status: 400,
      body: '{"error":',
      expectedStatus: 502,
      error: providerFailure,
    },
    {
      label: 'malformed HTTP 503',
      status: 503,
      body: '{"error":',
      expectedStatus: 502,
      error: providerFailure,
    },
    {
      label: 'null payload',
      status: 400,
      body: 'null',
      expectedStatus: 502,
      error: providerFailure,
    },
    {
      label: 'non-object error',
      status: 400,
      body: '{"error":"private diagnostics"}',
      expectedStatus: 502,
      error: providerFailure,
    },
    {
      label: 'non-string message',
      status: 400,
      body: '{"error":{"message":42}}',
      expectedStatus: 502,
      error: providerFailure,
    },
    ...[
      'This request exceeds the available context size.',
      'This request exceeds the MAXIMUM CONTEXT LENGTH.',
      'Context length exceeded.',
    ].map((message) => ({
      label: message,
      status: 400,
      body: JSON.stringify({ error: { message } }),
      expectedStatus: 422,
      error: contextFailure,
    })),
    {
      label: 'context text on HTTP 503',
      status: 503,
      body: '{"error":{"message":"maximum context length"}}',
      expectedStatus: 502,
      error: providerFailure,
    },
  ];

  test.for(errorBodies)(
    'keeps the safe error for $label',
    async ({ status, body, expectedStatus, error }, { supportApi }) => {
      const id = crypto.randomUUID();
      const incidentId = `INC-PROVIDER-${id}`;
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const modelResponse = new Response(body, { status });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(modelResponse);

      const response = await POST(
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId: `MSG-${id}`,
          message: 'Help with a shipment.',
        }),
      );

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await supportApi.findIncident(incidentId)).toBeNull();
      expect((await supportApi.messages(incidentId)).results).toEqual([]);
    },
  );
});
