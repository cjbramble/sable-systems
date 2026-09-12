export type SupportChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // ISO timestamp, or null for the unsaved welcome message.
  createdAt: string | null;
};

export type SupportReply = {
  message: string;
  customerCreatedAt: string;
  assistantCreatedAt: string;
  incidentUpdatedAt: string;
};

export type SupportIncident = {
  id: string;
  title: string;
  updatedAt: string;
  messages: SupportChatMessage[];
};

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
