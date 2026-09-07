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
  return Array.from(
    content.matchAll(SUPPORT_IDENTIFIER_PATTERN),
    ([id]) => id,
  ).every((id) => authorizedIdentifiers.has(id));
}
