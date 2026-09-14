import { expect, it } from 'vitest';
import { createSupportModelRequest } from '@/lib/support-model';
import { calderPikeUser } from '../fixtures/users';

it('sets the concise response policy server-side without rewriting customer messages', () => {
  const messages = [
    { role: 'user' as const, content: 'Has my order shipped?' },
  ];
  const authorizedContext =
    '<authorized_records>No shipment record yet.</authorized_records>';
  const [, request] = createSupportModelRequest({
    distributorName: calderPikeUser.distributorDisplayName,
    distributorId: calderPikeUser.distributorId,
    authorizedContext,
    messages,
  });
  const payload = JSON.parse(request.body as string);

  expect(payload.messages[0].role).toBe('system');
  expect(payload.messages[0].content).toContain('one to three short sentences');
  expect(payload.messages[0].content).toContain(
    'Preserve every requested item and important limitation.',
  );
  expect(payload.messages[0].content).toContain(authorizedContext);
  expect(payload.messages.slice(1)).toEqual(messages);
});
