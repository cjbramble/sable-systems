import {
  parseSupportReferences,
  type SupportRecordReference,
} from './support-references.ts';
import type {
  OrderReference,
  SupportRecordsContext,
  VerifiedSupportReference,
} from './support-outcomes.ts';

// Match complete hyphenated tokens, including POs such as MY-SBL-1234. Accept
// any suffix length so malformed IDs cannot evade validation by adding zeros.
const SUPPORT_IDENTIFIER_PATTERN =
  /(?<![\w-])(?:[A-Z0-9]+-)*(?:(?:SBL|SHP|RTN|AST|INC)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{3}-(?:PO|REL)-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?![\w-])/gi;

// The current context adapter uses labeled fields and two order-list formats.
// Read those fields rather than authorizing custom IDs mentioned in event prose.
function legacyRecordFields(context: string) {
  const orderIds = new Set<string>();
  const customerPos = new Set<string>();
  const legacyReferences: SupportRecordReference[] = [];
  let list: 'orders' | 'charges' | undefined;
  for (const line of context.split('\n')) {
    if (line.startsWith('Order search')) {
      list = 'orders';
      continue;
    }
    if (line === 'Recent charge-account authorizations:') {
      list = 'charges';
      continue;
    }
    if (line.startsWith('- ')) {
      const row =
        list === 'orders'
          ? /^- ([A-Z0-9-]+) \/ ([A-Z0-9-]+):/.exec(line)
          : list === 'charges'
            ? /^- ([A-Z0-9-]+):/.exec(line)
            : null;
      if (row) {
        orderIds.add(row[1].toUpperCase());
        if (row[2]) customerPos.add(row[2].toUpperCase());
      }
      continue;
    }
    list = undefined;
    if (!/^(?:Order|Shipment|Return|Customer PO):/i.test(line)) continue;
    for (const [, field, value] of line.matchAll(
      /(?:^|;)\s*(order|customer PO|shipment|tracking|return):\s*`?([A-Z0-9-]+)`?(?=[;,.]|$)/gi,
    )) {
      const identifier = value.toUpperCase();
      switch (field.toLowerCase()) {
        case 'order':
          orderIds.add(identifier);
          break;
        case 'customer po':
          customerPos.add(identifier);
          break;
        case 'shipment':
          legacyReferences.push({
            kind: 'shipment',
            namespace: 'shipment_id',
            identifier,
          });
          break;
        case 'tracking':
          legacyReferences.push({
            kind: 'shipment',
            namespace: 'tracking_reference',
            identifier,
          });
          break;
        case 'return':
          legacyReferences.push({
            kind: 'return',
            namespace: 'return_id',
            identifier,
          });
          break;
      }
    }
  }
  return { orderIds, customerPos, legacyReferences };
}

type IdentifierEvidence = {
  identifiers: Set<string>;
  orderIds: Set<string>;
  customerPos: Set<string>;
  unavailableOrders: OrderReference[];
  verifiedReferences: VerifiedSupportReference[];
  legacyIdentifiers: Set<string>;
  legacyReferences: SupportRecordReference[];
  hasTypedOrders: boolean;
};

// Compatibility for untouched record kinds and string callers only. Remove in
// Phase 5D. Never feed rendered typed-order parts into this prose adapter.
function legacyIdentifierEvidence(records: string): IdentifierEvidence {
  const identifiers = new Set(
    Array.from(records.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ),
  );
  return {
    identifiers,
    legacyIdentifiers: identifiers,
    hasTypedOrders: false,
    verifiedReferences: [],
    ...legacyRecordFields(records),
    unavailableOrders: Array.from(
      records.matchAll(/^No order matching ([A-Z0-9-]+) is available\b/gm),
      ([, identifier]) => ({
        kind: 'order',
        namespace: 'unresolved',
        identifier,
      }),
    ),
  };
}

