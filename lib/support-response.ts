import { explicitCustomerPos, explicitOrderPo } from './support-references.ts';

// Accept any suffix length so malformed IDs (including extra zeros) are checked,
// not silently ignored by a regex that only recognizes valid database formats.
const SUPPORT_IDENTIFIER_PATTERN =
  /\b(?:(?:SBL|SHP|RTN|AST|INC)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{3}-(?:PO|REL)-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/gi;

export function hasGroundedSupportIdentifiers(
  content: string,
  authorizedContext: string,
): boolean {
  const authorizedIdentifiers = new Set(
    Array.from(authorizedContext.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ),
  );
  // Plain-word POs must be present as references, not merely as prose somewhere
  // in the context. Unresolved inquiries may be echoed without claiming a match.
  const authorizedReferences = new Set([
    ...authorizedIdentifiers,
    ...explicitCustomerPos(authorizedContext),
    ...Array.from(
      authorizedContext.matchAll(
        /\bNo order matching ([A-Z0-9-]+) is available\b/g,
      ),
      ([, reference]) => reference,
    ),
  ]);
  const orderPo = explicitOrderPo(content);
  return (
    (!orderPo || authorizedReferences.has(orderPo)) &&
    explicitCustomerPos(content).every((po) => authorizedReferences.has(po)) &&
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
