import type { OrderStatus } from './contracts.ts';
import { formatCurrency } from './format.ts';
import type { SupportRecordReference } from './support-references.ts';

export type OrderReference = Extract<SupportRecordReference, { kind: 'order' }>;

export type SupportOrderFacts = {
  order: {
    order_id: string;
    customer_po_number: string;
    created_on: string;
    requested_ship_date: string;
    status: OrderStatus;
    currency: string;
    order_total_cents: number;
    shipping_region: string;
    placed_by_user_id: string;
    placed_by_name: string;
  };
  items: {
    line_number: number;
    item_number: string;
    product_name_snapshot: string;
    unit_price_cents: number;
    ordered_quantity: number;
    allocated_quantity: number;
    shipped_quantity: number;
    cancelled_quantity: number;
  }[];
  shipments: {
    shipment_id: string;
    status: string;
    carrier_name: string;
    tracking_reference: string;
    shipped_on: string | null;
    estimated_delivery_date: string | null;
    delivered_on: string | null;
  }[];
  events: {
    occurred_at: string;
    event_type: string;
    customer_safe_description: string;
  }[];
  return: {
    return_id: string;
    status: string;
    reason_code: string;
    requested_on: string;
    authorized_on: string | null;
    received_on: string | null;
  } | null;
  charge: {
    status: string;
    amount_cents: number;
    currency: string;
    authorization_code: string;
    authorized_at: string;
  } | null;
};

export type VerifiedSupportReference = {
  namespace:
    | 'order_id'
    | 'customer_po'
    | 'item_number'
    | 'shipment_id'
    | 'tracking_reference'
    | 'return_id'
    | 'authorization_code';
  identifier: string;
};

export type OrderLookupOutcome = {
  kind: 'order';
  reference: OrderReference;
  scope: { customerId: string; displayName: string };
} & (
  | {
      outcome: 'found';
      facts: SupportOrderFacts;
      verifiedReferences: VerifiedSupportReference[];
    }
  | { outcome: 'unavailable' }
  | { outcome: 'ambiguous' }
);

// Only untouched lookup kinds may use the text adapter. Remove in Phase 5D
// when those lookups also carry facts and verified references explicitly.
export type SupportContextPart =
  | Exclude<OrderLookupOutcome, { outcome: 'ambiguous' }>
  | { kind: 'legacy'; records: string };

export type SupportRecordsContext = {
  kind: 'records';
  parts: SupportContextPart[];
  records: string;
};

export type SupportContextResult =
  | SupportRecordsContext
  | { kind: 'clarification'; message: string };

export function renderOrderOutcome(
  result: Exclude<OrderLookupOutcome, { outcome: 'ambiguous' }>,
): string {
  const { scope } = result;
  if (result.outcome === 'unavailable')
    return `<authorized_records>
No order matching ${result.reference.identifier} is available within ${scope.displayName}'s authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>`;

  const {
    order,
    items,
    shipments,
    events,
    return: returnRow,
    charge,
  } = result.facts;
  return `<authorized_records>
Authorization: ${scope.displayName} (${scope.customerId}) only.
Order: ${order.order_id}; customer PO: ${order.customer_po_number}; status: ${order.status}.
Placed by: ${order.placed_by_name} (${order.placed_by_user_id}).
Created: ${order.created_on}; requested ship date: ${order.requested_ship_date}; destination: ${order.shipping_region}.
Order total: ${formatCurrency(order.order_total_cents, order.currency)}.
Lines:
${items.map((item) => `- ${item.item_number} ${item.product_name_snapshot}: ordered ${item.ordered_quantity}, allocated ${item.allocated_quantity}, shipped ${item.shipped_quantity}, cancelled ${item.cancelled_quantity}; price ${formatCurrency(item.unit_price_cents, order.currency)} per unit.`).join('\n')}
Shipments:
${shipments.length ? shipments.map((shipment) => `- ${shipment.shipment_id}: ${shipment.status}; ${shipment.carrier_name}; tracking ${shipment.tracking_reference}; shipped ${shipment.shipped_on ?? 'not yet'}; estimated delivery ${shipment.estimated_delivery_date ?? 'not assigned'}; delivered ${shipment.delivered_on ?? 'not yet'}.`).join('\n') : '- No shipment record yet.'}
Recent customer-safe events:
${events.map((event) => `- ${event.occurred_at}: ${event.customer_safe_description}`).join('\n')}
Return: ${returnRow ? `${returnRow.return_id}, ${returnRow.status}, reason ${returnRow.reason_code}, requested ${returnRow.requested_on}.` : 'No return recorded.'}
Charge account: ${charge ? `${charge.status}; ${formatCurrency(charge.amount_cents, charge.currency)}; authorization ${charge.authorization_code}; ${charge.authorized_at}.` : 'No charge-account authorization recorded.'}
</authorized_records>`;
}
