import {
  parseSupportReferences,
  itemReferences,
  type SupportRecordReference,
} from './support-references.ts';
import type { QuantityUnits } from './support-quantities.ts';
import type {
  SupportRecordsContext,
  VerifiedSupportReference,
} from './support-outcomes.ts';

// Match complete hyphenated tokens, including POs such as MY-SBL-1234. Accept
// any suffix length so malformed IDs cannot evade validation by adding zeros.
const SUPPORT_IDENTIFIER_PATTERN =
  /(?<![\w-])(?:[A-Z0-9]+-)*(?:(?:SBL|SHP|RTN|AST|INC|ACC)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{3}-(?:PO|REL)-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?![\w-])/gi;

// Dash look-alikes and invisible characters can disguise an identifier.
const DASH_LOOKALIKES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

// Any code next to a reference word must be a verified record identifier:
// the prompt forbids invented confirmations, refunds, and cases, and their
// formats are open-ended. A dotted or slashed number ("10/09/2026") is a date
// or amount, not a code.
const REFERENCE_WORD_ID =
  /\b(?:confirmation|refund|credit|rma|ticket|case|claim|receipt|invoice|reference)(?:\s+(number|no\.?|id|code|reference|ref))?\s*(?:is\s+)?([:#])?\s*["'`(*]*([A-Za-z0-9][A-Za-z0-9-]*)(?![\w-]|[/.]\d)/gi;
const NOT_A_CODE = new Set(['SABLE', 'COV-E']);

// Codes with digits always count. An all-caps word counts only after an
// explicit "number", "code", "ID", or "#", so "for reference: SABLE" passes.
function referenceCodes(text: string): string[] {
  return Array.from(text.matchAll(REFERENCE_WORD_ID)).flatMap(
    ([, label, marker, token]) => {
      const code = token.toUpperCase();
      if (/\d/.test(token))
        return /^\d{4}-\d{2}-\d{2}$/.test(token) ? [] : [code];
      const explicit = label !== undefined || marker === '#';
      return explicit &&
        /^[A-Z][A-Z-]{3,}$/.test(token) &&
        !NOT_A_CODE.has(code)
        ? [code]
        : [];
    },
  );
}

function normalizeIdentifierText(content: string) {
  return content.replace(INVISIBLE, '').replace(DASH_LOOKALIKES, '-');
}

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

// `units` are the catalog's quantity nouns, so "order 1000 cells" in a reply
// is a quantity, as it is in the customer's question.
export function hasGroundedSupportIdentifiers(
  content: string,
  context: SupportRecordsContext,
  units?: QuantityUnits,
): boolean {
  const evidence = identifierEvidence(context);
  const text = normalizeIdentifierText(content);
  const { identifiers, orderIds, customerPos, echoReferences } = evidence;
  const { occurrences } = parseSupportReferences(text, identifiers, units);
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
    Array.from(text.matchAll(SUPPORT_IDENTIFIER_PATTERN), ([id]) =>
      id.toUpperCase(),
    ).every((id) => identifiers.has(id)) &&
    // Products and echoed requests are not records, so they can't stand in
    // for a refund, case, or confirmation.
    referenceCodes(text).every((code) =>
      evidence.verifiedReferences.some(
        (verified) =>
          verified.namespace !== 'item_number' &&
          verified.identifier.toUpperCase() === code,
      ),
    )
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
