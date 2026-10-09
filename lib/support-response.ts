import { parseSupportReferences } from './support-references.ts';

// Accept any suffix length so malformed IDs (including extra zeros) are checked,
// not silently ignored by a regex that only recognizes valid database formats.
const SUPPORT_IDENTIFIER_PATTERN =
  /\b(?:(?:SBL|SHP|RTN|AST|INC)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{3}-(?:PO|REL)-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/gi;

// The current context adapter uses labeled fields and two order-list formats.
// Read those fields rather than authorizing custom IDs mentioned in event prose.
function authorizedOrderReferences(context: string) {
  const orderIds = new Set<string>();
  const customerPos = new Set<string>();
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
    for (const [, field, identifier] of line.matchAll(
      /(?:^|;)\s*(order|customer PO):\s*`?([A-Z0-9-]+)`?(?=[;.]|$)/gi,
    ))
      (field.toLowerCase() === 'order' ? orderIds : customerPos).add(
        identifier.toUpperCase(),
      );
  }
  return { orderIds, customerPos };
}

export function hasGroundedSupportIdentifiers(
  content: string,
  authorizedContext: string,
): boolean {
  const authorizedIdentifiers = new Set(
    Array.from(authorizedContext.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ),
  );
  const { orderIds, customerPos } =
    authorizedOrderReferences(authorizedContext);
  // Unresolved inquiries may still be echoed without claiming a match. The
  // prose adapter does not retain the namespace of an unavailable reference.
  const unavailableOrders = new Set(
    Array.from(
      authorizedContext.matchAll(
        /^No order matching ([A-Z0-9-]+) is available\b/gm,
      ),
      ([, identifier]) => identifier,
    ),
  );
  return (
    parseSupportReferences(content).occurrences.every(({ reference }) => {
      if (reference.kind !== 'order') return true;
      const { identifier, namespace } = reference;
      if (unavailableOrders.has(identifier)) return true;
      if (namespace === 'order_id') return orderIds.has(identifier);
      if (namespace === 'customer_po') return customerPos.has(identifier);
      return (
        orderIds.has(identifier) ||
        customerPos.has(identifier) ||
        authorizedIdentifiers.has(identifier)
      );
    }) &&
    Array.from(
      content.matchAll(SUPPORT_IDENTIFIER_PATTERN),
      // Record IDs are uppercase; a model may echo a customer's lowercase form.
      ([id]) => id.toUpperCase(),
    ).every((id) => authorizedIdentifiers.has(id))
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
export function unavailableRecordReply(authorizedContext: string) {
  const match = UNAVAILABLE_RECORD.exec(authorizedContext);
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
