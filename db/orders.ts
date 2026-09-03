import type { AuthenticatedUser } from './auth';

export const ORDER_HISTORY_PAGE_SIZE = 25;

export const ORDER_HISTORY_FILTERS = [
  'all',
  'active',
  'scheduled',
  'fulfilled',
  'closed',
] as const;

export type OrderHistoryFilter = (typeof ORDER_HISTORY_FILTERS)[number];

type OrderRow = {
  order_id: string;
  customer_po_number: string;
  created_on: string;
  requested_ship_date: string;
  status: string;
  currency: string;
  order_total_cents: number;
  shipping_region: string;
  placed_by_user_id: string;
  placed_by_name: string;
  line_count: number;
  unit_count: number;
  shipped_quantity: number;
};

type CountRow = {
  total_orders: number;
  active_orders: number;
  scheduled_orders: number;
  fulfilled_orders: number;
};

export type OrderHistoryEntry = {
  orderId: string;
  customerPoNumber: string;
  createdOn: string;
  requestedShipDate: string;
  status: string;
  currency: string;
  orderTotalCents: number;
  shippingRegion: string;
  placedByUserId: string;
  placedByName: string;
  lineCount: number;
  unitCount: number;
  shippedQuantity: number;
};

export type OrderHistoryInput = {
  page: number;
  status: OrderHistoryFilter;
  query: string;
};

export function parseOrderHistoryInput(url: URL): OrderHistoryInput | null {
  const rawPage = url.searchParams.get('page') ?? '1';
  const page = Number(rawPage);
  const status = url.searchParams.get('status') ?? 'all';
  const query = (url.searchParams.get('query') ?? '').trim();

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    !ORDER_HISTORY_FILTERS.includes(status as OrderHistoryFilter) ||
    query.length > 80
  ) {
    return null;
  }

  return { page, status: status as OrderHistoryFilter, query };
}

function statusClause(filter: OrderHistoryFilter) {
  switch (filter) {
    case 'active':
      return "AND o.status NOT IN ('scheduled', 'delivered', 'cancelled')";
    case 'scheduled':
      return "AND o.status = 'scheduled'";
    case 'fulfilled':
      return "AND o.status = 'delivered'";
    case 'closed':
      return "AND o.status = 'cancelled'";
    default:
      return '';
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function getOrderHistory(
  db: D1Database,
  user: AuthenticatedUser,
  input: OrderHistoryInput,
) {
  const statusSql = statusClause(input.status);
  const searchSql = input.query
    ? `AND (
      o.order_id LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR o.customer_po_number LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
    )`
    : '';
  const search = `%${escapeLike(input.query)}%`;
  const searchParams = input.query ? [search, search, search] : [];
  const offset = (input.page - 1) * ORDER_HISTORY_PAGE_SIZE;
  const whereSql = `WHERE o.customer_id = ? ${statusSql} ${searchSql}`;

  const rowsStatement = db
    .prepare(`SELECT
      o.order_id, o.customer_po_number, o.created_on, o.requested_ship_date,
      o.status, o.currency, o.order_total_cents, o.shipping_region,
      o.placed_by_user_id, u.display_name AS placed_by_name,
      COALESCE(lines.line_count, 0) AS line_count,
      COALESCE(lines.unit_count, 0) AS unit_count,
      COALESCE(lines.shipped_quantity, 0) AS shipped_quantity
    FROM orders o
    JOIN users u ON u.user_id = o.placed_by_user_id
    LEFT JOIN (
      SELECT order_id, COUNT(*) AS line_count,
        SUM(ordered_quantity) AS unit_count,
        SUM(shipped_quantity) AS shipped_quantity
      FROM order_items
      GROUP BY order_id
    ) lines ON lines.order_id = o.order_id
    ${whereSql}
    ORDER BY o.created_on DESC, o.order_id DESC
    LIMIT ? OFFSET ?`)
    .bind(user.distributorId, ...searchParams, ORDER_HISTORY_PAGE_SIZE, offset);
  const filteredCountStatement = db
    .prepare(`SELECT COUNT(*) AS total_orders
      FROM orders o
      JOIN users u ON u.user_id = o.placed_by_user_id
      ${whereSql}`)
    .bind(user.distributorId, ...searchParams);
  const summaryStatement = db
    .prepare(`SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status NOT IN ('scheduled', 'delivered', 'cancelled') THEN 1 ELSE 0 END) AS active_orders,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_orders,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS fulfilled_orders
      FROM orders WHERE customer_id = ?`)
    .bind(user.distributorId);

  const [rowsResult, filteredCountResult, summaryResult] = await db.batch<
    OrderRow | CountRow
  >([rowsStatement, filteredCountStatement, summaryStatement]);
  const rows = rowsResult.results as OrderRow[];
  const filteredCount = filteredCountResult.results[0] as CountRow | undefined;
  const summary = summaryResult.results[0] as CountRow | undefined;
  const total = Number(filteredCount?.total_orders ?? 0);

  return {
    account: {
      customerId: user.distributorId,
      displayName: user.distributorDisplayName,
      userDisplayName: user.userDisplayName,
      accountTier: user.accountTier,
      currency: user.currency,
      region: user.region,
    },
    orders: rows.map(
      (row): OrderHistoryEntry => ({
        orderId: row.order_id,
        customerPoNumber: row.customer_po_number,
        createdOn: row.created_on,
        requestedShipDate: row.requested_ship_date,
        status: row.status,
        currency: row.currency,
        orderTotalCents: Number(row.order_total_cents),
        shippingRegion: row.shipping_region,
        placedByUserId: row.placed_by_user_id,
        placedByName: row.placed_by_name,
        lineCount: Number(row.line_count),
        unitCount: Number(row.unit_count),
        shippedQuantity: Number(row.shipped_quantity),
      }),
    ),
    page: input.page,
    pageSize: ORDER_HISTORY_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / ORDER_HISTORY_PAGE_SIZE)),
    summary: {
      totalOrders: Number(summary?.total_orders ?? 0),
      activeOrders: Number(summary?.active_orders ?? 0),
      scheduledOrders: Number(summary?.scheduled_orders ?? 0),
      fulfilledOrders: Number(summary?.fulfilled_orders ?? 0),
    },
  };
}
