import { itemReferences } from './support-references.ts';
import type { SupportQueryIntent } from './support-query.ts';

export type OmittedRequestsOutcome = {
  kind: 'omitted_requests';
  outcome: 'omitted';
  requests: SupportQueryIntent[];
  limit: number;
};

const REFERENCE_NAMESPACE_LABELS = {
  order_id: 'order ID',
  customer_po: 'customer PO',
  shipment_id: 'shipment ID',
  tracking_reference: 'tracking reference',
  return_id: 'return ID',
};

export function supportRequestLabel(intent: SupportQueryIntent): string {
  switch (intent.kind) {
    case 'orders':
      return 'order search';
    case 'account':
      return 'account details';
    case 'catalog':
      return 'catalog request';
    case 'incidents':
      return 'incident history';
    case 'summary':
      return 'account summary';
    case 'clarification':
      return `${intent.entity} clarification`;
    default: {
      const namespace =
        intent.namespace === 'unresolved'
          ? ''
          : ` (${REFERENCE_NAMESPACE_LABELS[intent.namespace]})`;
      return `${intent.kind} ${intent.identifier}${namespace}`;
    }
  }
}

export function renderOmittedRequests(outcome: OmittedRequestsOutcome): string {
  const requests = outcome.requests.map((request, index) => {
    // Request prose is untrusted and must not become resource evidence.
    const items = 'message' in request ? itemReferences(request.message) : [];
    const details = items.length ? ` (items: ${items.join(', ')})` : '';
    return `Part ${outcome.limit + index + 1}: ${supportRequestLabel(request)}${details}`;
  });
  return `Request parts not answered because of the limit of ${outcome.limit} parts per message:\n${requests.join('\n')}\nTell the customer these parts were omitted and ask them to request these parts separately. These parts were not looked up. Do not claim they are missing or infer their status, availability, price, or other facts.`;
}
