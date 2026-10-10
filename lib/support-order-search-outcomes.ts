import { formatCurrency } from './format';
import type { OrderStatus } from './contracts';
import type { VerifiedSupportReference } from './support-outcomes';
import type { SupportOrderStatusFilter } from './support-order-status';
import type { SupportProduct } from './support-product-outcomes';

export type OrderSearchCriteria = {
  statusFilter?: Extract<SupportOrderStatusFilter, { kind: 'filter' }>;
  year?: number;
  yearField?: 'created' | 'requested';
  product?: Pick<SupportProduct, 'item_number' | 'product_name'>;
};

export type SupportOrderSearchRow = {
  order_id: string;
  customer_po_number: string;
  created_on: string;
  requested_ship_date: string;
  status: OrderStatus;
  order_total_cents: number;
  currency: string;
};

export type OrderSearchOutcome = {
  kind: 'order_search';
  outcome: 'found';
  scope: { customerId: string; displayName: string };
  criteria: OrderSearchCriteria;
  facts: { total: number; orders: SupportOrderSearchRow[] };
  verifiedReferences: VerifiedSupportReference[];
};

export function renderOrderSearchOutcome(result: OrderSearchOutcome): string {
  const {
    scope,
    facts: { total, orders },
  } = result;
  const { statusFilter, year, yearField, product } = result.criteria;
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
Authorization: ${scope.displayName} (${scope.customerId}) only.
Order search${criteria.length ? ` for ${criteria.join(', ')}` : ''}: ${total} matching ${total === 1 ? 'order' : 'orders'}${total === 0 ? '.' : orders.length < total ? `; listing the ${orders.length} most recent.` : `; listing all ${total}.`}
${orders.map((row) => `- ${row.order_id} / ${row.customer_po_number}: ${row.status}; created ${row.created_on}; requested ${row.requested_ship_date}; ${formatCurrency(row.order_total_cents, row.currency)}.`).join('\n') || '- No matching orders.'}
</authorized_records>`;
}
