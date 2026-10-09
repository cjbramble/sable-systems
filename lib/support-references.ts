// Checkout stores normalized customer references; support uses the same contract.
export function parseCustomerPo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{3,39}$/.test(normalized) ? normalized : null;
}

function referenceTokens(message: string): string[] {
  return message.match(/(?<![\w-])[A-Z0-9][A-Z0-9-]*(?![\w-])/gi) ?? [];
}

export function itemReferences(message: string): string[] {
  return referenceTokens(message)
    .map((token) => token.toUpperCase())
    .filter((token) => token.startsWith('SBL-') && !/^SBL-\d{4}-/.test(token));
}

export type SupportRecordReference =
  | {
      kind: 'order';
      namespace: 'order_id' | 'customer_po' | 'unresolved';
      identifier: string;
    }
  | {
      kind: 'shipment';
      namespace: 'shipment_id' | 'tracking_reference' | 'unresolved';
      identifier: string;
    }
  | { kind: 'return'; namespace: 'return_id'; identifier: string };

export type ReferenceOccurrence = {
  reference: SupportRecordReference;
  start: number;
  end: number;
};

export type ParsedSupportReferences = {
  occurrences: ReferenceOccurrence[];
  remainder: string;
};

const ORDER_ID = /^SBL-\d{4}-[A-Z0-9-]+$/i;
const ORDER_REFERENCE =
  /^(?:SBL-\d{4}-[A-Z0-9-]+|[A-Z]{3}-(?:PO|REL)-[A-Z0-9-]+)$/i;
const SHIPMENT_ID = /^SHP-[A-Z0-9-]+$/i;
const SHIPMENT_REFERENCE = /^(?:SHP|AST)-[A-Z0-9-]+$/i;
const RETURN_ID = /^RTN-[A-Z0-9-]+$/i;
const FIELD_WORD =
  /^(?:NUMBER|REFERENCE|STATUS|PLEASE|WHAT|WHERE|WHICH|DETAILS|HISTORY|UNKNOWN|UNAVAILABLE|OR|AND|THE|YOUR)$/;

// Labels own their complete value span, even when the value is invalid. A PO
// resembling an order, shipment, or return must never change namespace later.
export function parseSupportReferences(
  message: string,
): ParsedSupportReferences {
  const occurrences: ReferenceOccurrence[] = [];
  const labeledSpans: { start: number; end: number }[] = [];
  const labels =
    /(?<![\w-])(?:(?:customer\s+)?(?:PO|purchase\s+order)(?:\s+(?:number|reference))?|tracking(?:\s+(?:reference|number|ID))?|(?:order|shipment|return)(?:\s+(?:ID|number|reference))?)(?![\w-])/gi;
  for (const label of message.matchAll(labels)) {
    const afterLabel = message.slice(label.index + label[0].length);
    const prefix =
      afterLabel.match(/^[\s*_:]*(?:is\b)?[\s#*_:"'`=([]*/i)?.[0] ?? '';
    const token = afterLabel
      .slice(prefix.length)
      .match(/^[A-Z0-9][A-Z0-9_/-]*(?![\w-])/i)?.[0];
    if (!token) continue;
    const name = label[0].toLowerCase();
    const explicitId = /\b(?:id|number)\b/.test(name);
    // Preserve the existing minimum for generic order references. Short
    // quantities such as "order 8 units" must stay available to catalog parsing.
    if (name.startsWith('order') && !explicitId && token.length < 4) continue;
    if (
      !explicitId &&
      name.startsWith('shipment') &&
      !SHIPMENT_REFERENCE.test(token)
    )
      continue;
    if (!explicitId && name.startsWith('return') && !RETURN_ID.test(token))
      continue;
    const start = label.index + label[0].length + prefix.length;
    const end = start + token.length;
    labeledSpans.push({ start, end });
    const isPo = /\b(?:po|purchase)\b/.test(name);
    const identifier = isPo
      ? parseCustomerPo(token)
      : /^[A-Z0-9][A-Z0-9-]*$/i.test(token)
        ? token.toUpperCase()
        : null;
    const markedValue = /^[\s*]*(?:[:#="'`([])/.test(afterLabel);
    if (!identifier || (!markedValue && FIELD_WORD.test(identifier))) continue;
    let reference: SupportRecordReference;
    if (isPo) {
      reference = { kind: 'order', namespace: 'customer_po', identifier };
    } else if (name.startsWith('tracking')) {
      reference = {
        kind: 'shipment',
        namespace: 'tracking_reference',
        identifier,
      };
    } else {
      // Generic labels also introduce prose such as "Return: No return
      // recorded". Plain-word values need an explicit ID/number or PO label.
      if (!explicitId && !/[-\d]/.test(identifier)) continue;
      if (name.startsWith('order'))
        reference = {
          kind: 'order',
          namespace:
            explicitId || ORDER_ID.test(identifier) ? 'order_id' : 'unresolved',
          identifier,
        };
      else if (name.startsWith('shipment'))
        reference = {
          kind: 'shipment',
          namespace:
            explicitId || SHIPMENT_ID.test(identifier)
              ? 'shipment_id'
              : 'unresolved',
          identifier,
        };
      else reference = { kind: 'return', namespace: 'return_id', identifier };
    }
    occurrences.push({ reference, start, end });
  }
  for (const token of message.matchAll(
    /(?<![\w-])[A-Z0-9][A-Z0-9-]*(?![\w-])/gi,
  )) {
    const start = token.index;
    const end = start + token[0].length;
    if (labeledSpans.some((span) => start < span.end && end > span.start))
      continue;
    const identifier = token[0].toUpperCase();
    let reference: SupportRecordReference;
    if (ORDER_REFERENCE.test(identifier))
      reference = { kind: 'order', namespace: 'unresolved', identifier };
    else if (SHIPMENT_REFERENCE.test(identifier))
      reference = { kind: 'shipment', namespace: 'unresolved', identifier };
    else if (RETURN_ID.test(identifier))
      reference = { kind: 'return', namespace: 'return_id', identifier };
    else continue;
    occurrences.push({ reference, start, end });
  }
  let remainder = message;
  // Rejected labeled values remain owned by that label. In particular, an
  // invalid PO containing a SKU cannot become a separate catalog lookup.
  for (const { start, end } of [...labeledSpans, ...occurrences].sort(
    (left, right) => right.start - left.start,
  ))
    remainder = `${remainder.slice(0, start)}${' '.repeat(end - start)}${remainder.slice(end)}`;
  return {
    occurrences: occurrences.sort((left, right) => left.start - right.start),
    remainder,
  };
}
