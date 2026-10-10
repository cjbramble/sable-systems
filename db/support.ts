import type { AuthenticatedUser } from './auth';
import { listSupportIncidents } from './incidents';
import { AS_OF_DATE } from './seed';
import { lookupSupportOrder } from './support-orders';
import { lookupSupportShipment } from './support-shipments';
import { lookupSupportReturn } from './support-returns';
import {
  lookupSupportProducts,
  type SupportProductRow,
} from './support-products';
import {
  renderProductOutcome,
  type ProductLookupOutcome,
} from '@/lib/support-product-outcomes';
import {
  renderRecordOutcome,
  type RecordLookupOutcome,
  type SupportContextPart,
  type SupportContextResult,
} from '@/lib/support-outcomes';
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
import { itemReferences } from '@/lib/support-references';
import {
  classifySupportQueries,
  type SupportQueryIntent,
} from '@/lib/support-query';

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
  const parts: SupportContextPart[] = [];
  const rendered: string[] = [];
  for (const [index, intent] of intents.entries()) {
    const context = await authorizedContextForIntent(db, intent, user);
    // Resolve ambiguity before any compound facts are sent to the model.
    if (typeof context !== 'string' && context.kind === 'clarification')
      return context;
    if (typeof context !== 'string' && context.outcome === 'ambiguous')
      return {
        kind: 'clarification',
        message:
          context.kind === 'order'
            ? `Please specify whether ${context.reference.identifier} is an order ID or a customer PO number.`
            : context.reference.namespace === 'tracking_reference'
              ? `Please specify a shipment ID for tracking reference ${context.reference.identifier}.`
              : `Please specify whether ${context.reference.identifier} is a shipment ID or a tracking reference.`,
      };
    const part: SupportContextPart =
      typeof context === 'string'
        ? { kind: 'legacy', records: context }
        : context;
    parts.push(part);
    const text =
      part.kind === 'legacy'
        ? part.records
        : part.kind === 'products'
          ? renderProductOutcome(part)
          : renderRecordOutcome(part);
    if (intents.length === 1) return { kind: 'records', records: text, parts };
    const records = text
      .replace(/^<authorized_records>\n/, '')
      .replace(/\n<\/authorized_records>$/, '');
    rendered.push(
      `Part ${index + 1} of ${intents.length}: ${compoundPartLabel(intent)}\n${records}`,
    );
  }
  return {
    kind: 'records',
    parts,
    records: `<authorized_records>
The customer asked about ${intents.length} things in one message. Answer each part from its own records.

${rendered.join('\n\n')}
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
): Promise<
  string | Clarification | RecordLookupOutcome | ProductLookupOutcome
> {
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
      return lookupSupportOrder(db, intent, user);
    case 'shipment':
      return lookupSupportShipment(db, intent, user);
    case 'return':
      return lookupSupportReturn(db, intent, user);
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
        return lookupSupportProducts(
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
        return lookupSupportProducts(db, [{ product: products[0] }]);
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

async function orderSearchContext(
  db: D1Database,
  user: AuthenticatedUser,
  statusFilter?: Extract<SupportOrderStatusFilter, { kind: 'filter' }>,
  year?: number,
  yearField?: 'created' | 'requested',
  product?: SupportProductRow,
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
    .prepare(`SELECT item_number, product_name, category, fulfillment_type,
      unit_price_cents, unit_label, case_pack, lead_time_days, active_to,
      search_terms FROM products ORDER BY product_name`)
    .all<SupportProductRow>();
  const explicitMatches: SupportProductRow[] = [];
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
  const keywordMatches: SupportProductRow[] = [];
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
