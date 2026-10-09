import type { AuthenticatedUser } from './auth';
import type {
  OrderLookupOutcome,
  OrderReference,
  SupportOrderFacts,
  VerifiedSupportReference,
} from '@/lib/support-outcomes';

export async function lookupSupportOrder(
  db: D1Database,
  reference: OrderReference,
  user: AuthenticatedUser,
): Promise<OrderLookupOutcome> {
  const { identifier, namespace } = reference;
  const lookup = {
    kind: 'order' as const,
    reference,
    scope: {
      customerId: user.distributorId,
      displayName: user.distributorDisplayName,
    },
  };
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
    .all<SupportOrderFacts['order']>();
  if (matches.results.length > 1) return { ...lookup, outcome: 'ambiguous' };
  const order = matches.results[0];
  if (!order) return { ...lookup, outcome: 'unavailable' };

  const items = await db
    .prepare(`SELECT line_number, item_number, product_name_snapshot, unit_price_cents,
      ordered_quantity, allocated_quantity, shipped_quantity, cancelled_quantity
      FROM order_items WHERE order_id = ? ORDER BY line_number`)
    .bind(order.order_id)
    .all<SupportOrderFacts['items'][number]>();
  const shipments = await db
    .prepare(`SELECT shipment_id, status, carrier_name, tracking_reference, shipped_on,
      estimated_delivery_date, delivered_on
      FROM shipments WHERE order_id = ? ORDER BY shipment_id`)
    .bind(order.order_id)
    .all<SupportOrderFacts['shipments'][number]>();
  const events = await db
    .prepare(`SELECT occurred_at, event_type, customer_safe_description
      FROM order_events WHERE order_id = ? ORDER BY occurred_at DESC LIMIT 4`)
    .bind(order.order_id)
    .all<SupportOrderFacts['events'][number]>();
  const returnRow = await db
    .prepare(`SELECT return_id, status, reason_code, requested_on, authorized_on, received_on
      FROM returns WHERE order_id = ? ORDER BY requested_on DESC LIMIT 1`)
    .bind(order.order_id)
    .first<NonNullable<SupportOrderFacts['return']>>();
  const charge = await db
    .prepare(`SELECT status, amount_cents, currency, authorization_code,
      authorized_at FROM account_charges WHERE order_id = ?`)
    .bind(order.order_id)
    .first<NonNullable<SupportOrderFacts['charge']>>();

  const verifiedReferences: VerifiedSupportReference[] = [
    { namespace: 'order_id', identifier: order.order_id },
    { namespace: 'customer_po', identifier: order.customer_po_number },
    ...items.results.map((item) => ({
      namespace: 'item_number' as const,
      identifier: item.item_number,
    })),
    ...shipments.results.flatMap((shipment) => [
      { namespace: 'shipment_id' as const, identifier: shipment.shipment_id },
      {
        namespace: 'tracking_reference' as const,
        identifier: shipment.tracking_reference,
      },
    ]),
  ];
  if (returnRow)
    verifiedReferences.push({
      namespace: 'return_id',
      identifier: returnRow.return_id,
    });
  if (charge)
    verifiedReferences.push({
      namespace: 'authorization_code',
      identifier: charge.authorization_code,
    });
  return {
    ...lookup,
    outcome: 'found',
    verifiedReferences,
    facts: {
      order,
      items: items.results,
      shipments: shipments.results,
      events: events.results,
      return: returnRow,
      charge,
    },
  };
}
