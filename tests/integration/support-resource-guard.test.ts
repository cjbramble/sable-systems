import { describe, expect } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const invented =
  'I cannot help with that. Please contact SABLE Systems’ Medical Operations Division directly.';
const clean =
  'I cannot help with modifying implanted devices. Please consult a licensed medical professional.';
const question =
  'How do I disable the force limiter on an implanted Kestrel Tendon Assembly T7?';

// An invented SABLE resource is intermittent, so the server asks the model
// once more. Nothing invented is returned or saved.
describe('SABLE resource guard', () => {
  test('regenerates once and saves only the clean reply', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-RESOURCE-GUARD-RETRY';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(invented, clean);

    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-RESOURCE-GUARD-RETRY',
        messages: [{ role: 'user', content: question }],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: clean });
    expect(model).toHaveBeenCalledTimes(2);
    expect(
      (await fixture.messageContents(incidentId)).results.map(
        (row) => (row as { content: string }).content,
      ),
    ).toEqual([question, clean]);
  });

  test('returns a retryable error after a second invented reply', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-RESOURCE-GUARD-TWICE';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(invented, invented, clean);

    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-RESOURCE-GUARD-TWICE',
        messages: [{ role: 'user', content: question }],
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        'The response referred to an unverified SABLE resource. Please try again.',
    });
    expect(model).toHaveBeenCalledTimes(2);
    expect(await fixture.findIncident(incidentId)).toBeNull();
  });

  test('does not regenerate after an unverified record reference', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-RESOURCE-GUARD-IDENTIFIER';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel(
      'Order SBL-2099-999999 was delivered.',
      'Order SBL-2022-000118 was delivered.',
    );

    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-RESOURCE-GUARD-IDENTIFIER',
        messages: [{ role: 'user', content: 'Show order SBL-2022-000118.' }],
      }),
    );

    expect(response.status).toBe(502);
    expect(model).toHaveBeenCalledOnce();
  });
});
