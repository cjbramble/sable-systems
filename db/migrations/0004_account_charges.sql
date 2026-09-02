CREATE TABLE account_charges (
  charge_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  charge_method TEXT NOT NULL CHECK (charge_method = 'charge_account'),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'declined', 'voided')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  authorization_code TEXT NOT NULL UNIQUE,
  authorized_at TEXT NOT NULL
) STRICT;

INSERT INTO account_charges (
  charge_id, order_id, charge_method, status, amount_cents, currency,
  authorization_code, authorized_at
)
SELECT payment_id, order_id, 'charge_account', status, amount_cents, currency,
  authorization_code, authorized_at
FROM simulated_payments;

DROP INDEX idx_payments_order;
DROP TABLE simulated_payments;

CREATE INDEX idx_account_charges_order
ON account_charges(order_id);
