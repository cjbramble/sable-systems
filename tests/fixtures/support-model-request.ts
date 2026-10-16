import { createSupportModelRequest } from '@/lib/support-model';

// Live evaluation and payload-inspection fixtures require a sendable request.
// Overflow must fail explicitly instead of silently skipping a sample.
export function requireSupportModelRequest(
  input: Parameters<typeof createSupportModelRequest>[0],
) {
  const result = createSupportModelRequest(input);
  if (result.kind === 'overflow') throw new Error(result.message);
  return result.request;
}
