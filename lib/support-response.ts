import {
  parseSupportReferences,
  itemReferences,
  type SupportRecordReference,
} from './support-references.ts';
import type {
  SupportRecordsContext,
  VerifiedSupportReference,
} from './support-outcomes.ts';

// Match complete hyphenated tokens, including POs such as MY-SBL-1234. Accept
// any suffix length so malformed IDs cannot evade validation by adding zeros.
const SUPPORT_IDENTIFIER_PATTERN =
  /(?<![\w-])(?:[A-Z0-9]+-)*(?:(?:SBL|SHP|RTN|AST|INC|ACC)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{3}-(?:PO|REL)-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?![\w-])/gi;

type IdentifierEvidence = {
  identifiers: Set<string>;
  orderIds: Set<string>;
  customerPos: Set<string>;
  echoReferences: SupportRecordReference[];
  verifiedReferences: VerifiedSupportReference[];
};

function identifierEvidence(
  context: SupportRecordsContext,
): IdentifierEvidence {
  const evidence: IdentifierEvidence = {
    identifiers: new Set(),
    orderIds: new Set(),
    customerPos: new Set(),
    echoReferences: [],
    verifiedReferences: [],
  };
  for (const part of context.parts) {
    if (part.kind === 'omitted_requests') {
      for (const request of part.requests) {
        if ('identifier' in request) {
          evidence.echoReferences.push(request);
          evidence.identifiers.add(request.identifier.toUpperCase());
        } else if ('message' in request) {
          for (const item of itemReferences(request.message))
            evidence.identifiers.add(item.toUpperCase());
        }
      }
    } else if (
      part.kind === 'unknown_products' ||
      part.kind === 'omitted_products'
    ) {
      // Missing and omitted items are echo allowances, not verified identities.
      for (const itemNumber of part.requestedItemNumbers)
        evidence.identifiers.add(itemNumber.toUpperCase());
    } else if (part.outcome === 'unavailable') {
      // Echoing the requested reference does not verify a record's existence.
      evidence.echoReferences.push(part.reference);
      evidence.identifiers.add(part.reference.identifier.toUpperCase());
    } else {
      evidence.verifiedReferences.push(...part.verifiedReferences);
      for (const reference of part.verifiedReferences) {
        const id = reference.identifier.toUpperCase();
        evidence.identifiers.add(id);
        if (reference.namespace === 'order_id') evidence.orderIds.add(id);
        if (reference.namespace === 'customer_po') evidence.customerPos.add(id);
      }
    }
  }
  return evidence;
}

export function hasGroundedSupportIdentifiers(
  content: string,
  context: SupportRecordsContext,
): boolean {
  const evidence = identifierEvidence(context);
  const { identifiers, orderIds, customerPos, echoReferences } = evidence;
  const { occurrences } = parseSupportReferences(content, identifiers);
  return (
    occurrences.every(({ reference }) => {
      const { identifier, namespace } = reference;
      if (
        echoReferences.some(
          (requested) =>
            requested.kind === reference.kind &&
            requested.identifier === identifier &&
            (requested.namespace === 'unresolved' ||
              namespace === 'unresolved' ||
              requested.namespace === namespace),
        )
      )
        return true;
      if (reference.kind !== 'order')
        return evidence.verifiedReferences.some(
          (verified) =>
            verified.identifier.toUpperCase() === identifier &&
            (namespace === 'unresolved'
              ? verified.namespace === 'shipment_id' ||
                verified.namespace === 'tracking_reference'
              : verified.namespace === namespace),
        );
      if (namespace === 'order_id') return orderIds.has(identifier);
      if (namespace === 'customer_po') return customerPos.has(identifier);
      return orderIds.has(identifier) || customerPos.has(identifier);
    }) &&
    Array.from(content.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ).every((id) => identifiers.has(id))
  );
}

const UNAVAILABLE_RECORD_NEXT_STEP = {
  order: 'verify the order ID or provide an account PO number',
  shipment: 'verify the shipment ID or tracking reference',
  return: 'verify the return ID',
} as const;

// A lookup with no authorized match is answered by the server with the fixed
// scope sentence, so the reply cannot hint at other accounts or their records.
export function unavailableRecordReply(
  context: SupportRecordsContext,
): string | null {
  if (context.parts.length !== 1) return null;
  const part = context.parts[0];
  if (part.kind === 'unknown_products' || part.outcome !== 'unavailable')
    return null;
  return `I cannot locate ${part.reference.identifier} within ${part.scope.displayName}'s authorization scope. Please ${UNAVAILABLE_RECORD_NEXT_STEP[part.kind]}.`;
}
