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
    Array.from(
      authorizedContext.matchAll(SUPPORT_IDENTIFIER_PATTERN),
      ([id]) => id,
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
      ([id]) => id,
    ).every((id) => authorizedIdentifiers.has(id))
  );
}
