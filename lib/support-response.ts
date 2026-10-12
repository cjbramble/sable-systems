import {
  parseSupportReferences,
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
  unavailableReferences: SupportRecordReference[];
  verifiedReferences: VerifiedSupportReference[];
};

function identifierEvidence(
  context: SupportRecordsContext,
): IdentifierEvidence {
  const evidence: IdentifierEvidence = {
    identifiers: new Set(),
    orderIds: new Set(),
    customerPos: new Set(),
    unavailableReferences: [],
    verifiedReferences: [],
  };
  for (const part of context.parts) {
    if (part.kind === 'unknown_products' || part.kind === 'omitted_products') {
      // Missing and omitted items are echo allowances, not verified identities.
      for (const itemNumber of part.requestedItemNumbers)
        evidence.identifiers.add(itemNumber.toUpperCase());
    } else if (part.outcome === 'unavailable') {
      // Echoing the requested reference does not verify a record's existence.
      evidence.unavailableReferences.push(part.reference);
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
  const { identifiers, orderIds, customerPos, unavailableReferences } =
    evidence;
  const { occurrences } = parseSupportReferences(content, identifiers);
  return (
    occurrences.every(({ reference }) => {
      const { identifier, namespace } = reference;
      if (
        unavailableReferences.some(
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

const SABLE_RESOURCE_WORD =
  '(?:divisions?|departments?|teams?|manuals?|handbooks?|guidelines?|hotlines?|help ?desks?|polic(?:y|ies)|procedures?|technicians?|engineers?|specialists?|representatives?|contacts?|liaisons?)';
// A resource attributed to SABLE or COV-E ("SABLE Systems' Medical Operations
// Division"), or claimed to be in the records. Outside references such as a
// qualified professional or medical guidelines are not attributed this way.
const SABLE_RESOURCE_CLAIMS = [
  new RegExp(
    `\\b(?:SABLE(?:\\s+Systems)?|COV-E)(?:['’]s?)?(?:-authorized|-certified)?\\s+((?:[\\w-]+\\s+){0,4}?${SABLE_RESOURCE_WORD})\\b`,
    'gi',
  ),
  new RegExp(
    `\\brecords\\b[^.!?\\n]{0,60}\\b(${SABLE_RESOURCE_WORD})\\b`,
    'gi',
  ),
];

function resourceName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(?:the|official|authorized|certified)\s+/g, '')
    .replace(new RegExp(`\\b${SABLE_RESOURCE_WORD}\\b`, 'g'), (word) =>
      word === 'policies' ? 'policy' : word.replace(/s$/, ''),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

// Like unverified identifiers, a SABLE resource the records do not name is
// invented, so the reply must not be returned or saved. The phrases are used to
// tell the model what to remove on a corrective retry.
export function unsupportedSableResources(
  content: string,
  authorizedContext: string,
) {
  const records = resourceName(authorizedContext);
  const phrases: string[] = [];
  for (const pattern of SABLE_RESOURCE_CLAIMS)
    for (const [phrase, resource] of content.matchAll(pattern))
      if (
        !records.includes(resourceName(resource)) &&
        !phrases.includes(phrase)
      )
        phrases.push(phrase);
  return phrases;
}

export function hasUnsupportedSableResource(
  content: string,
  authorizedContext: string,
) {
  return unsupportedSableResources(content, authorizedContext).length > 0;
}
