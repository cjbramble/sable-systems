import type {
  SupportContextResult,
  SupportRecordsContext,
} from '@/lib/support-outcomes';

export function requireSupportRecords(
  context: SupportContextResult,
): SupportRecordsContext {
  if (context.kind !== 'records')
    throw new Error(
      `Expected support records, received clarification: ${context.message}`,
    );
  return context;
}
