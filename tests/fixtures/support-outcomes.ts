import type { OrderSearchOutcome } from '@/lib/support-order-search-outcomes';
import type {
  ShipmentLookupOutcome,
  ReturnLookupOutcome,
  SupportContextPart,
  SupportRecordsContext,
} from '@/lib/support-outcomes';

// Independently authored identities: fixtures never recover evidence from prompt text.
const scope = {
  customerId: 'WHS-0427',
  displayName: 'Calder Pike Distribution',
};

export function orderSearchOutcome(
  orderId: string,
  customerPo: string,
): OrderSearchOutcome {
  return {
    kind: 'order_search',
    outcome: 'found',
    scope,
    criteria: {},
    facts: {
      total: 1,
      orders: [
        {
          order_id: orderId,
          customer_po_number: customerPo,
          created_on: '2026-01-01',
          requested_ship_date: '2026-01-02',
          status: 'delivered',
          order_total_cents: 100,
          currency: 'USD',
        },
      ],
    },
    verifiedReferences: [
      { namespace: 'order_id', identifier: orderId },
      { namespace: 'customer_po', identifier: customerPo },
    ],
  };
}

export function shipmentOutcome(
  shipmentId: string,
  tracking: string,
): Extract<ShipmentLookupOutcome, { outcome: 'found' }> {
  return {
    kind: 'shipment',
    outcome: 'found',
    scope,
    reference: {
      kind: 'shipment',
      namespace: 'shipment_id',
      identifier: shipmentId,
    },
    facts: {
      shipment: {
        shipment_id: shipmentId,
        tracking_reference: tracking,
        order_id: 'SBL-2022-000118',
        customer_po_number: 'CPD-PO-220118',
        status: 'delivered',
        carrier_name: 'Fixture carrier',
        shipped_on: '2026-01-01',
        estimated_delivery_date: '2026-01-02',
        delivered_on: '2026-01-02',
      },
    },
    verifiedReferences: [
      { namespace: 'shipment_id', identifier: shipmentId },
      { namespace: 'tracking_reference', identifier: tracking },
      { namespace: 'order_id', identifier: 'SBL-2022-000118' },
      { namespace: 'customer_po', identifier: 'CPD-PO-220118' },
    ],
  };
}

export function returnOutcome(returnId: string): ReturnLookupOutcome {
  return {
    kind: 'return',
    outcome: 'found',
    scope,
    reference: { kind: 'return', namespace: 'return_id', identifier: returnId },
    facts: {
      return: {
        return_id: returnId,
        order_id: 'SBL-2022-000118',
        customer_po_number: 'CPD-PO-220118',
        status: 'received',
        reason_code: 'fixture',
        requested_on: '2026-01-03',
        authorized_on: '2026-01-04',
        received_on: '2026-01-05',
      },
      items: [],
    },
    verifiedReferences: [
      { namespace: 'return_id', identifier: returnId },
      { namespace: 'order_id', identifier: 'SBL-2022-000118' },
      { namespace: 'customer_po', identifier: 'CPD-PO-220118' },
    ],
  };
}

export function supportRecords(
  parts: SupportContextPart[],
  records = '',
): SupportRecordsContext {
  return { kind: 'records', parts, records };
}
