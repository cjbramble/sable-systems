import type { AuthenticatedUser } from './auth';
import type {
  ShipmentReference,
  ShipmentLookupOutcome,
  SupportShipmentFacts,
} from '@/lib/support-outcomes';

export async function lookupSupportShipment(
  db: D1Database,
  reference: ShipmentReference,
  user: AuthenticatedUser,
): Promise<ShipmentLookupOutcome> {
  const { identifier, namespace } = reference;
  const lookup = {
    kind: 'shipment' as const,
    reference,
    scope: {
      customerId: user.distributorId,
      displayName: user.distributorDisplayName,
    },
  };
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
    .all<SupportShipmentFacts['shipment']>();
  if (matches.results.length > 1) return { ...lookup, outcome: 'ambiguous' };
  const shipment = matches.results[0];
  if (!shipment) return { ...lookup, outcome: 'unavailable' };
  return {
    ...lookup,
    outcome: 'found',
    facts: { shipment },
    verifiedReferences: [
      { namespace: 'shipment_id', identifier: shipment.shipment_id },
      {
        namespace: 'tracking_reference',
        identifier: shipment.tracking_reference,
      },
      { namespace: 'order_id', identifier: shipment.order_id },
      { namespace: 'customer_po', identifier: shipment.customer_po_number },
    ],
  };
}
