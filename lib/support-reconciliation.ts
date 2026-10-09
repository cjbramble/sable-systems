import type { SupportCommand } from './chat-request';
import type { SupportIncident } from './support-incidents';

export function reconcileSupportSnapshot(
  snapshot: SupportIncident | null,
  request: SupportCommand,
): 'confirmed' | 'changed' | 'unconfirmed' {
  if (
    !snapshot ||
    snapshot.id !== request.incidentId ||
    snapshot.revision < request.expectedRevision
  )
    return 'unconfirmed';
  const customerIndex = snapshot.messages.findIndex(
    (message) =>
      message.id === request.messageId &&
      message.role === 'user' &&
      message.content === request.message,
  );
  const assistant =
    customerIndex >= 0 ? snapshot.messages[customerIndex + 1] : undefined;
  if (
    assistant?.id === `AST-${request.messageId}` &&
    assistant.role === 'assistant'
  )
    return 'confirmed';
  // A different exchange advanced the compare-and-save revision, so the old
  // command can no longer commit. An unchanged snapshot proves no such thing.
  return snapshot.revision > request.expectedRevision
    ? 'changed'
    : 'unconfirmed';
}
