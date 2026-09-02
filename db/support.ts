import { AS_OF_DATE, PRIMARY_CUSTOMER_ID } from './seed';

type AccountSummary = {
  customerId: string;
  displayName: string;
  accountTier: string;
  totalOrders: number;
  activeOrders: number;
  scheduledOrders: number;
  inventoryAlerts: number;
  asOfDate: string;
};

type ProductRow = {
  item_number: string;
  product_name: string;
  category: string;
  fulfillment_type: string;
  unit_price_cents: number;
  unit_label: string;
  case_pack: number;
  lead_time_days: number;
  active_to: string | null;
  search_terms: string;
};

export async function getAccountSummary(
  db: D1Database,
): Promise<AccountSummary> {
  const account = await db
    .prepare(
      'SELECT display_name, account_tier FROM distributors WHERE customer_id = ?',
    )
    .bind(PRIMARY_CUSTOMER_ID)
    .first<{ display_name: string; account_tier: string }>();
  if (!account) throw new Error('The authorized wholesale account is missing.');

  const orderCounts = await db
    .prepare(`SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status NOT IN ('delivered', 'cancelled', 'scheduled') THEN 1 ELSE 0 END) AS active_orders,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_orders
      FROM orders WHERE customer_id = ?`)
    .bind(PRIMARY_CUSTOMER_ID)
    .first<{
      total_orders: number;
      active_orders: number;
      scheduled_orders: number;
    }>();
  const alerts = await db
    .prepare(`SELECT COUNT(*) AS alert_count FROM (
      SELECT p.item_number
      FROM products p
      JOIN inventory_balances i ON i.item_number = p.item_number
      WHERE p.fulfillment_type = 'physical' AND p.active_to IS NULL
      GROUP BY p.item_number
      HAVING SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity) <= p.case_pack * 8
    )`)
    .first<{ alert_count: number }>();

  return {
    customerId: PRIMARY_CUSTOMER_ID,
    displayName: account.display_name,
    accountTier: account.account_tier,
    totalOrders: Number(orderCounts?.total_orders ?? 0),
    activeOrders: Number(orderCounts?.active_orders ?? 0),
    scheduledOrders: Number(orderCounts?.scheduled_orders ?? 0),
    inventoryAlerts: Number(alerts?.alert_count ?? 0),
    asOfDate: AS_OF_DATE,
  };
}

export async function buildAuthorizedContext(db: D1Database, message: string) {
  const normalized = message.toLowerCase();
  const orderIdentifier =
    message.toUpperCase().match(/\bSBL-\d{4}-\d{6}\b/)?.[0] ??
    message.toUpperCase().match(/\bCPD-(?:PO|REL)-\d{6}\b/)?.[0];

  if (orderIdentifier) return orderContext(db, orderIdentifier);
  if (/scheduled|future|upcoming|release/.test(normalized))
    return scheduledOrderContext(db);

  const matchedProduct = await matchProduct(db, normalized);
  if (matchedProduct) return productContext(db, matchedProduct);
  if (/inventory|availability|available|stock|backorder/.test(normalized))
    return inventoryAlertContext(db);

  const summary = await getAccountSummary(db);
  return `<authorized_records>
Account: ${summary.displayName} (${summary.customerId}), ${summary.accountTier}
As-of date: ${summary.asOfDate}
Authorized order count: ${summary.totalOrders}; active: ${summary.activeOrders}; scheduled: ${summary.scheduledOrders}.
No specific order or item was identified in the request. Ask for a SABLE order ID, Calder Pike PO number, or item number when account-specific facts are required.
</authorized_records>`;
}

async function orderContext(db: D1Database, identifier: string) {
  const order = await db
    .prepare(`SELECT order_id, customer_po_number, created_on, requested_ship_date, status,
      currency, order_total_cents, shipping_region
      FROM orders
      WHERE customer_id = ? AND (order_id = ? OR customer_po_number = ?)`)
    .bind(PRIMARY_CUSTOMER_ID, identifier, identifier)
    .first<Record<string, string | number>>();

  if (!order) {
    return `<authorized_records>
No order matching ${identifier} is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`;
  }

  const items = await db
    .prepare(`SELECT line_number, item_number, product_name_snapshot, unit_price_cents,
      ordered_quantity, allocated_quantity, shipped_quantity, cancelled_quantity
      FROM order_items WHERE order_id = ? ORDER BY line_number`)
    .bind(order.order_id)
    .all<Record<string, string | number>>();
  const shipments = await db
    .prepare(`SELECT shipment_id, status, carrier_name, tracking_reference, shipped_on,
      estimated_delivery_date, delivered_on
      FROM shipments WHERE order_id = ? ORDER BY shipment_id`)
    .bind(order.order_id)
    .all<Record<string, string | number | null>>();
  const events = await db
    .prepare(`SELECT occurred_at, event_type, customer_safe_description
      FROM order_events WHERE order_id = ? ORDER BY occurred_at DESC LIMIT 4`)
    .bind(order.order_id)
    .all<Record<string, string>>();
  const returnRow = await db
    .prepare(`SELECT return_id, status, reason_code, requested_on, authorized_on, received_on
      FROM returns WHERE order_id = ? ORDER BY requested_on DESC LIMIT 1`)
    .bind(order.order_id)
    .first<Record<string, string | null>>();

  return `<authorized_records>
Authorization: Calder Pike Distribution (${PRIMARY_CUSTOMER_ID}) only.
Order: ${order.order_id}; customer PO: ${order.customer_po_number}; status: ${order.status}.
Created: ${order.created_on}; requested ship date: ${order.requested_ship_date}; destination: ${order.shipping_region}.
Order total: ${money(Number(order.order_total_cents), String(order.currency))}.
Lines:
${items.results.map((item) => `- ${item.item_number} ${item.product_name_snapshot}: ordered ${item.ordered_quantity}, allocated ${item.allocated_quantity}, shipped ${item.shipped_quantity}, cancelled ${item.cancelled_quantity}; price ${money(Number(item.unit_price_cents), String(order.currency))} per unit.`).join('\n')}
Shipments:
${shipments.results.length ? shipments.results.map((shipment) => `- ${shipment.shipment_id}: ${shipment.status}; ${shipment.carrier_name}; tracking ${shipment.tracking_reference}; shipped ${shipment.shipped_on ?? 'not yet'}; estimated delivery ${shipment.estimated_delivery_date ?? 'not assigned'}; delivered ${shipment.delivered_on ?? 'not yet'}.`).join('\n') : '- No shipment record yet.'}
Recent customer-safe events:
${events.results.map((event) => `- ${event.occurred_at}: ${event.customer_safe_description}`).join('\n')}
Return: ${returnRow ? `${returnRow.return_id}, ${returnRow.status}, reason ${returnRow.reason_code}, requested ${returnRow.requested_on}.` : 'No return recorded.'}
</authorized_records>`;
}

