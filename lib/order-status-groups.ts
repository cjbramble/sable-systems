import type { OrderHistoryFilter, OrderStatus } from './contracts.ts';

export type OrderStatusGroup = Exclude<OrderHistoryFilter, 'all'>;

// One rule for history filters, summary counts, and badges. On-hold orders
// are still open, so they count as active even though they need attention.
export const ORDER_STATUS_GROUPS: Record<OrderStatus, OrderStatusGroup> = {
  scheduled: 'scheduled',
  confirmed: 'active',
  allocating: 'active',
  backordered: 'active',
  partially_shipped: 'active',
  shipped: 'active',
  on_hold: 'active',
  delivered: 'fulfilled',
  cancelled: 'closed',
};

export const ORDER_STATUSES = Object.keys(ORDER_STATUS_GROUPS) as OrderStatus[];

export function statusesInGroup(group: OrderStatusGroup): OrderStatus[] {
  return ORDER_STATUSES.filter(
    (status) => ORDER_STATUS_GROUPS[status] === group,
  );
}

// Statuses come from the fixed map above, never from request input.
export function orderStatusGroupSql(group: OrderStatusGroup, column: string) {
  const statuses = statusesInGroup(group).map((status) => `'${status}'`);
  return `${column} IN (${statuses.join(', ')})`;
}

export function orderStatusCountSql(group: OrderStatusGroup) {
  return `SUM(CASE WHEN ${orderStatusGroupSql(group, 'status')} THEN 1 ELSE 0 END)`;
}

export function orderStatusTone(status: OrderStatus) {
  if (status === 'on_hold') return 'is-attention';
  return `is-${ORDER_STATUS_GROUPS[status]}`;
}
