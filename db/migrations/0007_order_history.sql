CREATE INDEX IF NOT EXISTS idx_orders_customer_created
  ON orders(customer_id, created_on DESC, order_id DESC);
