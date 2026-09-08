import type { AuthenticatedUser } from './auth';
import {
  createIncidentTitle,
  type SupportIncident,
} from '../lib/support-incidents.ts';

const INCIDENT_ID_PATTERN = /^INC-[A-Za-z0-9-]{6,100}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9-]{6,120}$/;

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

function messageTime(value: string) {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function incidentTime(value: string) {
  if (value.slice(0, 10) === new Date().toISOString().slice(0, 10)) return 'Today';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
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
      updatedAt: incidentTime(row.incident_updated_at),
      messages: [],
    };
    if (row.message_id && row.role && row.content && row.message_created_at) {
      incident.messages.push({
        id: row.message_id,
        role: row.role,
        content: row.content,
        createdAt: messageTime(row.message_created_at),
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
};

export async function getSavedSupportExchange(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
  messageId: string,
): Promise<SavedSupportExchange | null> {
  // Keep the original input so callers can distinguish retries from ID reuse.
  return db
    .prepare(`SELECT customer.content AS customerMessage,
        assistant.content AS assistantMessage
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
) {
  const existing = await db
    .prepare('SELECT user_id, title FROM support_incidents WHERE incident_id = ?')
    .bind(incidentId)
    .first<{ user_id: string; title: string }>();
  if (existing && existing.user_id !== user.userId)
    throw new Error('Incident authorization scope mismatch.');

  const now = new Date().toISOString();
  if (!existing) {
    await db
      .prepare(`INSERT INTO support_incidents (
        incident_id, user_id, title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`)
      .bind(
        incidentId,
        user.userId,
        createIncidentTitle(customerMessage),
        now,
        now,
      )
      .run();
  }

  const sequence = await db
    .prepare(`SELECT COALESCE(MAX(sequence_number), 0) AS last_sequence,
      MAX(CASE WHEN message_id = ? AND role = 'user' AND content = ?
        THEN sequence_number END) AS saved_sequence
      FROM support_messages WHERE incident_id = ?`)
    .bind(messageId, customerMessage, incidentId)
    .first<{ last_sequence: number; saved_sequence: number | null }>();
  // Recover a missing reply immediately after its original customer message.
  const userSequence =
    sequence?.saved_sequence ?? Number(sequence?.last_sequence ?? 0) + 1;
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO support_messages (
        message_id, incident_id, sequence_number, role, content, created_at
      ) VALUES (?, ?, ?, 'user', ?, ?)`)
      .bind(messageId, incidentId, userSequence, customerMessage, now),
    db
      .prepare(`INSERT OR IGNORE INTO support_messages (
        message_id, incident_id, sequence_number, role, content, created_at
      ) VALUES (?, ?, ?, 'assistant', ?, ?)`)
      .bind(
        `AST-${messageId}`,
        incidentId,
        userSequence + 1,
        assistantMessage,
        now,
      ),
    db
      .prepare(`UPDATE support_incidents
        SET title = CASE WHEN title = 'New service incident' THEN ? ELSE title END,
          updated_at = ?
        WHERE incident_id = ? AND user_id = ?`)
      .bind(createIncidentTitle(customerMessage), now, incidentId, user.userId),
  ]);
}

export async function deleteSupportIncident(
  db: D1Database,
  user: AuthenticatedUser,
  incidentId: string,
) {
  await db
    .prepare('DELETE FROM support_incidents WHERE incident_id = ? AND user_id = ?')
    .bind(incidentId, user.userId)
    .run();
}
