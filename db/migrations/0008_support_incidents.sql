CREATE TABLE IF NOT EXISTS support_incidents (
  incident_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS support_messages (
  message_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES support_incidents(incident_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL,
  UNIQUE (incident_id, sequence_number)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_support_incidents_user_updated
  ON support_incidents(user_id, updated_at DESC);
