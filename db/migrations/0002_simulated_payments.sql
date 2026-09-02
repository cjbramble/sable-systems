CREATE TABLE simulated_payments (
  payment_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  payment_method TEXT NOT NULL CHECK (payment_method = 'simulated_account_ledger'),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'declined', 'voided')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  authorization_code TEXT NOT NULL UNIQUE,
  authorized_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_payments_order
ON simulated_payments(order_id);
