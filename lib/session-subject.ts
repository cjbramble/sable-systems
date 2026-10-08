import type { SessionSubject } from './contracts';

export function parseSessionSubject(value: unknown): SessionSubject | null {
  if (!value || typeof value !== 'object') return null;
  const { userId, customerId } = value as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !userId.trim() ||
    userId.length > 128 ||
    typeof customerId !== 'string' ||
    !customerId.trim() ||
    customerId.length > 128
  )
    return null;
  return { userId, customerId };
}

export function sameSessionSubject(
  left: SessionSubject,
  right: SessionSubject,
): boolean {
  return left.userId === right.userId && left.customerId === right.customerId;
}
