import type { AuthenticatedUser } from './auth';
import { listSupportIncidents } from './incidents';
import { AS_OF_DATE } from './seed';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import type { AccountSummary } from '@/lib/contracts';
import { formatCurrency } from '@/lib/format';
import {
  matchingOrderStatuses,
  type SupportOrderStatusFilter,
} from '@/lib/support-order-status';
import {
  bindProductQuantities,
  type ProductMention,
  type QuantityOccurrence,
} from '@/lib/support-quantities';
import {
  itemReferences,
  type SupportRecordReference,
} from '@/lib/support-references';
import {
  classifySupportQueries,
  type SupportQueryIntent,
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
    seedAsOfDate: AS_OF_DATE,
    retrievedAt: new Date().toISOString(),
  };
}

const REFERENCE_NAMESPACE_LABELS = {
  order_id: 'order ID',
  customer_po: 'customer PO',
  shipment_id: 'shipment ID',
  tracking_reference: 'tracking reference',
  return_id: 'return ID',
};

function compoundPartLabel(intent: SupportQueryIntent) {
  if (intent.kind === 'orders') return 'order search';
  if (!('identifier' in intent)) return 'catalog request';
  const namespace =
    intent.namespace === 'unresolved'
      ? ''
      : ` (${REFERENCE_NAMESPACE_LABELS[intent.namespace]})`;
  return `${intent.kind} ${intent.identifier}${namespace}`;
}

const CLARIFICATION_REFERENCES = {
  order: 'order ID or customer PO number',
  shipment: 'shipment ID or tracking reference',
  return: 'return ID',
  record: 'order, shipment, or return reference, or item number',
};

export type SupportContextResult =
  | { kind: 'records'; records: string }
  | { kind: 'clarification'; message: string };

type Clarification = Extract<SupportContextResult, { kind: 'clarification' }>;

const QUANTITY_CLARIFICATIONS = {
  syntax:
    'Please provide a whole-number quantity of units for each item, using digits with optional comma grouping.',
  range: 'Please provide a quantity from 1 to 999,999 units for each item.',
  ambiguous:
    'Please specify one quantity for each item, or say that the same quantity applies to each item.',
  missing_target:
    'Please provide the item number or product name for the requested quantity.',
};

function quantityClarification(
  reason: keyof typeof QUANTITY_CLARIFICATIONS,
): Clarification {
  return { kind: 'clarification', message: QUANTITY_CLARIFICATIONS[reason] };
}

// Each part of a compound question is retrieved with the same scoped lookups
// and combined into one records block, so every part is evidence and a missing
// record is stated alongside the authorized ones.
export async function buildSupportContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
): Promise<SupportContextResult> {
  const intents = classifySupportQueries(messages);
  const parts: string[] = [];
  for (const [index, intent] of intents.entries()) {
    const context = await authorizedContextForIntent(db, intent, user);
    // Resolve ambiguity before any compound facts are sent to the model.
    if (typeof context !== 'string') return context;
    if (intents.length === 1) return { kind: 'records', records: context };
    const records = context
      .replace(/^<authorized_records>\n/, '')
      .replace(/\n<\/authorized_records>$/, '');
    parts.push(
      `Part ${index + 1} of ${intents.length}: ${compoundPartLabel(intent)}\n${records}`,
    );
  }
  return {
    kind: 'records',
    records: `<authorized_records>
The customer asked about ${intents.length} things in one message. Answer each part from its own records.

${parts.join('\n\n')}
</authorized_records>`,
  };
}

// Compatibility adapter for existing context/model consumers. Remove in Phase
// 5D after those consumers migrate to typed retrieval outcomes.
export async function buildAuthorizedContext(
  db: D1Database,
  messages: ChatHistoryMessage[],
  user: AuthenticatedUser,
) {
  const result = await buildSupportContext(db, messages, user);
  return result.kind === 'records'
    ? result.records
    : `<authorized_records>\n${result.message}\n</authorized_records>`;
}

