import type { AuthenticatedUser } from './auth';
import { listSupportIncidents } from './incidents';
import { AS_OF_DATE } from './seed';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import type { AccountSummary } from '@/lib/contracts';
import { formatCurrency } from '@/lib/format';
import { itemReferences } from '@/lib/support-references';
import {
  classifySupportQuery,
  type SupportOrderStatus,
} from '@/lib/support-query';

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
  user: AuthenticatedUser,
): Promise<AccountSummary> {
  const orderCounts = await db
    .prepare(`SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status NOT IN ('delivered', 'cancelled', 'scheduled') THEN 1 ELSE 0 END) AS active_orders,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_orders
      FROM orders WHERE customer_id = ?`)
    .bind(user.distributorId)
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
    customerId: user.distributorId,
    displayName: user.distributorDisplayName,
    accountTier: user.accountTier,
    userId: user.userId,
    userDisplayName: user.userDisplayName,
    userRole: user.role,
    paymentTerms: user.paymentTerms,
    currency: user.currency,
    region: user.region,
    totalOrders: Number(orderCounts?.total_orders ?? 0),
    activeOrders: Number(orderCounts?.active_orders ?? 0),
    scheduledOrders: Number(orderCounts?.scheduled_orders ?? 0),
    inventoryAlerts: Number(alerts?.alert_count ?? 0),
    asOfDate: AS_OF_DATE,
  };
}

export async function buildAuthorizedContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
) {
  const intent = classifySupportQuery(messages);
  const products =
    'message' in intent ? await matchProducts(db, intent.message) : [];
  if (
    intent.kind === 'catalog' ||
    intent.kind === 'orders' ||
    intent.kind === 'summary'
  ) {
    const references = itemReferences(intent.message);
    if (references.length) {
      const unknown = references.filter(
        (reference) =>
          !products.some((product) => product.item_number === reference),
      );
      if (unknown.length)
        return `<authorized_records>
No catalog item matching ${unknown.join(', ')} was found. Ask the customer to verify the complete item number. Do not substitute a similarly numbered product or infer its stock or price.
</authorized_records>`;
    }
  }
  switch (intent.kind) {
    case 'order':
      return orderContext(db, intent.identifier, user);
    case 'shipment':
      return shipmentContext(db, intent.identifier, user);
    case 'return':
      return returnContext(db, intent.identifier, user);
    case 'orders': {
      return orderSearchContext(
        db,
        user,
        intent.status,
        intent.year,
        intent.yearField,
        products[0],
      );
    }
    case 'incidents':
      return incidentHistoryContext(db, user);
    case 'account':
      return accountContext(db, user, intent.includeCharges);
    case 'catalog': {
      if (products.length > 0 && (!intent.category || products.length <= 3)) {
        const selected = intent.compare
          ? products.slice(0, 3)
          : products.slice(0, 1);
        return productComparisonContext(
          db,
          selected,
          intent.quantity,
          intent.includeLocations,
        );
      }
      if (intent.category) return categoryInventoryContext(db, intent.category);
      return inventoryAlertContext(db);
    }
    case 'summary': {
      if (products.length > 0)
        return productComparisonContext(db, products.slice(0, 1));
      return summaryContext(db, user);
    }
  }
}

async function incidentHistoryContext(db: D1Database, user: AuthenticatedUser) {
  const incidents = (await listSupportIncidents(db, user)).slice(0, 8);
  return `<authorized_records>
Support incidents for authenticated user ${user.userDisplayName} (${user.userId}); showing up to 8 most recent.
${incidents.map((incident) => `- ${incident.id}: ${incident.title}; updated ${incident.updatedAt}; ${incident.messages.length} messages.`).join('\n') || '- No support incidents recorded.'}
Do not reveal incidents belonging to other users or distributors.
</authorized_records>`;
}

