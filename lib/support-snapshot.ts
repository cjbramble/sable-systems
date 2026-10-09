import { isSupportRevision, isSupportTimestamp } from './chat-request';
import type { AccountSummary } from './contracts';
import { parseSessionSubject } from './session-subject';
import type { SupportChatMessage, SupportIncident } from './support-incidents';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseSupportAccount(value: unknown): AccountSummary | null {
  if (!isRecord(value)) return null;
  const subject = parseSessionSubject(value);
  if (
    !subject ||
    typeof value.displayName !== 'string' ||
    typeof value.accountTier !== 'string' ||
    typeof value.userDisplayName !== 'string' ||
    (value.userRole !== 'account_admin' &&
      value.userRole !== 'buyer' &&
      value.userRole !== 'support') ||
    typeof value.paymentTerms !== 'string' ||
    typeof value.currency !== 'string' ||
    typeof value.region !== 'string' ||
    !isCount(value.totalOrders) ||
    !isCount(value.activeOrders) ||
    !isCount(value.scheduledOrders) ||
    !isCount(value.inventoryAlerts) ||
    !isCalendarDate(value.seedAsOfDate) ||
    !isSupportTimestamp(value.retrievedAt)
  )
    return null;
  return {
    ...subject,
    displayName: value.displayName,
    accountTier: value.accountTier,
    userDisplayName: value.userDisplayName,
    userRole: value.userRole,
    paymentTerms: value.paymentTerms,
    currency: value.currency,
    region: value.region,
    totalOrders: value.totalOrders,
    activeOrders: value.activeOrders,
    scheduledOrders: value.scheduledOrders,
    inventoryAlerts: value.inventoryAlerts,
    seedAsOfDate: value.seedAsOfDate,
    retrievedAt: value.retrievedAt,
  };
}

function parseSavedMessage(value: unknown): SupportChatMessage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    value.content.length === 0 ||
    !isSupportTimestamp(value.createdAt)
  )
    return null;
  // Saved history keeps its original text and IDs, including records that
  // predate the current new-command limits.
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
  };
}

function parseSavedIncident(value: unknown): SupportIncident | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    value.title.length > 120 ||
    !isSupportTimestamp(value.updatedAt) ||
    !isSupportRevision(value.revision) ||
    !Array.isArray(value.messages)
  )
    return null;
  const messages: SupportChatMessage[] = [];
  const messageIds = new Set<string>();
  for (const candidate of value.messages) {
    const message = parseSavedMessage(candidate);
    if (!message || messageIds.has(message.id)) return null;
    messages.push(message);
    messageIds.add(message.id);
  }
  return {
    id: value.id,
    title: value.title,
    updatedAt: value.updatedAt,
    revision: value.revision,
    messages,
  };
}

export function parseSupportIncidents(
  value: unknown,
): SupportIncident[] | null {
  if (!isRecord(value) || !Array.isArray(value.incidents)) return null;
  const incidents: SupportIncident[] = [];
  const incidentIds = new Set<string>();
  for (const candidate of value.incidents) {
    const incident = parseSavedIncident(candidate);
    if (!incident || incidentIds.has(incident.id)) return null;
    incidents.push(incident);
    incidentIds.add(incident.id);
  }
  return incidents;
}

// Decode only the requested snapshot; unrelated conversations are not replaced.
// A missing new incident may still be saving; callers decide whether absence
// means deletion. Invalid data must remain retryable.
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
  const incident = parseSavedIncident(matches[0]);
  if (!incident) throw invalid();
  return incident;
}
