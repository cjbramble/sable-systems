import type { AuthenticatedUser } from './auth';
import {
  createIncidentTitle,
  type SupportIncident,
  type SupportReply,
} from '../lib/support-incidents.ts';

const INCIDENT_ID_PATTERN = /^INC-[A-Za-z0-9-]{6,100}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9-]{6,120}$/;

export class IncidentAccessDeniedError extends Error {
  constructor() {
    super('Incident authorization scope mismatch.');
    this.name = 'IncidentAccessDeniedError';
  }
}

export class SupportMessageTextConflictError extends Error {
  constructor() {
    super(
      'This message ID was already used for different text. Send a new message.',
    );
    this.name = 'SupportMessageTextConflictError';
  }
}

export class SupportMessageIdConflictError extends Error {
  constructor() {
    super('This message ID is already in use. Send a new message.');
    this.name = 'SupportMessageIdConflictError';
  }
}

type IncidentMessageRow = {
  incident_id: string;
  title: string;
  incident_updated_at: string;
  message_id: string | null;
  role: 'user' | 'assistant' | null;
  content: string | null;
  message_created_at: string | null;
};

export function parseIncidentId(value: unknown) {
  return typeof value === 'string' && INCIDENT_ID_PATTERN.test(value)
    ? value
    : null;
}

export function parseMessageId(value: unknown) {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value)
    ? value
    : null;
}