async function summaryContext(db: D1Database, user: AuthenticatedUser) {
  const summary = await getAccountSummary(db, user);
  return `<authorized_records>
Account: ${summary.displayName} (${summary.customerId}), ${summary.accountTier}
Authenticated user: ${summary.userDisplayName} (${summary.userId}), role ${summary.userRole}.
As-of date: ${summary.asOfDate}
Authorized order count: ${summary.totalOrders}; active: ${summary.activeOrders}; scheduled: ${summary.scheduledOrders}.
No specific order or item was identified in the request. Ask for a SABLE order ID, account PO number, or item number when account-specific facts are required.
</authorized_records>`;
}

async function orderContext(
  db: D1Database,
  identifier: string,
  user: AuthenticatedUser,
) {
  const order = await db
    .prepare(`SELECT o.order_id, o.customer_po_number, o.created_on,
      o.requested_ship_date, o.status, o.currency, o.order_total_cents,
      o.shipping_region, o.placed_by_user_id, u.display_name AS placed_by_name
      FROM orders o
      JOIN users u ON u.user_id = o.placed_by_user_id
      WHERE o.customer_id = ? AND (o.order_id = ? OR o.customer_po_number = ?)`)
    .bind(user.distributorId, identifier, identifier)
    .first<Record<string, string | number>>();

  if (!order) {
    return `<authorized_records>
No order matching ${identifier} is available within ${user.distributorDisplayName}'s authorization scope. Do not confirm or deny whether it belongs to another customer.
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
  const charge = await db
    .prepare(`SELECT status, amount_cents, currency, authorization_code,
      authorized_at FROM account_charges WHERE order_id = ?`)
    .bind(order.order_id)
    .first<Record<string, string | number>>();

  return `<authorized_records>
Authorization: ${user.distributorDisplayName} (${user.distributorId}) only.
Order: ${order.order_id}; customer PO: ${order.customer_po_number}; status: ${order.status}.
Placed by: ${order.placed_by_name} (${order.placed_by_user_id}).
Created: ${order.created_on}; requested ship date: ${order.requested_ship_date}; destination: ${order.shipping_region}.
Order total: ${formatCurrency(Number(order.order_total_cents), String(order.currency))}.
Lines:
${items.results.map((item) => `- ${item.item_number} ${item.product_name_snapshot}: ordered ${item.ordered_quantity}, allocated ${item.allocated_quantity}, shipped ${item.shipped_quantity}, cancelled ${item.cancelled_quantity}; price ${formatCurrency(Number(item.unit_price_cents), String(order.currency))} per unit.`).join('\n')}
Shipments:
${shipments.results.length ? shipments.results.map((shipment) => `- ${shipment.shipment_id}: ${shipment.status}; ${shipment.carrier_name}; tracking ${shipment.tracking_reference}; shipped ${shipment.shipped_on ?? 'not yet'}; estimated delivery ${shipment.estimated_delivery_date ?? 'not assigned'}; delivered ${shipment.delivered_on ?? 'not yet'}.`).join('\n') : '- No shipment record yet.'}
Recent customer-safe events:
${events.results.map((event) => `- ${event.occurred_at}: ${event.customer_safe_description}`).join('\n')}
Return: ${returnRow ? `${returnRow.return_id}, ${returnRow.status}, reason ${returnRow.reason_code}, requested ${returnRow.requested_on}.` : 'No return recorded.'}
Charge account: ${charge ? `${charge.status}; ${formatCurrency(Number(charge.amount_cents), String(charge.currency))}; authorization ${charge.authorization_code}; ${charge.authorized_at}.` : 'No charge-account authorization recorded.'}
</authorized_records>`;
}

async function shipmentContext(
  db: D1Database,
  identifier: string,
  user: AuthenticatedUser,
) {
  const shipment = await db
    .prepare(`SELECT s.shipment_id, s.status, s.carrier_name,
      s.tracking_reference, s.shipped_on, s.estimated_delivery_date,
      s.delivered_on, o.order_id, o.customer_po_number
      FROM shipments s
      JOIN orders o ON o.order_id = s.order_id
      WHERE o.customer_id = ?
        AND (s.shipment_id = ? OR s.tracking_reference = ?)`)
    .bind(user.distributorId, identifier, identifier)
    .first<Record<string, string | null>>();
  if (!shipment)
    return `<authorized_records>
No shipment matching ${identifier} is available within ${user.distributorDisplayName}'s authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`;

  return `<authorized_records>
Authorization: ${user.distributorDisplayName} (${user.distributorId}) only.
Shipment: ${shipment.shipment_id}; status: ${shipment.status}; carrier: ${shipment.carrier_name}; tracking: ${shipment.tracking_reference}.
Order: ${shipment.order_id}; customer PO: ${shipment.customer_po_number}.
Shipped: ${shipment.shipped_on ?? 'not yet'}; estimated delivery: ${shipment.estimated_delivery_date ?? 'not assigned'}; delivered: ${shipment.delivered_on ?? 'not yet'}.
</authorized_records>`;
}

async function returnContext(
  db: D1Database,
  identifier: string,
  user: AuthenticatedUser,
) {
  const returnRow = await db
    .prepare(`SELECT r.return_id, r.status, r.reason_code, r.requested_on,
      r.authorized_on, r.received_on, o.order_id, o.customer_po_number
      FROM returns r
      JOIN orders o ON o.order_id = r.order_id
      WHERE o.customer_id = ? AND r.return_id = ?`)
    .bind(user.distributorId, identifier)
    .first<Record<string, string | null>>();
  if (!returnRow)
    return `<authorized_records>
No return matching ${identifier} is available within ${user.distributorDisplayName}'s authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`;

  const items = await db
    .prepare(`SELECT ri.line_number, ri.return_quantity, ri.disposition,
      oi.item_number, oi.product_name_snapshot
      FROM return_items ri
      JOIN order_items oi
        ON oi.order_id = ri.order_id AND oi.line_number = ri.line_number
      WHERE ri.return_id = ? ORDER BY ri.line_number`)
    .bind(identifier)
    .all<Record<string, string | number>>();
  return `<authorized_records>
Authorization: ${user.distributorDisplayName} (${user.distributorId}) only.
Return: ${returnRow.return_id}; status: ${returnRow.status}; reason: ${returnRow.reason_code}.
Order: \`${returnRow.order_id}\`; customer PO: \`${returnRow.customer_po_number}\`.
Requested: ${returnRow.requested_on}; authorized: ${returnRow.authorized_on ?? 'not yet'}; received: ${returnRow.received_on ?? 'not yet'}.
Items:
${items.results.map((item) => `- ${item.item_number} ${item.product_name_snapshot}: quantity ${item.return_quantity}; disposition ${item.disposition}.`).join('\n') || '- No return lines recorded.'}
</authorized_records>`;
}

async function orderSearchContext(
  db: D1Database,
  user: AuthenticatedUser,
  status?: SupportOrderStatus,
  year?: number,
  yearField?: 'created' | 'requested',
  product?: ProductRow,
) {
  const clauses = ['o.customer_id = ?'];
  const params: unknown[] = [user.distributorId];
  if (status === 'active') {
    clauses.push("o.status NOT IN ('scheduled', 'delivered', 'cancelled')");
  } else if (status) {
    clauses.push('o.status = ?');
    params.push(status);
  }
  if (year) {
    const column =
      yearField === 'requested' ? 'o.requested_ship_date' : 'o.created_on';
    clauses.push(`${column} >= ? AND ${column} < ?`);
    params.push(`${year}-01-01`, `${year + 1}-01-01`);
  }
  if (product) {
    clauses.push(`EXISTS (
      SELECT 1 FROM order_items oi
      WHERE oi.order_id = o.order_id AND oi.item_number = ?
    )`);
    params.push(product.item_number);
  }
  const rows = await db
    .prepare(`SELECT o.order_id, o.customer_po_number, o.created_on,
      o.requested_ship_date, o.status, o.order_total_cents, o.currency
      FROM orders o
      WHERE ${clauses.join(' AND ')}
      ORDER BY o.created_on DESC, o.order_id DESC LIMIT 6`)
    .bind(...params)
    .all<Record<string, string | number>>();
  const criteria = [
    status ? `status ${status.replaceAll('_', ' ')}` : null,
    year
      ? `${yearField === 'requested' ? 'requested' : 'created'} in ${year}`
      : null,
    product
      ? `containing product ${product.product_name} (${product.item_number})`
      : null,
  ].filter(Boolean);
  return `<authorized_records>
Authorization: ${user.distributorDisplayName} (${user.distributorId}) only.
Order search${criteria.length ? ` for ${criteria.join(', ')}` : ''}; showing up to 6 most recent matches.
${rows.results.map((row) => `- ${row.order_id} / ${row.customer_po_number}: ${row.status}; created ${row.created_on}; requested ${row.requested_ship_date}; ${formatCurrency(Number(row.order_total_cents), String(row.currency))}.`).join('\n') || '- No matching orders.'}
</authorized_records>`;
}

async function accountContext(
  db: D1Database,
  user: AuthenticatedUser,
  includeCharges: boolean,
) {
  const summary = await getAccountSummary(db, user);
  const charges = includeCharges
    ? await db
        .prepare(`SELECT c.order_id, c.status, c.amount_cents, c.currency,
          c.authorization_code, c.authorized_at
          FROM account_charges c
          JOIN orders o ON o.order_id = c.order_id
          WHERE o.customer_id = ?
          ORDER BY c.authorized_at DESC LIMIT 8`)
        .bind(user.distributorId)
        .all<Record<string, string | number>>()
    : { results: [] };
  return `<authorized_records>
Authorization: ${summary.displayName} (${summary.customerId}) only.
Account tier: ${summary.accountTier}; payment terms: ${summary.paymentTerms}; currency: ${summary.currency}; region: ${summary.region}.
Authenticated user: ${summary.userDisplayName} (${summary.userId}); role: ${summary.userRole}.
Orders: ${summary.totalOrders} total; ${summary.activeOrders} active; ${summary.scheduledOrders} scheduled.
Recent charge-account authorizations:
${charges.results.map((charge) => `- ${charge.order_id}: ${charge.status}; ${formatCurrency(Number(charge.amount_cents), String(charge.currency))}; authorization ${charge.authorization_code}; ${charge.authorized_at}.`).join('\n') || '- No charge-account authorizations recorded.'}
</authorized_records>`;
}

async function matchProducts(db: D1Database, message: string) {
  const rows = await db
    .prepare('SELECT * FROM products ORDER BY product_name')
    .all<ProductRow>();
  const explicitMatches: ProductRow[] = [];
  const references = new Set(itemReferences(message));
  const keywordCandidates: ProductRow[] = [];
  let keywordMessage = message;
  for (const product of rows.results) {
    const itemNumber = product.item_number.toLowerCase();
    const productName = product.product_name.toLowerCase();
    if (references.has(product.item_number) || message.includes(productName)) {
      explicitMatches.push(product);
      // Words inside a full name identify that product, not another product's
      // alias. Remove every explicit mention only from the keyword-search copy.
      keywordMessage = keywordMessage
        .replaceAll(itemNumber, ' ')
        .replaceAll(productName, ' ');
    } else {
      keywordCandidates.push(product);
    }
  }
  // Check aliases after collecting all explicit references, regardless of row
  // order. Separately mentioned aliases remain available for mixed comparisons.
  const keywordMatches = keywordCandidates.filter((product) =>
    product.search_terms
      .split(',')
      .some((term) => term.length >= 4 && keywordMessage.includes(term.trim())),
  );
  // Full names and item numbers outrank generic terms such as "controller".
  // Preserve alphabetical order within each tier and include each product once.
  return [...explicitMatches, ...keywordMatches];
}

async function productComparisonContext(
  db: D1Database,
  products: ProductRow[],
  quantity?: number,
  includeLocations = false,
) {
  const records = await Promise.all(
    products.map((product) =>
      productContext(db, product, quantity, includeLocations),
    ),
  );
  return `<authorized_records>
${records.join('\n')}
</authorized_records>`;
}

async function productContext(
  db: D1Database,
  product: ProductRow,
  quantity?: number,
  includeLocations = false,
) {
  if (product.fulfillment_type === 'license') {
    const quantityNote = quantity
      ? `Requested quantity ${quantity}: ${quantity % product.case_pack === 0 ? 'valid minimum-block multiple' : `must be adjusted to a multiple of ${product.case_pack}`}.
`
      : '';
    return `Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
Wholesale price: ${formatCurrency(product.unit_price_cents)} per ${product.unit_label}; minimum block ${product.case_pack}.
${quantityNote}This is a digitally allocated license and does not have a physical stock balance.`;
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
  const invalidCasePack =
    quantity !== undefined && quantity % product.case_pack !== 0;
  // Compare the original request to usable stock, not to an adjusted case-pack
  // quantity. Surplus stock is not a negative shortage or an adjustment gap.
  const requestedShortfall =
    quantity === undefined ? undefined : Math.max(0, quantity - available);
  const quantityNote = quantity
    ? `Requested quantity ${quantity}: ${invalidCasePack ? `not a multiple of case pack ${product.case_pack}` : 'valid case-pack multiple'}; ${available >= quantity ? 'currently within available-to-promise stock' : `exceeds current available-to-promise stock by ${requestedShortfall}`}.
`
    : '';
  const shortfallNote = quantity
    ? `Stock shortfall for requested quantity ${quantity}: ${requestedShortfall} units (${quantity} requested; ${available} available). Case-pack adjustment distance is not a stock shortfall.\n`
    : '';
  const orderingRestriction = invalidCasePack
    ? `Ordering restriction: quantity ${quantity} cannot be ordered or fulfilled as requested. It must be adjusted to a full case-pack multiple of ${product.case_pack}; sufficient stock does not waive this rule. Do not offer partial-unit or broken-case exceptions to this ordering restriction.\n`
    : '';
  const adjustmentNote = invalidCasePack
    ? casePackAdjustmentContext(quantity, product.case_pack, available)
    : '';
  let locationNote = '';
  if (includeLocations) {
    const locations = await db
      .prepare(`SELECT l.location_name, l.service_region,
        i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity AS available,
        i.inbound_quantity, i.expected_restock_date
        FROM inventory_balances i
        JOIN fulfillment_locations l ON l.location_id = i.location_id
        WHERE i.item_number = ? ORDER BY available DESC, l.location_name`)
      .bind(product.item_number)
      .all<Record<string, string | number | null>>();
    locationNote = `\nFulfillment locations:\n${locations.results.map((location) => `- ${location.location_name} (${location.service_region}): ${location.available} available; ${location.inbound_quantity} inbound; restock ${location.expected_restock_date ?? 'not scheduled'}.`).join('\n') || '- No physical fulfillment locations recorded.'}`;
  }
  return `Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
Wholesale price: ${formatCurrency(product.unit_price_cents)} per ${product.unit_label}; case pack ${product.case_pack}; standard lead time ${product.lead_time_days} days.
${quantityNote}${shortfallNote}${orderingRestriction}${adjustmentNote}Available to promise as of ${AS_OF_DATE}: ${available}. Inbound: ${inventory?.inbound ?? 0}. Expected restock: ${inventory?.expected_restock_date ?? 'none scheduled'}.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.${locationNote}`;
}

function casePackAdjustmentContext(
  requested: number,
  casePack: number,
  available: number,
) {
  // Compute from the matched product, not from model-generated arithmetic.
  // Zero is not an orderable alternative when the request is below one case.
  const alternatives = [
    {
      quantity: Math.floor(requested / casePack) * casePack,
      label: 'Lower',
      direction: 'below',
    },
    {
      quantity: Math.ceil(requested / casePack) * casePack,
      label: 'Higher',
      direction: 'above',
    },
  ]
    .filter(({ quantity }) => quantity > 0)
    .map((alternative) => ({
      ...alternative,
      cases: alternative.quantity / casePack,
      distance: Math.abs(alternative.quantity - requested),
    }));
  const nearestDistance = Math.min(
    ...alternatives.map(({ distance }) => distance),
  );
  const nearest = alternatives.filter(
    ({ distance }) => distance === nearestDistance,
  );
  // There are at most two adjacent multiples. Explicitly distinguish a
  // farther alternative from the nearest choice so a list heading cannot
  // imply they are tied. Stock availability does not change this comparison.
  const farther = alternatives.find(
    ({ distance }) => distance > nearestDistance,
  );
  const nearestLabel =
    nearest.length === 1
      ? `Only ${nearest[0].quantity} units is nearest.`
      : `${nearest.map(({ quantity }) => quantity).join(' and ')} units are equally nearest. Both may appear in a "Nearest quantities" list.`;
  const alternativeLabel = farther
    ? ` ${farther.quantity} units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".`
    : '';
  const descriptions = alternatives.map(
    ({ quantity, label, direction, cases, distance }) => {
      const availability =
        quantity <= available
          ? 'within current available-to-promise stock'
          : `exceeds current available-to-promise stock by ${quantity - available} units`;
      return `${label} valid quantity: ${quantity} units (${cases} ${cases === 1 ? 'case' : 'cases'}), ${distance} ${distance === 1 ? 'unit' : 'units'} ${direction} requested quantity ${requested}; ${availability}.`;
    },
  );
  descriptions.push(
    `${nearest.length === 1 ? 'Nearest valid quantity' : 'Equally nearest valid quantities'}: ${nearest.map(({ quantity }) => quantity).join(' or ')} units (${nearestDistance} ${nearestDistance === 1 ? 'unit' : 'units'} from requested quantity ${requested}). Nearest means smallest absolute quantity difference, not rounding down or a guarantee of stock availability.`,
    `Response labeling: ${nearestLabel}${alternativeLabel}`,
  );
  return descriptions.join('\n') + '\n';
}

async function categoryInventoryContext(db: D1Database, category: string) {
  const rows = await db
    .prepare(`SELECT p.item_number, p.product_name, p.fulfillment_type,
      p.unit_price_cents, p.unit_label, p.case_pack, p.lead_time_days,
      CASE WHEN p.fulfillment_type = 'license' THEN NULL
        ELSE COALESCE(SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity), 0)
      END AS available,
      COALESCE(SUM(i.inbound_quantity), 0) AS inbound
      FROM products p
      LEFT JOIN inventory_balances i ON i.item_number = p.item_number
      WHERE p.active_to IS NULL AND p.category = ?
      GROUP BY p.item_number ORDER BY p.product_name LIMIT 12`)
    .bind(category)
    .all<Record<string, string | number | null>>();
  return `<authorized_records>
Active ${category} catalog as of ${AS_OF_DATE}:
${rows.results.map((row) => `- ${row.item_number} ${row.product_name}: ${formatCurrency(Number(row.unit_price_cents), 'USD')} per ${row.unit_label}; pack ${row.case_pack}; lead ${row.lead_time_days} days; ${row.fulfillment_type === 'license' ? 'digital allocation' : `${row.available} available, ${row.inbound} inbound`}.`).join('\n') || '- No active products in this category.'}
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
