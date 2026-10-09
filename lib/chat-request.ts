export const MAX_CHAT_MESSAGE_LENGTH = 4_000;
export const MAX_SUPPORT_REPLY_LENGTH = 8_000;
export const MAX_CHAT_REQUEST_BYTES = 32 * 1024;
export const MAX_MODEL_RESPONSE_BYTES = 1024 * 1024;

export type SupportCommand = {
  incidentId: string;
  messageId: string;
  message: string;
  expectedRevision: number;
};

// Omitting both IDs requests a reply without persisting a conversation.
export type SupportRequest =
  | SupportCommand
  | {
      message: string;
      incidentId?: never;
      messageId?: never;
      expectedRevision?: never;
    };

export type SupportResponse = { message: string };

export type SupportReply = SupportResponse & {
  revision: number;
  customerCreatedAt: string;
  assistantCreatedAt: string;
  incidentUpdatedAt: string;
};

export type SupportFailure = {
  error: string;
  code?: 'incident_deleted' | 'incident_changed';
};

export function parseIncidentId(value: unknown): string | null {
  return typeof value === 'string' && /^INC-[A-Za-z0-9-]{6,100}$/.test(value)
    ? value
    : null;
}

function parseMessageId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{6,120}$/.test(value)
    ? value
    : null;
}

export function parseSupportRequest(value: unknown): SupportRequest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  // Reject the retired shape explicitly, including ambiguous mixed requests.
  if ('messages' in candidate || typeof candidate.message !== 'string')
    return null;
  const message = candidate.message.trim();
  if (!message || message.length > MAX_CHAT_MESSAGE_LENGTH) return null;
  if (candidate.incidentId === undefined && candidate.messageId === undefined)
    return candidate.expectedRevision === undefined ? { message } : null;
  const incidentId = parseIncidentId(candidate.incidentId);
  const messageId = parseMessageId(candidate.messageId);
  const { expectedRevision } = candidate;
  return incidentId && messageId && isSupportRevision(expectedRevision)
    ? { incidentId, messageId, message, expectedRevision }
    : null;
}

export function isSupportRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isSupportTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseSupportReply(value: unknown): SupportReply | null {
  if (!value || typeof value !== 'object') return null;
  const {
    message,
    customerCreatedAt,
    assistantCreatedAt,
    incidentUpdatedAt,
    revision,
  } = value as Record<string, unknown>;
  // Historical replies remain readable even when they exceed today's output limit.
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    !isSupportTimestamp(customerCreatedAt) ||
    !isSupportTimestamp(assistantCreatedAt) ||
    !isSupportTimestamp(incidentUpdatedAt) ||
    !isSupportRevision(revision)
  )
    return null;
  return {
    message,
    customerCreatedAt,
    assistantCreatedAt,
    incidentUpdatedAt,
    revision,
  };
}

export function parseSupportFailure(value: unknown): SupportFailure | null {
  if (!value || typeof value !== 'object') return null;
  const { error, code } = value as Record<string, unknown>;
  if (typeof error !== 'string' || !error.trim() || error.length > 1000)
    return null;
  if (code === undefined) return { error };
  return code === 'incident_deleted' || code === 'incident_changed'
    ? { error, code }
    : null;
}
