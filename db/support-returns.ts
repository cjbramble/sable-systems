import type { AuthenticatedUser } from './auth';
import type {
  ReturnReference,
  ReturnLookupOutcome,
  SupportReturnFacts,
} from '@/lib/support-outcomes';

export async function lookupSupportReturn(
  db: D1Database,
  reference: ReturnReference,
  user: AuthenticatedUser,
): Promise<ReturnLookupOutcome> {
  const { identifier } = reference;
  const lookup = {
    kind: 'return' as const,
    reference,
    scope: {
      customerId: user.distributorId,
      displayName: user.distributorDisplayName,
    },
  };
  const returnRow = await db
    .prepare(`SELECT r.return_id, r.status, r.reason_code, r.requested_on,
      r.authorized_on, r.received_on, o.order_id, o.customer_po_number
      FROM returns r
      JOIN orders o ON o.order_id = r.order_id
      WHERE o.customer_id = ? AND r.return_id = ?`)
    .bind(user.distributorId, identifier)
    .first<SupportReturnFacts['return']>();
  if (!returnRow) return { ...lookup, outcome: 'unavailable' };

  const items = await db
    .prepare(`SELECT ri.line_number, ri.return_quantity, ri.disposition,
      oi.item_number, oi.product_name_snapshot
      FROM return_items ri
      JOIN order_items oi
        ON oi.order_id = ri.order_id AND oi.line_number = ri.line_number
      WHERE ri.return_id = ? AND ri.order_id = ? ORDER BY ri.line_number`)
    .bind(identifier, returnRow.order_id)
    .all<SupportReturnFacts['items'][number]>();
  return {
    ...lookup,
    outcome: 'found',
    facts: { return: returnRow, items: items.results },
    verifiedReferences: [
      { namespace: 'return_id', identifier: returnRow.return_id },
      { namespace: 'order_id', identifier: returnRow.order_id },
      { namespace: 'customer_po', identifier: returnRow.customer_po_number },
      ...items.results.map((item) => ({
        namespace: 'item_number' as const,
        identifier: item.item_number,
      })),
    ],
  };
}
