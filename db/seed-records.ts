// Named fields are the seed-data contract; SQL column order is explicit at serialization.
type SeedTables = {
  metadata: {
    key: string;
    value: string;
  };
  distributors: {
    customer_id: string;
    legal_name: string;
    display_name: string;
    account_tier: string;
    account_status: string;
    payment_terms: string;
    currency: string;
    region: string;
  };
  users: {
    user_id: string;
    distributor_id: string;
    display_name: string;
    email: string;
    role: string;
    status: string;
    created_on: string;
    last_login_at: string | null;
  };
  user_credentials: {
    user_id: string;
    password_salt: string;
    password_hash: string;
    password_iterations: number;
    password_updated_at: string;
  };
  products: {
    item_number: string;
    product_name: string;
    category: string;
    fulfillment_type: string;
    unit_price_cents: number;
    unit_label: string;
    case_pack: number;
    lead_time_days: number;
    warranty_months: number;
    active_from: string;
    active_to: string | null;
    search_terms: string;
  };
  fulfillment_locations: {
    location_id: string;
    location_name: string;
    service_region: string;
  };
  inventory_balances: {
    item_number: string;
    location_id: string;
    on_hand_quantity: number;
    reserved_quantity: number;
    quarantined_quantity: number;
    inbound_quantity: number;
    expected_restock_date: string | null;
    updated_at: string;
  };
  orders: {
    order_id: string;
    customer_id: string;
    placed_by_user_id: string;
    customer_po_number: string;
    created_on: string;
    requested_ship_date: string;
    status: string;
    currency: string;
    order_total_cents: number;
    shipping_region: string;
  };
  order_items: {
    order_id: string;
    line_number: number;
    item_number: string;
    product_name_snapshot: string;
    unit_price_cents: number;
    ordered_quantity: number;
    allocated_quantity: number;
    shipped_quantity: number;
    cancelled_quantity: number;
  };
  order_events: {
    event_id: string;
    order_id: string;
    occurred_at: string;
    event_type: string;
    customer_safe_description: string;
  };
  shipments: {
    shipment_id: string;
    order_id: string;
    status: string;
    carrier_name: string;
    tracking_reference: string;
    shipped_on: string | null;
    estimated_delivery_date: string | null;
    delivered_on: string | null;
  };
  shipment_items: {
    shipment_id: string;
    order_id: string;
    line_number: number;
    shipped_quantity: number;
  };
  returns: {
    return_id: string;
    order_id: string;
    status: string;
    reason_code: string;
    requested_on: string;
    authorized_on: string | null;
    received_on: string | null;
  };
  return_items: {
    return_id: string;
    order_id: string;
    line_number: number;
    return_quantity: number;
    disposition: string;
  };
};

export type SeedRecord = {
  [Table in keyof SeedTables]: { table: Table; values: SeedTables[Table] };
}[keyof SeedTables];

export type SeedStatement = {
  sql: string;
  params: Array<string | number | null>;
};

export function serializeSeedRecord(record: SeedRecord): SeedStatement {
  const columns = Object.keys(record.values);
  return {
    sql: `INSERT INTO ${record.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: Object.values(record.values),
  };
}