function identifierEvidence(
  context: string | SupportRecordsContext,
): IdentifierEvidence {
  if (typeof context === 'string') return legacyIdentifierEvidence(context);
  const evidence: IdentifierEvidence = {
    identifiers: new Set(),
    orderIds: new Set(),
    customerPos: new Set(),
    unavailableOrders: [],
    verifiedReferences: [],
    legacyIdentifiers: new Set(),
    legacyReferences: [],
    hasTypedOrders: context.parts.some((part) => part.kind === 'order'),
  };
  for (const part of context.parts) {
    if (part.kind === 'legacy') {
      const legacy = legacyIdentifierEvidence(part.records);
      for (const id of legacy.identifiers) evidence.identifiers.add(id);
      for (const id of legacy.orderIds) evidence.orderIds.add(id);
      for (const id of legacy.customerPos) evidence.customerPos.add(id);
      evidence.unavailableOrders.push(...legacy.unavailableOrders);
      for (const id of legacy.identifiers) evidence.legacyIdentifiers.add(id);
      evidence.legacyReferences.push(...legacy.legacyReferences);
    } else if (part.outcome === 'unavailable') {
      // Echoing the requested reference does not verify a record's existence.
      evidence.unavailableOrders.push(part.reference);
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
  context: string | SupportRecordsContext,
): boolean {
  const evidence = identifierEvidence(context);
  const { identifiers, orderIds, customerPos, unavailableOrders } = evidence;
  return (
    parseSupportReferences(content).occurrences.every(({ reference }) => {
      const { identifier, namespace } = reference;
      if (reference.kind !== 'order') {
        if (!evidence.hasTypedOrders) return true;
        // A requested order/PO cannot authorize a shipment or return. Legacy
        // parts retain their own evidence until their migration in Phase 5D.
        return (
          evidence.legacyIdentifiers.has(identifier) ||
          evidence.legacyReferences.some(
            (legacy) =>
              legacy.kind === reference.kind &&
              legacy.identifier === identifier &&
              (legacy.namespace === 'unresolved' ||
                namespace === 'unresolved' ||
                legacy.namespace === namespace),
          ) ||
          evidence.verifiedReferences.some(
            (verified) =>
              verified.identifier.toUpperCase() === identifier &&
              (namespace === 'unresolved'
                ? verified.namespace === 'shipment_id' ||
                  verified.namespace === 'tracking_reference'
                : verified.namespace === namespace),
          )
        );
      }
      if (
        unavailableOrders.some(
          (requested) =>
            requested.identifier === identifier &&
            (requested.namespace === 'unresolved' ||
              namespace === 'unresolved' ||
              requested.namespace === namespace),
        )
      )
        return true;
      if (namespace === 'order_id') return orderIds.has(identifier);
      if (namespace === 'customer_po') return customerPos.has(identifier);
      return (
        orderIds.has(identifier) ||
        customerPos.has(identifier) ||
        identifiers.has(identifier)
      );
    }) &&
    Array.from(content.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ).every((id) => identifiers.has(id))
  );
}

const UNAVAILABLE_RECORD =
  /^<authorized_records>\nNo (order|shipment|return) matching ([A-Z0-9-]+) is available within (.+)'s authorization scope\./;
const UNAVAILABLE_RECORD_NEXT_STEP = {
  order: 'verify the order ID or provide an account PO number',
  shipment: 'verify the shipment ID or tracking reference',
  return: 'verify the return ID',
} as const;

// A lookup with no authorized match is answered by the server with the fixed
// scope sentence, so the reply cannot hint at other accounts or their records.
export function unavailableRecordReply(
  context: string | SupportRecordsContext,
): string | null {
  if (typeof context !== 'string') {
    if (context.parts.length !== 1) return null;
    const part = context.parts[0];
    if (part.kind === 'order')
      return part.outcome === 'unavailable'
        ? `I cannot locate ${part.reference.identifier} within ${part.scope.displayName}'s authorization scope. Please ${UNAVAILABLE_RECORD_NEXT_STEP.order}.`
        : null;
    // Legacy shipment/return missing replies migrate with their facts in 5D.
    return unavailableRecordReply(part.records);
  }
  const match = UNAVAILABLE_RECORD.exec(context);
  if (!match) return null;
  const [, kind, identifier, distributor] = match;
  const nextStep =
    UNAVAILABLE_RECORD_NEXT_STEP[
      kind as keyof typeof UNAVAILABLE_RECORD_NEXT_STEP
    ];
  return `I cannot locate ${identifier} within ${distributor}'s authorization scope. Please ${nextStep}.`;
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