async function authorizedContextForIntent(
  db: D1Database,
  intent: SupportQueryIntent,
  user: AuthenticatedUser,
): Promise<string | Clarification> {
  if (intent.kind === 'orders' && intent.statusFilter?.kind === 'clarification')
    return {
      kind: 'clarification',
      message:
        'Please clarify which order statuses to include or exclude. For example, ask for orders excluding cancelled and delivered.',
    };
  if (intent.kind === 'catalog') {
    for (const { quantity } of intent.quantities)
      if (quantity.kind === 'invalid')
        return quantityClarification(quantity.reason);
  }
  const { products, mentions } =
    'message' in intent
      ? await matchProducts(
          db,
          intent.message,
          intent.kind === 'catalog' ? intent.quantities : [],
        )
      : { products: [], mentions: [] };
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
    case 'clarification':
      return {
        kind: 'clarification',
        message: `Please specify ${intent.reason === 'multiple_targets' ? 'which' : 'the'} ${intent.entity} you mean by its ${CLARIFICATION_REFERENCES[intent.entity]}.`,
      };
    case 'order':
      return orderContext(db, intent, user);
    case 'shipment':
      return shipmentContext(db, intent, user);
    case 'return':
      return returnContext(db, intent.identifier, user);
    case 'orders': {
      return orderSearchContext(
        db,
        user,
        intent.statusFilter?.kind === 'filter'
          ? intent.statusFilter
          : undefined,
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
      let quantities = new Map<string, number>();
      if (intent.quantities.length) {
        if (products.length > 3)
          return {
            kind: 'clarification',
            message:
              'Please ask about quantities for up to three items at a time.',
          };
        const binding = bindProductQuantities(
          intent.message,
          intent.quantities,
          mentions,
        );
        if (binding.kind === 'clarification')
          return quantityClarification(binding.reason);
        quantities = binding.quantities;
      }
      if (products.length > 0 && (!intent.category || products.length <= 3)) {
        const selected =
          intent.compare || intent.quantities.length > 0
            ? products.slice(0, 3)
            : products.slice(0, 1);
        return productComparisonContext(
          db,
          selected.map((product) => ({
            product,
            quantity: quantities.get(product.item_number),
          })),
          intent.includeLocations,
        );
      }
      if (intent.category) return categoryInventoryContext(db, intent.category);
      return inventoryAlertContext(db);
    }
    case 'summary': {
      if (products.length > 0)
        return productComparisonContext(db, [{ product: products[0] }]);
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
Records retrieved at: ${summary.retrievedAt}
Seed baseline date: ${summary.seedAsOfDate}. Stored order statuses do not automatically advance with time.
Authorized order count: ${summary.totalOrders}; active: ${summary.activeOrders}; scheduled: ${summary.scheduledOrders}.
No specific order or item was identified in the request. Ask for a SABLE order ID, account PO number, or item number when account-specific facts are required.
</authorized_records>`;
}

async function orderContext(
  db: D1Database,
  reference: Extract<SupportRecordReference, { kind: 'order' }>,
  user: AuthenticatedUser,
): Promise<string | Clarification> {
  const { identifier, namespace } = reference;
  const predicate =
    namespace === 'order_id'
      ? 'o.order_id = ?'
      : namespace === 'customer_po'
        ? 'o.customer_po_number = ?'
        : '(o.order_id = ? OR o.customer_po_number = ?)';
  const matches = await db
    .prepare(`SELECT o.order_id, o.customer_po_number, o.created_on,
      o.requested_ship_date, o.status, o.currency, o.order_total_cents,
      o.shipping_region, o.placed_by_user_id, u.display_name AS placed_by_name
      FROM orders o
      JOIN users u ON u.user_id = o.placed_by_user_id
      WHERE o.customer_id = ? AND ${predicate} LIMIT 2`)
    .bind(
      user.distributorId,
      identifier,
      ...(namespace === 'unresolved' ? [identifier] : []),
    )
    .all<Record<string, string | number>>();
  if (matches.results.length > 1)
    return {
      kind: 'clarification',
      message: `Please specify whether ${identifier} is an order ID or a customer PO number.`,
    };
  const order = matches.results[0];

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
  reference: Extract<SupportRecordReference, { kind: 'shipment' }>,
  user: AuthenticatedUser,
): Promise<string | Clarification> {
  const { identifier, namespace } = reference;
  const predicate =
    namespace === 'shipment_id'
      ? 's.shipment_id = ?'
      : namespace === 'tracking_reference'
        ? 's.tracking_reference = ?'
        : '(s.shipment_id = ? OR s.tracking_reference = ?)';
  const matches = await db
    .prepare(`SELECT s.shipment_id, s.status, s.carrier_name,
      s.tracking_reference, s.shipped_on, s.estimated_delivery_date,
      s.delivered_on, o.order_id, o.customer_po_number
      FROM shipments s
      JOIN orders o ON o.order_id = s.order_id
      WHERE o.customer_id = ?
        AND ${predicate} LIMIT 2`)
    .bind(
      user.distributorId,
      identifier,
      ...(namespace === 'unresolved' ? [identifier] : []),
    )
    .all<Record<string, string | null>>();
  if (matches.results.length > 1)
    return {
      kind: 'clarification',
      message:
        namespace === 'tracking_reference'
          ? `Please specify a shipment ID for tracking reference ${identifier}.`
          : `Please specify whether ${identifier} is a shipment ID or a tracking reference.`,
    };
  const shipment = matches.results[0];
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
      WHERE ri.return_id = ? AND ri.order_id = ? ORDER BY ri.line_number`)
    .bind(identifier, returnRow.order_id)
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
  statusFilter?: Extract<SupportOrderStatusFilter, { kind: 'filter' }>,
  year?: number,
  yearField?: 'created' | 'requested',
  product?: ProductRow,
) {
  const clauses = ['o.customer_id = ?'];
  const params: unknown[] = [user.distributorId];
  if (statusFilter) {
    const statuses = matchingOrderStatuses(statusFilter);
    clauses.push(
      statuses.length
        ? `o.status IN (${statuses.map(() => '?').join(', ')})`
        : '0 = 1',
    );
    params.push(...statuses);
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
  const where = clauses.join(' AND ');
  const [countResult, rowResult] = await db.batch([
    // Report every match so count questions are not answered from listed rows.
    db
      .prepare(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`)
      .bind(...params),
    db
      .prepare(`SELECT o.order_id, o.customer_po_number, o.created_on,
      o.requested_ship_date, o.status, o.order_total_cents, o.currency
      FROM orders o
      WHERE ${where}
      ORDER BY o.created_on DESC, o.order_id DESC LIMIT 6`)
      .bind(...params),
  ]);
  const total = Number(
    (countResult.results[0] as { total: number } | undefined)?.total ?? 0,
  );
  const rows = rowResult as D1Result<Record<string, string | number>>;
  const included = statusFilter?.include.map((status) =>
    status.replaceAll('_', ' '),
  );
  const excluded = statusFilter?.exclude.map((status) =>
    status.replaceAll('_', ' '),
  );
  const criteria = [
    included?.length ? `status ${included.join(' or ')}` : null,
    excluded?.length
      ? `excluding ${excluded.length === 1 ? 'status' : 'statuses'} ${excluded.join(' and ')}`
      : null,
    year
      ? `${yearField === 'requested' ? 'requested' : 'created'} in ${year}`
      : null,
    product
      ? `containing product ${product.product_name} (${product.item_number})`
      : null,
  ].filter(Boolean);
  return `<authorized_records>
Authorization: ${user.distributorDisplayName} (${user.distributorId}) only.
Order search${criteria.length ? ` for ${criteria.join(', ')}` : ''}: ${total} matching ${total === 1 ? 'order' : 'orders'}${total === 0 ? '.' : rows.results.length < total ? `; listing the ${rows.results.length} most recent.` : `; listing all ${total}.`}
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

function productMentions(
  message: string,
  itemNumber: string,
  term: string,
  wholeToken = false,
): ProductMention[] {
  const mentions: ProductMention[] = [];
  let start = message.indexOf(term);
  while (start !== -1) {
    const end = start + term.length;
    if (
      !wholeToken ||
      (!/[\w-]/.test(message[start - 1] ?? '') &&
        !/[\w-]/.test(message[end] ?? ''))
    )
      mentions.push({ itemNumber, start, end });
    start = message.indexOf(term, end);
  }
  return mentions;
}

async function matchProducts(
  db: D1Database,
  message: string,
  quantities: QuantityOccurrence[] = [],
) {
  const rows = await db
    .prepare('SELECT * FROM products ORDER BY product_name')
    .all<ProductRow>();
  const explicitMatches: ProductRow[] = [];
  const references = new Set(itemReferences(message));
  const mentions: ProductMention[] = [];
  for (const product of rows.results) {
    const itemNumber = product.item_number.toLowerCase();
    const productName = product.product_name.toLowerCase();
    if (references.has(product.item_number) || message.includes(productName)) {
      explicitMatches.push(product);
      const exact = [
        ...productMentions(message, product.item_number, itemNumber, true),
        ...productMentions(message, product.item_number, productName),
      ];
      // "SBL-CSR-R2 controller" describes the explicit product; its trailing
      // noun must not become another product through the generic alias tier.
      const descriptors = [
        product.unit_label,
        `${product.unit_label}s`,
        ...product.search_terms.split(','),
      ]
        .map((term) => term.trim())
        .filter((term) => term.length >= 4)
        .flatMap((term) =>
          productMentions(message, product.item_number, term, true),
        )
        .filter((descriptor) =>
          exact.some(
            (mention) =>
              (descriptor.start >= mention.end &&
                /^\s+$/.test(message.slice(mention.end, descriptor.start))) ||
              (descriptor.end <= mention.start &&
                /^\s+$/.test(message.slice(descriptor.end, mention.start))),
          ),
        );
      mentions.push(...exact, ...descriptors);
    }
  }
  // Mask exact references without shifting the source positions. A word in a
  // full product name must not also identify another product through an alias.
  const keywordCharacters = message.split('');
  for (const { start, end } of mentions)
    keywordCharacters.fill(' ', start, end);
  // The final word of a parsed quantity is its unit, not a product alias:
  // "20 licenses of SBL-RLY-1Y" must not also select Palisade via "license".
  for (const { start, end } of quantities) {
    const unit = message.slice(start, end).match(/[a-z]+$/i)?.[0];
    if (unit) keywordCharacters.fill(' ', end - unit.length, end);
  }
  const keywordMessage = keywordCharacters.join('');
  // Check aliases after collecting all explicit references, regardless of row
  // order. Separately mentioned aliases remain available for mixed comparisons.
  const keywordMatches: ProductRow[] = [];
  for (const product of rows.results) {
    const aliases = product.search_terms
      .split(',')
      .map((term) => term.trim())
      .filter((term) => term.length >= 4);
    const aliasMentions = aliases.flatMap((term) =>
      productMentions(keywordMessage, product.item_number, term),
    );
    if (!aliasMentions.length) continue;
    mentions.push(...aliasMentions);
    if (!explicitMatches.includes(product)) keywordMatches.push(product);
  }
  // Full names and item numbers outrank generic terms such as "controller".
  // Preserve alphabetical order within each tier and include each product once.
  return { products: [...explicitMatches, ...keywordMatches], mentions };
}

async function productComparisonContext(
  db: D1Database,
  products: { product: ProductRow; quantity?: number }[],
  includeLocations = false,
) {
  const records = await Promise.all(
    products.map(({ product, quantity }) =>
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
    const quantityNote =
      quantity !== undefined
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
  const quantityNote =
    quantity !== undefined
      ? `Requested quantity ${quantity}: ${invalidCasePack ? `not a multiple of case pack ${product.case_pack}` : 'valid case-pack multiple'}; ${available >= quantity ? 'currently within available-to-promise stock' : `exceeds current available-to-promise stock by ${requestedShortfall}`}.
`
      : '';
  const shortfallNote =
    quantity !== undefined
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
    // Per-location figures are parts of the total; a customer asking about
    // "this warehouse" without naming one must still get the total.
    locationNote = `\nFulfillment locations (each figure is part of the ${available} total available to promise; give the total unless the customer names a specific location):\n${locations.results.map((location) => `- ${location.location_name} (${location.service_region}): ${location.available} available; ${location.inbound_quantity} inbound; restock ${location.expected_restock_date ?? 'not scheduled'}.`).join('\n') || '- No physical fulfillment locations recorded.'}`;
  }
  return `Product: ${product.item_number} — ${product.product_name}; category ${product.category}.
Wholesale price: ${formatCurrency(product.unit_price_cents)} per ${product.unit_label}; case pack ${product.case_pack}; standard lead time ${product.lead_time_days} days.
${quantityNote}${shortfallNote}${orderingRestriction}${adjustmentNote}Available to promise: ${available}. Inbound: ${inventory?.inbound ?? 0}. Expected restock: ${inventory?.expected_restock_date ?? 'none scheduled'}.
Inventory retrieved at: ${new Date().toISOString()}. Latest inventory record update: ${inventory?.updated_at ?? 'not recorded'}.
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
Active ${category} catalog retrieved at ${new Date().toISOString()}:
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
Current SABLE physical inventory advisories retrieved at ${new Date().toISOString()}:
${rows.results.map((row) => `- ${row.item_number} ${row.product_name}: ${row.available} available; ${row.inbound} inbound; restock ${row.restock ?? 'not scheduled'}.`).join('\n')}
Ask which item the customer wants if a specific availability decision is required.
</authorized_records>`;
}
