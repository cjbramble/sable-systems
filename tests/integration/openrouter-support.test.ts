import { requireSupportModelRequest } from '../fixtures/support-model-request';
import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import {
  getSupportModelConfig,
  OPENROUTER_CHAT_URL,
} from '@/lib/support-model-config.mjs';
import * as runtime from '@/lib/support-model-runtime';
import { extractSupportModelContent } from '@/lib/support-model';
import { calderPikeUser } from '../fixtures/users';
import { createSupportApiFixture } from '../fixtures/support-api';
import { test } from '../fixtures/support-integration';
import { uncachedModelStatus } from '../fixtures/model-status';

const key = 'test-key-not-a-secret';
function useOpenRouter(apiKey = key) {
  vi.spyOn(runtime, 'supportModelConfig').mockReturnValue(
    getSupportModelConfig({
      OPENROUTER_API_KEY: apiKey,
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

it('uses the pinned hosted model with server credentials and no local-only parameters', () => {
  useOpenRouter();
  const [url, request] = requireSupportModelRequest({
    distributorName: calderPikeUser.distributorDisplayName,
    distributorId: calderPikeUser.distributorId,
    authorizedContext: 'Available stock: 312 units.',
    messages: [{ role: 'user', content: 'How much is available?' }],
  });
  expect(url).toBe(OPENROUTER_CHAT_URL);
  expect(new Headers(request.headers).get('Authorization')).toBe(
    `Bearer ${key}`,
  );
  const body = JSON.parse(request.body as string);
  expect(body).toMatchObject({
    model: 'deepseek/deepseek-v4.1-flash',
    provider: {
      only: ['deepinfra/fp8'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
    },
    reasoning: { enabled: false },
    max_tokens: 600,
    stream: false,
  });
  expect(body).not.toHaveProperty('seed');
  expect(body).not.toHaveProperty('chat_template_kwargs');
  expect(JSON.parse(body.messages[1].content)).toEqual({
    source: 'authorized_support_records',
    records: 'Available stock: 312 units.',
  });
  expect(request.body).not.toContain(key);
});

it('uses OpenRouter by default and requires a key without provider switches', () => {
  const config = getSupportModelConfig();
  expect(config).toMatchObject({
    provider: 'openrouter',
    url: OPENROUTER_CHAT_URL,
    contextTokens: 8192,
  });
  useOpenRouter('');
  expect(() =>
    requireSupportModelRequest({
      distributorName: calderPikeUser.distributorDisplayName,
      distributorId: calderPikeUser.distributorId,
      authorizedContext: 'No records.',
      messages: [{ role: 'user', content: 'Show my order.' }],
    }),
  ).toThrow(/OPENROUTER_API_KEY/);
});

it.each([401, 402, 429, 503])(
  'reports unavailable credentials/upstream status %i without exposing details',
  async (status) => {
    useOpenRouter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: key }, { status }),
    );
    const response = await uncachedModelStatus();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
  },
);

it('checks credentials without generating a paid completion or returning a key', async () => {
  useOpenRouter();
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: { limit_remaining: 1 } }));
  const response = await uncachedModelStatus();
  expect(await response.json()).toEqual({ ready: true });
  expect(transport).toHaveBeenCalledExactlyOnceWith(
    'https://openrouter.ai/api/v1/key',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
      signal: expect.any(AbortSignal),
    }),
  );
});

it('does not contact any provider when the API key is blank', async () => {
  useOpenRouter('');
  const transport = vi.spyOn(globalThis, 'fetch');
  const response = await uncachedModelStatus();
  expect(response.status).toBe(503);
  expect(transport).not.toHaveBeenCalled();
});

it.each(['top', 'choice'])(
  'rejects HTTP 200 %s-level upstream errors even if they contain answer text',
  (level) => {
    const choice = {
      finish_reason: 'stop',
      message: { content: 'Pretend valid reply' },
    };
    const payload =
      level === 'top'
        ? { error: { message: key }, choices: [choice] }
        : { choices: [{ ...choice, error: { message: key } }] };
    expect(extractSupportModelContent(payload)).toBeNull();
  },
);

