import type { AuthenticatedUser } from './auth';
import { AS_OF_DATE } from './seed';
import type { AccountSummary } from '@/lib/contracts';
import { orderStatusCountSql } from '@/lib/order-status-groups';

export async function getAccountSummary(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<AccountSummary> {
  const orderCounts = await db
    .prepare(`SELECT
      COUNT(*) AS total_orders,
      ${orderStatusCountSql('active')} AS active_orders,
      ${orderStatusCountSql('scheduled')} AS scheduled_orders
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
