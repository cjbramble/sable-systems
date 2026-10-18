import {
  createSupportModelRequest,
  SUPPORT_MODEL_TIMEOUT_MS,
} from '@/lib/support-model';

type SupportModelRequestInput = Parameters<typeof createSupportModelRequest>[0];

// Live evaluation and payload-inspection fixtures require a sendable request.
// Overflow must fail explicitly instead of silently skipping a sample.
export function requireSupportModelRequest(
  input: Omit<SupportModelRequestInput, 'signal'> &
    Partial<Pick<SupportModelRequestInput, 'signal'>>,
) {
  const result = createSupportModelRequest({
    signal: AbortSignal.timeout(SUPPORT_MODEL_TIMEOUT_MS),
    ...input,
  });
  if (result.kind === 'overflow') throw new Error(result.message);
  return result.request;
}
