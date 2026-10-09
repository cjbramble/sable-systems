export type SupportChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // ISO timestamp, or null for the unsaved welcome message.
  createdAt: string | null;
};

export type SupportFailure = {
  error: string;
  code?: 'incident_deleted';
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

const LISTED_INCIDENTS = 8;

// Customer-written titles are shown as quoted text: inline Markdown characters
// are escaped so a title cannot add links, images, markup or formatting.
function incidentTitleText(title: string) {
  return title.replace(/\s+/g, ' ').replace(/[\\`*_[\]()<>~|]/g, '\\$&');
}

// Incident lists are pure records, so the server writes them directly instead
// of asking the model, which could omit or rewrite a customer-written title.
export function formatIncidentListReply(incidents: SupportIncident[]) {
  if (!incidents.length) return 'You have no saved support incidents.';
  const total = incidents.length;
  const listed = incidents.slice(0, LISTED_INCIDENTS);
  const noun = total === 1 ? 'incident' : 'incidents';
  const heading =
    total > listed.length
      ? `You have ${total} saved support ${noun}. Here are the ${listed.length} most recent:`
      : `You have ${total} saved support ${noun}:`;
  return [
    heading,
    '',
    ...listed.map((incident) => {
      const count = incident.messages.length;
      return `- ${incident.id}: “${incidentTitleText(incident.title)}” (updated ${incident.updatedAt.slice(0, 10)} UTC; ${count} ${count === 1 ? 'message' : 'messages'})`;
    }),
  ].join('\n');
}
