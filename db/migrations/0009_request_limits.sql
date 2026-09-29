CREATE TABLE IF NOT EXISTS request_limits (
  quota_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at INTEGER NOT NULL
) STRICT;
