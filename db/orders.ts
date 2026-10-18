import type { AuthenticatedUser } from './auth';
import type {
  OrderHistoryEntry,
  OrderHistoryFilter,
  OrderHistoryResponse,
  OrderStatus,
} from '@/lib/contracts';
import {
  orderStatusCountSql,
  orderStatusGroupSql,
} from '@/lib/order-status-groups';

const ORDER_HISTORY_PAGE_SIZE = 25;

const ORDER_HISTORY_FILTERS = [
  'all',
  'active',
  'scheduled',
  'fulfilled',
  'closed',
] as const;

type OrderRow = {
  order_id: string;
  customer_po_number: string;
  created_on: string;
  requested_ship_date: string;
  status: OrderStatus;
  currency: string;
  order_total_cents: number;
  placed_by_user_id: string;
  placed_by_name: string;
  line_count: number;
  unit_count: number;
};

type CountRow = {
  total_orders: number;
  active_orders: number;
  scheduled_orders: number;
  fulfilled_orders: number;
};

type OrderHistoryInput = {
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
  return filter === 'all'
    ? ''
    : `AND ${orderStatusGroupSql(filter, 'o.status')}`;
}

// created_on holds only the UTC date and checkout order IDs are random, so
// same-day orders are ordered by the time their creation event was recorded.
const ORDER_CREATED_AT_SQL = `(SELECT MIN(julianday(e.occurred_at))
      FROM order_events e
      WHERE e.order_id = o.order_id
        AND e.event_type IN ('order_created', 'order_confirmed'))`;

export async function getOrderHistory(
  db: D1Database,
  user: AuthenticatedUser,
  input: OrderHistoryInput,
): Promise<OrderHistoryResponse> {
  const statusSql = statusClause(input.status);
  // A substring match, not LIKE: search text has no wildcards to escape, and
  // D1 rejects LIKE patterns over 50 bytes, below the 80-character query cap.
  const searchSql = input.query
    ? `AND (
      instr(lower(o.order_id), lower(?)) > 0
      OR instr(lower(o.customer_po_number), lower(?)) > 0
      OR instr(lower(u.display_name), lower(?)) > 0
    )`
    : '';
  const searchParams = input.query
    ? [input.query, input.query, input.query]
    : [];
  const whereSql = `WHERE o.customer_id = ? ${statusSql} ${searchSql}`;
  const rowsStatement = (page: number) =>
    db
      .prepare(`SELECT
      o.order_id, o.customer_po_number, o.created_on, o.requested_ship_date,
      o.status, o.currency, o.order_total_cents,
      o.placed_by_user_id, u.display_name AS placed_by_name,
      COALESCE(lines.line_count, 0) AS line_count,
      COALESCE(lines.unit_count, 0) AS unit_count
    FROM orders o
    JOIN users u ON u.user_id = o.placed_by_user_id
    LEFT JOIN (
      SELECT order_id, COUNT(*) AS line_count,
        SUM(ordered_quantity) AS unit_count
      FROM order_items
      GROUP BY order_id
    ) lines ON lines.order_id = o.order_id
    ${whereSql}
    ORDER BY o.created_on DESC, ${ORDER_CREATED_AT_SQL} DESC, o.order_id DESC
    LIMIT ? OFFSET ?`)
      .bind(
        user.distributorId,
        ...searchParams,
        ORDER_HISTORY_PAGE_SIZE,
        (page - 1) * ORDER_HISTORY_PAGE_SIZE,
      );
  const filteredCountStatement = db
    .prepare(`SELECT COUNT(*) AS total_orders
      FROM orders o
      JOIN users u ON u.user_id = o.placed_by_user_id
      ${whereSql}`)
    .bind(user.distributorId, ...searchParams);
  const summaryStatement = db
    .prepare(`SELECT
      COUNT(*) AS total_orders,
      ${orderStatusCountSql('active')} AS active_orders,
      ${orderStatusCountSql('scheduled')} AS scheduled_orders,
      ${orderStatusCountSql('fulfilled')} AS fulfilled_orders
      FROM orders WHERE customer_id = ?`)
    .bind(user.distributorId);

  const [rowsResult, filteredCountResult, summaryResult] = await db.batch<
    OrderRow | CountRow
  >([rowsStatement(input.page), filteredCountStatement, summaryStatement]);
  const filteredCount = filteredCountResult.results[0] as CountRow | undefined;
  const summary = summaryResult.results[0] as CountRow | undefined;
  const total = Number(filteredCount?.total_orders ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / ORDER_HISTORY_PAGE_SIZE));
  // A page can fall past the end when orders change between requests; serve
  // the last page instead of an empty one.
  const page = Math.min(input.page, totalPages);
  const rows = (
    page === input.page
      ? rowsResult.results
      : (await rowsStatement(page).all<OrderRow>()).results
  ) as OrderRow[];

  return {
    account: {
      customerId: user.distributorId,
      userId: user.userId,
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
        placedByUserId: row.placed_by_user_id,
        placedByName: row.placed_by_name,
        lineCount: Number(row.line_count),
        unitCount: Number(row.unit_count),
      }),
    ),
    page,
    pageSize: ORDER_HISTORY_PAGE_SIZE,
    total,
    totalPages,
    summary: {
      totalOrders: Number(summary?.total_orders ?? 0),
      activeOrders: Number(summary?.active_orders ?? 0),
      scheduledOrders: Number(summary?.scheduled_orders ?? 0),
      fulfilledOrders: Number(summary?.fulfilled_orders ?? 0),
    },
  };
}
