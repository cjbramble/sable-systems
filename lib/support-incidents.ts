export type SupportChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type SupportIncident = {
  id: string;
  title: string;
  updatedAt: string;
  messages: SupportChatMessage[];
};

function isSupportChatMessage(value: unknown): value is SupportChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<SupportChatMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'string'
  );
}

function isSupportIncident(value: unknown): value is SupportIncident {
  if (!value || typeof value !== 'object') return false;
  const incident = value as Partial<SupportIncident>;
  return (
    typeof incident.id === 'string' &&
    typeof incident.title === 'string' &&
    typeof incident.updatedAt === 'string' &&
    Array.isArray(incident.messages) &&
    incident.messages.every(isSupportChatMessage)
  );
}

export function parseStoredIncidents(
  value: string | null,
  fallback: SupportIncident[],
) {
  if (value === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(isSupportIncident)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

export function filterSupportIncidents(
  incidents: SupportIncident[],
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return incidents;
  return incidents.filter((incident) =>
    incident.title.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function removeSupportIncident(
  incidents: SupportIncident[],
  incidentId: string,
) {
  return incidents.filter((incident) => incident.id !== incidentId);
}

export function createIncidentTitle(message: string) {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 42) return normalized;
  return `${normalized.slice(0, 39).trimEnd()}…`;
}
