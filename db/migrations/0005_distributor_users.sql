CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  distributor_id TEXT NOT NULL REFERENCES distributors(customer_id),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('account_admin', 'buyer', 'support')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_on TEXT NOT NULL,
  last_login_at TEXT
) STRICT;

INSERT OR IGNORE INTO users VALUES
  ('USR-CPD-001', 'WHS-0427', 'Mara Venn', 'mara.venn@calderpike.example', 'account_admin', 'active', '2021-01-04', '2026-09-02T08:42:00Z'),
  ('USR-MCS-001', 'WHS-1098', 'Imani Kade', 'imani.kade@meridiancivic.example', 'account_admin', 'active', '2021-02-15', '2026-08-29T13:05:00Z'),
  ('USR-NPC-001', 'WHS-2714', 'Rowan Sato', 'rowan.sato@northline.example', 'account_admin', 'active', '2021-03-08', '2026-08-31T16:20:00Z'),
  ('USR-HIX-001', 'WHS-5830', 'Lena Orr', 'lena.orr@halcyonexchange.example', 'account_admin', 'active', '2021-04-19', '2026-08-27T10:15:00Z');

ALTER TABLE orders ADD COLUMN placed_by_user_id TEXT REFERENCES users(user_id);

UPDATE orders SET placed_by_user_id = CASE customer_id
  WHEN 'WHS-0427' THEN 'USR-CPD-001'
  WHEN 'WHS-1098' THEN 'USR-MCS-001'
  WHEN 'WHS-2714' THEN 'USR-NPC-001'
  WHEN 'WHS-5830' THEN 'USR-HIX-001'
END;

CREATE INDEX IF NOT EXISTS idx_orders_placed_by_user
  ON orders(placed_by_user_id);

CREATE TRIGGER IF NOT EXISTS orders_validate_user_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN NEW.placed_by_user_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM users
  WHERE user_id = NEW.placed_by_user_id
    AND distributor_id = NEW.customer_id
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'order user must be active and belong to distributor');
END;

CREATE TRIGGER IF NOT EXISTS orders_validate_user_update
BEFORE UPDATE OF placed_by_user_id, customer_id ON orders
FOR EACH ROW
WHEN NEW.placed_by_user_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM users
  WHERE user_id = NEW.placed_by_user_id
    AND distributor_id = NEW.customer_id
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'order user must be active and belong to distributor');
END;
