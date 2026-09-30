import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { GET } from '@/app/api/status/route';
import {
  getSupportModelConfig,
  OPENROUTER_CHAT_URL,
} from '@/lib/support-model-config.mjs';
import * as runtime from '@/lib/support-model-runtime';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';
import { calderPikeUser } from '../fixtures/users';
import { test } from '../fixtures/support-integration';

const key = 'test-key-not-a-secret';
function useOpenRouter(apiKey = key) {
  vi.spyOn(runtime, 'supportModelConfig').mockReturnValue(
    getSupportModelConfig({
      SUPPORT_MODEL_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: apiKey,
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

it('uses the pinned hosted model with server credentials and no local-only parameters', () => {
  useOpenRouter();
  const [url, request] = createSupportModelRequest({
    distributorName: calderPikeUser.distributorDisplayName,
    distributorId: calderPikeUser.distributorId,
    authorizedContext: 'Available stock: 312 units.',
    messages: [{ role: 'user', content: 'How much is available?' }],
    generation: { seed: 42 },
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

it('fails closed for invalid provider configuration', () => {
  expect(() =>
    getSupportModelConfig({ SUPPORT_MODEL_PROVIDER: 'typo' }),
  ).toThrow(/local or openrouter/);
});

it.each([401, 402, 429, 503])(
  'reports unavailable credentials/upstream status %i without exposing details',
  async (status) => {
    useOpenRouter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: key }, { status }),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
  },
);

it('checks credentials without generating a paid completion or returning a key', async () => {
  useOpenRouter();
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: { limit_remaining: 1 } }));
  const response = await GET();
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
  const response = await GET();
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
      incidentId,
      messageId: 'MSG-OPENROUTER-GUARD',
      messages: [{ role: 'user', content: question }],
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

test.for([401, 402, 429, 503])(
  'does not save failed hosted responses or leak upstream detail: %i',
  async (status, { supportApi: fixture }) => {
    useOpenRouter();
    const incidentId = `INC-OPENROUTER-FAIL-${status}`;
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: { message: key } }, { status }),
      );
    const response = await POST(
      session.request({
        incidentId,
        messageId: `MSG-OPENROUTER-FAIL-${status}`,
        messages: [{ role: 'user', content: 'Show order SBL-2022-000118.' }],
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        'The support model could not complete that request. Please try again.',
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(await fixture.findIncident(incidentId)).toBeNull();
  },
);
