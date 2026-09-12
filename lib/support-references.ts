// Checkout stores normalized customer references; support uses the same contract.
export function parseCustomerPo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{3,39}$/.test(normalized) ? normalized : null;
}

export function referenceTokens(message: string): string[] {
  return message.match(/(?<![\w-])[A-Z0-9][A-Z0-9-]*(?![\w-])/gi) ?? [];
}

export function itemReferences(message: string): string[] {
  return referenceTokens(message)
    .map((token) => token.toUpperCase())
    .filter((token) => token.startsWith('SBL-') && !/^SBL-\d{4}-/.test(token));
}

export function explicitCustomerPos(message: string): string[] {
  const references: string[] = [];
  for (const label of message.matchAll(
    /(?<![\w-])(?:customer\s+)?(?:PO|purchase order)(?![\w-])/gi,
  )) {
    const afterLabel = message.slice(label.index + label[0].length);
    // A delimiter or quote makes even a word such as STATUS an explicit value.
    const markedValue = /^[\s*]*(?:[:#="'`])/.test(afterLabel);
    const suffix = (
      markedValue
        ? afterLabel
        : afterLabel.replace(/^\s*\b(?:number|reference)\b/i, '')
    ).replace(/^[\s*_:]*(?:is\b)?[\s#*_:"'`=]*/i, '');
    const token = suffix.match(/^[A-Z0-9][A-Z0-9-]*(?![\w-])/i)?.[0];
    const reference = parseCustomerPo(token);
    // A question about the field itself is not a lookup of an ordinary word.
    if (
      reference &&
      (markedValue ||
        !/^(?:NUMBER|REFERENCE|STATUS|PLEASE|WHAT|WHERE|WHICH|DETAILS|HISTORY|UNKNOWN|UNAVAILABLE)$/.test(
          reference,
        ))
    )
      references.push(reference);
  }
  return references;
}

export function explicitOrderPo(message: string): string | undefined {
  const labeled = explicitCustomerPos(message)[0];
  if (labeled) return labeled;
  // Unlabeled "find order ..." needs a distinctive identifier, not "order status".
  const token = message.match(
    /\border\s+[#"'`]*([A-Z0-9][A-Z0-9-]*)(?![\w-])/i,
  )?.[1];
  return token && /[-\d]/.test(token)
    ? (parseCustomerPo(token) ?? undefined)
    : undefined;
}
