export const SCHEMA_VERSION = '6';
export const SEED_VERSION = 'sable-distribution-2026-09-02-v7';

export const USERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  distributor_id TEXT NOT NULL REFERENCES distributors(customer_id),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('account_admin', 'buyer', 'support')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_on TEXT NOT NULL,
  last_login_at TEXT
) STRICT`;

export const USER_CREDENTIALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  password_updated_at TEXT NOT NULL
) STRICT`;

export const SESSIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
) STRICT`;

export const SESSIONS_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
  ON sessions(user_id, expires_at)`;

export const ORDER_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_orders_placed_by_user
  ON orders(placed_by_user_id)`;

export const ORDER_HISTORY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_orders_customer_created
  ON orders(customer_id, created_on DESC, order_id DESC)`;

export const ORDER_USER_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS orders_validate_user_insert
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
  END`;

export const ORDER_USER_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS orders_validate_user_update
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
  END`;

export const ACCOUNT_CHARGES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS account_charges (
  charge_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  charge_method TEXT NOT NULL CHECK (charge_method = 'charge_account'),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'declined', 'voided')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  authorization_code TEXT NOT NULL UNIQUE,
  authorized_at TEXT NOT NULL
) STRICT`;

export const ACCOUNT_CHARGES_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_account_charges_order
  ON account_charges(order_id)`;

export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS distributors (
    customer_id TEXT PRIMARY KEY,
    legal_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    account_tier TEXT NOT NULL,
    account_status TEXT NOT NULL CHECK (account_status IN ('active', 'suspended', 'closed')),
    payment_terms TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    region TEXT NOT NULL
  ) STRICT`,
  USERS_TABLE_SQL,
  USER_CREDENTIALS_TABLE_SQL,
  SESSIONS_TABLE_SQL,
  `CREATE TABLE IF NOT EXISTS products (
    item_number TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    category TEXT NOT NULL,
    fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('physical', 'license')),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    unit_label TEXT NOT NULL,
    case_pack INTEGER NOT NULL CHECK (case_pack > 0),
    lead_time_days INTEGER NOT NULL CHECK (lead_time_days >= 0),
    warranty_months INTEGER NOT NULL CHECK (warranty_months >= 0),
    active_from TEXT NOT NULL,
    active_to TEXT,
    search_terms TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS fulfillment_locations (
    location_id TEXT PRIMARY KEY,
    location_name TEXT NOT NULL,
    service_region TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS inventory_balances (
    item_number TEXT NOT NULL REFERENCES products(item_number),
    location_id TEXT NOT NULL REFERENCES fulfillment_locations(location_id),
    on_hand_quantity INTEGER NOT NULL CHECK (on_hand_quantity >= 0),
    reserved_quantity INTEGER NOT NULL CHECK (reserved_quantity >= 0),
    quarantined_quantity INTEGER NOT NULL CHECK (quarantined_quantity >= 0),
    inbound_quantity INTEGER NOT NULL CHECK (inbound_quantity >= 0),
    expected_restock_date TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_number, location_id),
    CHECK (reserved_quantity + quarantined_quantity <= on_hand_quantity)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES distributors(customer_id),
    placed_by_user_id TEXT NOT NULL REFERENCES users(user_id),
    customer_po_number TEXT NOT NULL,
    created_on TEXT NOT NULL,
    requested_ship_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'scheduled', 'confirmed', 'allocating', 'backordered', 'partially_shipped',
      'shipped', 'delivered', 'on_hold', 'cancelled'
    )),
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    order_total_cents INTEGER NOT NULL CHECK (order_total_cents >= 0),
    shipping_region TEXT NOT NULL,
    UNIQUE (customer_id, customer_po_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    item_number TEXT NOT NULL REFERENCES products(item_number),
    product_name_snapshot TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
    allocated_quantity INTEGER NOT NULL CHECK (allocated_quantity >= 0),
    shipped_quantity INTEGER NOT NULL CHECK (shipped_quantity >= 0),
    cancelled_quantity INTEGER NOT NULL CHECK (cancelled_quantity >= 0),
    PRIMARY KEY (order_id, line_number),
    CHECK (allocated_quantity <= ordered_quantity),
    CHECK (shipped_quantity + cancelled_quantity <= ordered_quantity)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS order_events (
    event_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    customer_safe_description TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS shipments (
    shipment_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'in_transit', 'delayed', 'delivered', 'returned')),
    carrier_name TEXT NOT NULL,
    tracking_reference TEXT NOT NULL UNIQUE,
    shipped_on TEXT,
    estimated_delivery_date TEXT,
    delivered_on TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS shipment_items (
    shipment_id TEXT NOT NULL REFERENCES shipments(shipment_id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    shipped_quantity INTEGER NOT NULL CHECK (shipped_quantity > 0),
    PRIMARY KEY (shipment_id, order_id, line_number),
    FOREIGN KEY (order_id, line_number) REFERENCES order_items(order_id, line_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS returns (
    return_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(order_id),
    status TEXT NOT NULL CHECK (status IN ('requested', 'authorized', 'denied', 'in_transit', 'received', 'credited', 'closed')),
    reason_code TEXT NOT NULL,
    requested_on TEXT NOT NULL,
    authorized_on TEXT,
    received_on TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS return_items (
    return_id TEXT NOT NULL REFERENCES returns(return_id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    return_quantity INTEGER NOT NULL CHECK (return_quantity > 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('restock', 'repair', 'quarantine', 'scrap')),
    PRIMARY KEY (return_id, order_id, line_number),
    FOREIGN KEY (order_id, line_number) REFERENCES order_items(order_id, line_number)
  ) STRICT`,
  ACCOUNT_CHARGES_TABLE_SQL,
  ORDER_USER_INSERT_TRIGGER_SQL,
  ORDER_USER_UPDATE_TRIGGER_SQL,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer_ship_date
    ON orders(customer_id, requested_ship_date)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer_open
    ON orders(customer_id, status)
    WHERE status NOT IN ('delivered', 'cancelled')`,
  ORDER_HISTORY_INDEX_SQL,
  ORDER_USER_INDEX_SQL,
  SESSIONS_USER_INDEX_SQL,
  `CREATE INDEX IF NOT EXISTS idx_order_items_item_number
    ON order_items(item_number)`,
  `CREATE INDEX IF NOT EXISTS idx_order_events_order_time
    ON order_events(order_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shipments_order
    ON shipments(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_item
    ON inventory_balances(item_number)`,
  ACCOUNT_CHARGES_INDEX_SQL,
] as const;

export const seedCleanupStatements = [
  'DELETE FROM sessions',
  'DELETE FROM account_charges',
  'DELETE FROM return_items',
  'DELETE FROM returns',
  'DELETE FROM shipment_items',
  'DELETE FROM shipments',
  'DELETE FROM order_events',
  'DELETE FROM order_items',
  'DELETE FROM orders',
  'DELETE FROM inventory_balances',
  'DELETE FROM fulfillment_locations',
  'DELETE FROM products',
  'DELETE FROM user_credentials',
  'DELETE FROM users',
  'DELETE FROM distributors',
  'DELETE FROM metadata',
] as const;