export async function listSupportIncidents(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<SupportIncident[]> {
  const rows = await db
    .prepare(`SELECT i.incident_id, i.title,
      i.updated_at AS incident_updated_at, m.message_id, m.role, m.content,
      m.created_at AS message_created_at
      FROM support_incidents i
      LEFT JOIN support_messages m ON m.incident_id = i.incident_id
      WHERE i.user_id = ?
      ORDER BY i.updated_at DESC, i.incident_id, m.sequence_number`)
    .bind(user.userId)
    .all<IncidentMessageRow>();
  const incidents = new Map<string, SupportIncident>();
  for (const row of rows.results) {
    const incident = incidents.get(row.incident_id) ?? {
      id: row.incident_id,
      title: row.title,
      updatedAt: row.incident_updated_at,
      messages: [],
    };
    if (row.message_id && row.role && row.content && row.message_created_at) {
      incident.messages.push({
        id: row.message_id,
        role: row.role,
        content: row.content,
        createdAt: row.message_created_at,
      });
    }
    incidents.set(row.incident_id, incident);
  }
  return [...incidents.values()];
}

export async function canAccessSupportIncident(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
): Promise<boolean> {
  const incident = await db
    .prepare('SELECT user_id FROM support_incidents WHERE incident_id = ?')
    .bind(incidentId)
    .first<{ user_id: string }>();
  // A new incident can be created; an existing one belongs only to its owner.
  return incident === null || incident.user_id === user.userId;
}

export async function hasSupportMessageIdConflict(
  db: D1Database,
  incidentId: string,
  messageId: string,
): Promise<boolean> {
  // Check both slots before inference. Existing IDs are reusable only for their
  // matching exchange; never expose another incident's metadata or content.
  const assistantId = `AST-${messageId}`;
  const rows = await db
    .prepare(`SELECT message_id, incident_id, role, sequence_number
      FROM support_messages WHERE message_id IN (?, ?)`)
    .bind(messageId, assistantId)
    .all<{
      message_id: string;
      incident_id: string;
      role: 'user' | 'assistant';
      sequence_number: number;
    }>();
  const customer = rows.results.find((row) => row.message_id === messageId);
  const assistant = rows.results.find((row) => row.message_id === assistantId);
  if (
    customer &&
    (customer.incident_id !== incidentId || customer.role !== 'user')
  )
    return true;
  if (customer && !assistant) {
    // Recovery may fill an empty slot, but must not displace a later message.
    const occupied = await db
      .prepare(`SELECT 1 AS found FROM support_messages
        WHERE incident_id = ? AND sequence_number = ?`)
      .bind(incidentId, customer.sequence_number + 1)
      .first<{ found: number }>();
    return occupied !== null;
  }
  return Boolean(
    assistant &&
    (assistant.incident_id !== incidentId ||
      assistant.role !== 'assistant' ||
      !customer ||
      assistant.sequence_number !== customer.sequence_number + 1),
  );
}

type SavedSupportExchange = {
  customerMessage: string;
  assistantMessage: string | null;
  customerCreatedAt: string;
  assistantCreatedAt: string | null;
  incidentUpdatedAt: string;
};

export function supportReply(exchange: SavedSupportExchange): SupportReply {
  if (
    exchange.assistantMessage === null ||
    exchange.assistantCreatedAt === null
  )
    throw new Error('The saved support reply is incomplete.');
  return {
    message: exchange.assistantMessage,
    customerCreatedAt: exchange.customerCreatedAt,
    assistantCreatedAt: exchange.assistantCreatedAt,
    incidentUpdatedAt: exchange.incidentUpdatedAt,
  };
}

export async function getSavedSupportExchange(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
  messageId: string,
): Promise<SavedSupportExchange | null> {
  // Keep the original input so callers can distinguish retries from ID reuse.
  return db
    .prepare(`SELECT customer.content AS customerMessage,
        assistant.content AS assistantMessage,
        customer.created_at AS customerCreatedAt,
        assistant.created_at AS assistantCreatedAt,
        i.updated_at AS incidentUpdatedAt
      FROM support_incidents i
      JOIN support_messages customer ON customer.incident_id = i.incident_id
      LEFT JOIN support_messages assistant ON assistant.incident_id = i.incident_id
        AND assistant.sequence_number = customer.sequence_number + 1
        AND assistant.message_id = ? AND assistant.role = 'assistant'
      WHERE i.user_id = ? AND i.incident_id = ?
        AND customer.message_id = ? AND customer.role = 'user'`)
    .bind(`AST-${messageId}`, user.userId, incidentId, messageId)
    .first<SavedSupportExchange>();
}

export async function saveSupportExchange(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
  messageId: string,
  customerMessage: string,
  assistantMessage: string,
): Promise<SupportReply> {
  const existing = await db
    .prepare(
      'SELECT user_id, title FROM support_incidents WHERE incident_id = ?',
    )
    .bind(incidentId)
    .first<{ user_id: string; title: string }>();
  if (existing && existing.user_id !== user.userId)
    throw new IncidentAccessDeniedError();

  const now = new Date().toISOString();
  // Create the incident and allocate message positions in one transaction.
  // A rejected first exchange must not leave an empty incident behind.
  await db.batch([
    db
      .prepare(`INSERT INTO support_incidents (
        incident_id, user_id, title, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM support_messages WHERE message_id IN (?, ?))
      ON CONFLICT(incident_id) DO NOTHING`)
      .bind(
        incidentId,
        user.userId,
        createIncidentTitle(customerMessage),
        now,
        now,
        messageId,
        `AST-${messageId}`,
      ),
    // Check the reply ID inside the transaction too: another request may have
    // claimed it as a customer ID after preflight. Do not leave half an exchange.
    db
      .prepare(`INSERT OR IGNORE INTO support_messages (
        message_id, incident_id, sequence_number, role, content, created_at
      ) SELECT ?, ?, COALESCE(MAX(sequence_number), 0) + 1, 'user', ?, ?
        FROM support_messages WHERE incident_id = ?
        HAVING NOT EXISTS (SELECT 1 FROM support_messages WHERE message_id = ?)
          AND EXISTS (SELECT 1 FROM support_incidents WHERE incident_id = ? AND user_id = ?)`)
      .bind(
        messageId,
        incidentId,
        customerMessage,
        now,
        incidentId,
        `AST-${messageId}`,
        incidentId,
        user.userId,
      ),
    // Anchor replies to the persisted customer message, including on retries
    // that recover a missing reply earlier in the conversation.
    db
      .prepare(`INSERT OR IGNORE INTO support_messages (
        message_id, incident_id, sequence_number, role, content, created_at
      ) SELECT ?, incident_id, sequence_number + 1, 'assistant', ?, ?
        FROM support_messages
        WHERE message_id = ? AND incident_id = ? AND role = 'user' AND content = ?
          AND EXISTS (SELECT 1 FROM support_incidents WHERE incident_id = ? AND user_id = ?)`)
      .bind(
        `AST-${messageId}`,
        assistantMessage,
        now,
        messageId,
        incidentId,
        customerMessage,
        incidentId,
        user.userId,
      ),
    db
      .prepare(`UPDATE support_incidents
        SET title = CASE WHEN title = 'New service incident' THEN ? ELSE title END,
          updated_at = ?
        WHERE incident_id = ? AND user_id = ?
          AND EXISTS (SELECT 1 FROM support_messages
            WHERE message_id = ? AND incident_id = support_incidents.incident_id
              AND role = 'user' AND content = ?)`)
      .bind(
        createIncidentTitle(customerMessage),
        now,
        incidentId,
        user.userId,
        messageId,
        customerMessage,
      ),
  ]);

  // A concurrent request may have claimed this incident after the initial read.
  // The transactional write guards above leave the other owner's data untouched.
  if (!(await canAccessSupportIncident(db, user, incidentId)))
    throw new IncidentAccessDeniedError();

  // A concurrent retry may have saved its reply first. Return the persisted
  // winner, never a generated response whose insert was ignored.
  const saved = await getSavedSupportExchange(db, user, incidentId, messageId);
  if (saved && saved.customerMessage !== customerMessage)
    throw new SupportMessageTextConflictError();
  if (!saved || saved.assistantMessage === null) {
    if (await hasSupportMessageIdConflict(db, incidentId, messageId))
      throw new SupportMessageIdConflictError();
    throw new Error(
      'The support exchange was not saved as a complete matching pair.',
    );
  }
  return supportReply(saved);
}

export async function deleteSupportIncident(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
) {
  await db
    .prepare(
      'DELETE FROM support_incidents WHERE incident_id = ? AND user_id = ?',
    )
    .bind(incidentId, user.userId)
    .run();
}
