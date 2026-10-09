import { expect, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

test('rejects oversized new completions before saving and permits the same command to retry', async ({
  supportApi,
}) => {
  const incidentId = 'INC-OUTPUT-SIZE-BOUNDARY';
  await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
  const session = await supportApi.session(calderPikeUser);
  supportApi.mockModel('x'.repeat(8001), '🙂'.repeat(4000));
  const command = {
    expectedRevision: 0,
    incidentId,
    messageId: 'MSG-OUTPUT-SIZE-BOUNDARY',
    message: 'Help with a shipment.',
  };
  const rejected = await POST(session.request(command));
  expect(rejected.status).toBe(502);
  expect(await rejected.json()).toMatchObject({
    error: expect.stringContaining('reply was too long'),
  });
  expect(await supportApi.findIncident(incidentId)).toBeNull();
  expect((await supportApi.messages(incidentId)).results).toEqual([]);
  const accepted = await POST(session.request(command));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ message: '🙂'.repeat(4000) });
  expect((await supportApi.messages(incidentId)).results).toHaveLength(2);
});

test.for([200, 503])(
  'rejects an oversized provider envelope with status %s before persistence',
  async (status, { supportApi }) => {
    const incidentId = `INC-PROVIDER-BYTES-${status}`;
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const response = Response.json(
      {
        choices: [
          { finish_reason: 'stop', message: { content: 'Which shipment?' } },
        ],
        padding: 'x'.repeat(1048576),
      },
      { status },
    );
    const model = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    try {
      const rejected = await POST(
        session.request({
          expectedRevision: 0,
          incidentId,
          messageId: 'MSG-PROVIDER-BYTES',
          message: 'Help with a shipment.',
        }),
      );
      expect(rejected.status).toBe(502);
      expect(await rejected.json()).toMatchObject({
        error: expect.stringContaining('response was too large'),
      });
      expect(await supportApi.findIncident(incidentId)).toBeNull();
      expect((await supportApi.messages(incidentId)).results).toEqual([]);
    } finally {
      model.mockRestore();
    }
  },
);

test('accepts exactly 32 KiB and rejects larger requests before database work', async ({
  database,
  supportApi,
}) => {
  const session = await supportApi.session(calderPikeUser);
  const model = supportApi.mockModel('Which shipment?');
  const body = JSON.stringify({ message: '🙂'.repeat(2000) });
  const bytes = new TextEncoder().encode(body).length;
  const request = (size: number) =>
    new Request(session.request({}), {
      method: 'POST',
      body: body + ' '.repeat(size - bytes),
    });
  expect((await POST(request(32768))).status).toBe(200);
  const prepare = vi.spyOn(database, 'prepare');
  try {
    const rejected = await POST(request(32769));
    expect(rejected.status).toBe(413);
    expect(prepare).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledOnce();
  } finally {
    prepare.mockRestore();
  }
});
