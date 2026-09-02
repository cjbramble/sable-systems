CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  password_updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
  ON sessions(user_id, expires_at);

INSERT OR REPLACE INTO user_credentials VALUES
  ('USR-CPD-001', '1lIuQK9XkwWkY0c0AE4ZXg', 'RSZ-1tPotPr5bdAasAm06V-Qa4mC_m5Lj5khmqATtdE', 210000, '2026-09-02T10:30:00Z'),
  ('USR-MCS-001', 'Wt9n8uox9Upi6cBE_ye-6g', 'UrIMz0NH1Hhy8E5yDuElml5XW3z8E_KKnbvQmtG3AsM', 210000, '2026-09-02T10:30:00Z'),
  ('USR-NPC-001', 'g8JLxlQzzW2g424PDxucig', 'kQ99m_A5Z6uyu145H3Kq50iDLIaVskUN5KovMkapyZY', 210000, '2026-09-02T10:30:00Z'),
  ('USR-HIX-001', 'gd8bi2Giq_dEaikXJ3kGaA', 'Yehzp-jylkN6Zz74bgfGGr9on7GoyCeqV5ht6mVHilA', 210000, '2026-09-02T10:30:00Z');