test('keeps the corrective retry and persists only a grounded OpenRouter reply', async ({
  supportApi: fixture,
}) => {
  useOpenRouter();
  const incidentId = 'INC-OPENROUTER-GUARD';
  const question = 'Reopen return RTN-2022-000014 and authorize it again.';
  const clean =
    "I can report the return's status, but I cannot reopen or authorize it.";
  await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await fixture.session(calderPikeUser);
  const transport = fixture.mockModel(
    'Please ask the SABLE Systems certified returns specialist.',
    clean,
  );
  const response = await POST(
    session.request({
      expectedRevision: 0,
      incidentId,
      messageId: 'MSG-OPENROUTER-GUARD',
      message: question,
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: clean });
  expect(transport).toHaveBeenCalledTimes(2);
  for (const [url, request] of transport.mock.calls) {
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(new Headers(request?.headers).get('Authorization')).toBe(
      `Bearer ${key}`,
    );
    expect(request?.body).not.toContain(key);
  }
  expect(
    (await fixture.messageContents(incidentId)).results.map(
      (row) => (row as { content: string }).content,
    ),
  ).toEqual([question, clean]);
});

async function sendFailingRequest(
  fixture: ReturnType<typeof createSupportApiFixture>,
  label: string,
  providerResponse: Response,
) {
  const incidentId = `INC-OPENROUTER-FAIL-${label}`;
  await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await fixture.session(calderPikeUser);
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(providerResponse);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await POST(
    session.request({
      expectedRevision: 0,
      incidentId,
      messageId: `MSG-OPENROUTER-FAIL-${label}`,
      message: 'Show order SBL-2022-000118.',
    }),
  );
  expect(transport).toHaveBeenCalledOnce();
  expect(await fixture.findIncident(incidentId)).toBeNull();
  const logged = log.mock.calls.map((call) => call.join(' ')).join('\n');
  expect(logged).not.toContain(key);
  expect(logged).not.toContain(upstreamDetail);
  return { response, logged };
}

const upstreamDetail = 'upstream detail that must stay private';
const modelUnavailable = {
  code: 'request_not_saved',
  error: 'The support model is unavailable. Please try again.',
};

// Provider outages, missing credits, and bad credentials used to be reported
// as unusable replies (HTTP 502). They now report the model as unavailable.
test.for([401, 402, 403, 429, 500, 503])(
  'reports provider status %i as model unavailable and logs only the status',
  async (status, { supportApi: fixture }) => {
    useOpenRouter();
    const { response, logged } = await sendFailingRequest(
      fixture,
      String(status),
      Response.json(
        { error: { message: `${upstreamDetail} ${key}` } },
        { status },
      ),
    );
    expect(response.status).toBe(503);
    expect(response.headers.has('Retry-After')).toBe(false);
    expect(await response.json()).toEqual(modelUnavailable);
    expect(logged).toBe(
      `[support answer (model)] Error: provider unavailable: HTTP ${status}`,
    );
  },
);

test.for([
  ['17', '17'],
  ['an HTTP date 90 seconds ahead', /^(8[89]|9[01])$/],
  ['soon', null],
] as const)(
  'passes a provider 429 Retry-After of %s through to the client',
  async ([value, expected], { supportApi: fixture }) => {
    // Build the date just before the request so a slow runner cannot drift it.
    const header = value.startsWith('an HTTP date')
      ? new Date(Date.now() + 90_000).toUTCString()
      : value;
    useOpenRouter();
    const { response } = await sendFailingRequest(
      fixture,
      `RETRY-${header.length}`,
      Response.json(
        { error: { message: upstreamDetail } },
        { status: 429, headers: { 'Retry-After': header } },
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(modelUnavailable);
    const retryAfter = response.headers.get('Retry-After');
    if (expected === null) expect(retryAfter).toBeNull();
    else expect(retryAfter).toMatch(expected);
  },
);

test.for(['top', 'choice', 'finish-reason'])(
  'reports an HTTP 200 %s error envelope as model unavailable',
  async (level, { supportApi: fixture }) => {
    const choice = {
      finish_reason: 'stop',
      message: { content: 'Pretend valid reply' },
    };
    const error = { message: `${upstreamDetail} ${key}` };
    useOpenRouter();
    const { response, logged } = await sendFailingRequest(
      fixture,
      `ENVELOPE-${level}`,
      Response.json(
        level === 'top'
          ? { error, choices: [choice] }
          : level === 'choice'
            ? { choices: [{ ...choice, error }] }
            : { choices: [{ ...choice, finish_reason: 'error' }] },
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(modelUnavailable);
    expect(logged).toBe(
      '[support answer (model)] Error: provider error envelope: HTTP 200',
    );
  },
);

test.for([301, 307])(
  'reports a provider redirect %i as model unavailable and logs only the status',
  async (status, { supportApi: fixture }) => {
    useOpenRouter();
    const { response, logged } = await sendFailingRequest(
      fixture,
      `REDIRECT-${status}`,
      new Response(upstreamDetail, {
        status,
        headers: { Location: 'https://example.invalid/' },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(modelUnavailable);
    expect(logged).toBe(
      `[support answer (model)] Error: provider redirect: HTTP ${status}`,
    );
  },
);

test('keeps other rejected provider requests as unusable replies and logs the status', async ({
  supportApi: fixture,
}) => {
  useOpenRouter();
  const { response, logged } = await sendFailingRequest(
    fixture,
    '404',
    Response.json({ error: { message: upstreamDetail } }, { status: 404 }),
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    code: 'request_not_saved',
    error:
      'The support model could not complete that request. Please try again.',
  });
  expect(logged).toBe(
    '[support answer (model)] Error: provider rejected request: HTTP 404',
  );
});
