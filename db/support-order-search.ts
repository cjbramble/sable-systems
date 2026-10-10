import type { AuthenticatedUser } from './auth';
import { matchingOrderStatuses } from '@/lib/support-order-status';
import type {
  OrderSearchCriteria,
  OrderSearchOutcome,
  SupportOrderSearchRow,
} from '@/lib/support-order-search-outcomes';
import type { VerifiedSupportReference } from '@/lib/support-outcomes';

export async function lookupSupportOrderSearch(
  db: D1Database,
  user: AuthenticatedUser,
  criteria: OrderSearchCriteria,
): Promise<OrderSearchOutcome> {
  const { statusFilter, year, yearField, product } = criteria;
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
  const [countResult, rowResult] = await db.batch<
    { total: number } | SupportOrderSearchRow
  >([
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
  // D1 preserves statement order; the two projections have distinct row types.
  const count = countResult.results[0] as { total: number } | undefined;
  const orders = rowResult.results as SupportOrderSearchRow[];
  const verifiedReferences: VerifiedSupportReference[] = orders.flatMap(
    (order) => [
      { namespace: 'order_id', identifier: order.order_id },
      { namespace: 'customer_po', identifier: order.customer_po_number },
    ],
  );
  if (product)
    verifiedReferences.push({
      namespace: 'item_number',
      identifier: product.item_number,
    });
  return {
    kind: 'order_search',
    outcome: 'found',
    scope: {
      customerId: user.distributorId,
      displayName: user.distributorDisplayName,
    },
    criteria,
    facts: { total: count?.total ?? 0, orders },
    verifiedReferences,
  };
}