async function scheduledOrderContext(db: D1Database) {
  const rows = await db
    .prepare(`SELECT order_id, customer_po_number, requested_ship_date, status, order_total_cents, currency
      FROM orders
      WHERE customer_id = ? AND requested_ship_date > ? AND status IN ('scheduled', 'confirmed')
      ORDER BY requested_ship_date LIMIT 8`)
    .bind(PRIMARY_CUSTOMER_ID, AS_OF_DATE)
    .all<Record<string, string | number>>();
  return `<authorized_records>
Upcoming Calder Pike releases after ${AS_OF_DATE}:
${rows.results.map((row) => `- ${row.order_id} / ${row.customer_po_number}: ${row.status}; requested ${row.requested_ship_date}; ${money(Number(row.order_total_cents), String(row.currency))}.`).join('\n')}
</authorized_records>`;
}

async function matchProduct(db: D1Database, message: string) {
  const rows = await db
    .prepare('SELECT * FROM products ORDER BY product_name')
    .all<ProductRow>();
  return rows.results.find((product) => {
    const terms = [
      product.item_number.toLowerCase(),
      product.product_name.toLowerCase(),
      ...product.search_terms.split(','),
    ];
    return terms.some(
      (term) => term.length >= 4 && message.includes(term.trim()),
    );
  });
}

async function productContext(db: D1Database, product: ProductRow) {
  if (product.fulfillment_type === 'license') {
    return `<authorized_records>
Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
Wholesale price: ${money(product.unit_price_cents, 'USD')} per ${product.unit_label}; minimum block ${product.case_pack}.
This is a digitally allocated license and does not have a physical stock balance.
</authorized_records>`;
  }
  const inventory = await db
    .prepare(`SELECT
      SUM(on_hand_quantity) AS on_hand,
      SUM(reserved_quantity) AS reserved,
      SUM(quarantined_quantity) AS quarantined,
      SUM(inbound_quantity) AS inbound,
      MIN(expected_restock_date) AS expected_restock_date,
      MAX(updated_at) AS updated_at
      FROM inventory_balances WHERE item_number = ?`)
    .bind(product.item_number)
    .first<Record<string, number | string | null>>();
  const available =
    Number(inventory?.on_hand ?? 0) -
    Number(inventory?.reserved ?? 0) -
    Number(inventory?.quarantined ?? 0);
  return `<authorized_records>
Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
Wholesale price: ${money(product.unit_price_cents, 'USD')} per ${product.unit_label}; case pack ${product.case_pack}; standard lead time ${product.lead_time_days} days.
Available to promise as of ${AS_OF_DATE}: ${available}. Inbound: ${inventory?.inbound ?? 0}. Expected restock: ${inventory?.expected_restock_date ?? 'none scheduled'}.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`;
}

async function inventoryAlertContext(db: D1Database) {
  const rows = await db
    .prepare(`SELECT p.item_number, p.product_name, p.case_pack,
      SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity) AS available,
      SUM(i.inbound_quantity) AS inbound,
      MIN(i.expected_restock_date) AS restock
      FROM products p JOIN inventory_balances i ON i.item_number = p.item_number
      WHERE p.active_to IS NULL
      GROUP BY p.item_number, p.product_name, p.case_pack
      HAVING available <= p.case_pack * 8
      ORDER BY available, p.item_number LIMIT 6`)
    .all<Record<string, string | number | null>>();
  return `<authorized_records>
Current SABLE physical inventory advisories as of ${AS_OF_DATE}:
${rows.results.map((row) => `- ${row.item_number} ${row.product_name}: ${row.available} available; ${row.inbound} inbound; restock ${row.restock ?? 'not scheduled'}.`).join('\n')}
Ask which item the customer wants if a specific availability decision is required.
</authorized_records>`;
}

function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    cents / 100,
  );
}
