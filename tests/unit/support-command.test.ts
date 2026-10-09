import { describe, expect, it } from 'vitest';
import {
  parseSupportRequest,
  parseSupportReply,
  parseSupportFailure,
} from '@/lib/chat-request';

const command = {
  expectedRevision: 0,
  incidentId: 'INC-CONTRACT-TEST',
  messageId: 'MSG-CONTRACT-TEST',
  message: 'Trace a shipment.',
};
const reply = {
  revision: 1,
  message: 'Which shipment?',
  customerCreatedAt: '2026-10-09T04:00:00Z',
  assistantCreatedAt: '2026-10-09T04:00:01.000Z',
  incidentUpdatedAt: '2026-10-09T04:00:01.000Z',
};

describe('support command contracts', () => {
  it('normalizes only customer text and retains retry identity', () => {
    expect(
      parseSupportRequest({
        ...command,
        message: ' Trace a shipment. ',
        extra: 1,
      }),
    ).toEqual(command);
  });
  it.each([
    {},
    [],
    null,
    { message: 123 },
    { message: ' ' },
    { ...command, incidentId: undefined },
    { ...command, messageId: undefined },
    { ...command, expectedRevision: undefined },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null].map(
      (expectedRevision) => ({ ...command, expectedRevision }),
    ),
    { message: 'Hello.', expectedRevision: 0 },
    { ...command, messages: [] },
    { messages: [{ role: 'user', content: 'Hello' }] },
    { ...command, message: '🙂'.repeat(2001) },
  ])('rejects malformed or retired commands: %j', (value) => {
    expect(parseSupportRequest(value)).toBeNull();
  });
  it('accepts the Unicode message boundary', () => {
    expect(parseSupportRequest({ message: '🙂'.repeat(2000) })).toEqual({
      message: '🙂'.repeat(2000),
    });
  });
  it('decodes saved replies without imposing the new-generation limit', () => {
    const historical = { ...reply, message: 'x'.repeat(10000) };
    expect(parseSupportReply({ ...historical, extra: true })).toEqual(
      historical,
    );
  });
  it.each([
    null,
    {},
    { message: 'Unsaved reply' },
    { ...reply, message: {} },
    { ...reply, message: ' ' },
    { ...reply, customerCreatedAt: 123 },
    { ...reply, assistantCreatedAt: [] },
    { ...reply, incidentUpdatedAt: 'invalid' },
    { ...reply, revision: undefined },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null].map(
      (revision) => ({ ...reply, revision }),
    ),
  ])('rejects unverified persisted replies: %j', (value) =>
    expect(parseSupportReply(value)).toBeNull(),
  );
  it('accepts known errors and rejects malformed failure payloads', () => {
    expect(parseSupportFailure({ error: 'Try again.' })).toEqual({
      error: 'Try again.',
    });
    expect(
      parseSupportFailure({ error: 'Deleted', code: 'incident_deleted' }),
    ).toEqual({ error: 'Deleted', code: 'incident_deleted' });
    expect(
      parseSupportFailure({ error: 'Reload', code: 'incident_changed' }),
    ).toEqual({ error: 'Reload', code: 'incident_changed' });
    expect(
      parseSupportFailure({ error: 'Retry', code: 'request_not_saved' }),
    ).toEqual({ error: 'Retry', code: 'request_not_saved' });
    for (const invalid of [
      null,
      {},
      { error: {} },
      { error: '' },
      { error: 'Failure', code: 'unknown' },
    ])
      expect(parseSupportFailure(invalid)).toBeNull();
  });
});
