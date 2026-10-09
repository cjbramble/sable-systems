import { isSupportRevision, isSupportTimestamp } from './chat-request';
import type { SupportChatMessage, SupportIncident } from './support-incidents';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSavedMessage(value: unknown): value is SupportChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    value.content.length > 0 &&
    isSupportTimestamp(value.createdAt)
  );
}

// Decode only the requested snapshot; unrelated conversations are not replaced.
// A missing incident is a deletion, while invalid data must remain retryable.
export function parseIncidentSnapshot(
  value: unknown,
  incidentId: string,
): SupportIncident | null {
  const invalid = () =>
    new Error('The conversation could not be reloaded. Please try again.');
  if (!isRecord(value) || !Array.isArray(value.incidents)) throw invalid();
  if (
    !value.incidents.every(
      (incident: unknown) =>
        isRecord(incident) && typeof incident.id === 'string',
    )
  )
    throw invalid();
  const matches = value.incidents.filter(
    (incident: unknown) => isRecord(incident) && incident.id === incidentId,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw invalid();
  const incident: unknown = matches[0];
  if (
    !isRecord(incident) ||
    typeof incident.title !== 'string' ||
    incident.title.length === 0 ||
    incident.title.length > 120 ||
    !isSupportTimestamp(incident.updatedAt) ||
    !isSupportRevision(incident.revision) ||
    !Array.isArray(incident.messages) ||
    !incident.messages.every(isSavedMessage) ||
    new Set(incident.messages.map((message) => message.id)).size !==
      incident.messages.length
  )
    throw invalid();
  return {
    id: incidentId,
    title: incident.title,
    updatedAt: incident.updatedAt,
    revision: incident.revision,
    messages: incident.messages,
  };
}
