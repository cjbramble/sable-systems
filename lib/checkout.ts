import type {
  CheckoutFailure,
  CheckoutInput,
  CheckoutReceipt,
} from './contracts';
import { parseCustomerPo } from './support-references';
import { parseSessionSubject } from './session-subject';

const commandIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Date parsing can normalize impossible days into the following month.
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseCheckoutInput(value: unknown): CheckoutInput | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const commandId =
    typeof candidate.commandId === 'string'
      ? candidate.commandId.toLowerCase()
      : '';
  const expectedSubject = parseSessionSubject(candidate.expectedSubject);
  const customerPoNumber = parseCustomerPo(candidate.customerPoNumber);
  const requestedShipDate =
    typeof candidate.requestedShipDate === 'string'
      ? candidate.requestedShipDate.trim()
      : '';
  const shippingRegion =
    typeof candidate.shippingRegion === 'string'
      ? candidate.shippingRegion.trim()
      : '';
  if (
    !commandIdPattern.test(commandId) ||
    !expectedSubject ||
    !customerPoNumber ||
    !isCalendarDate(requestedShipDate) ||
    shippingRegion.length < 3 ||
    shippingRegion.length > 80 ||
    !Array.isArray(candidate.items) ||
    candidate.items.length === 0 ||
    candidate.items.length > 20
  )
    return null;

  const items: CheckoutInput['items'] = [];
  const seen = new Set<string>();
  for (const rawLine of candidate.items) {
    if (!rawLine || typeof rawLine !== 'object') return null;
    const line = rawLine as Record<string, unknown>;
    if (
      typeof line.itemNumber !== 'string' ||
      !line.itemNumber.trim() ||
      line.itemNumber.length > 128 ||
      !Number.isInteger(line.quantity) ||
      Number(line.quantity) <= 0 ||
      Number(line.quantity) > 100_000 ||
      !Number.isSafeInteger(line.expectedUnitPriceCents) ||
      Number(line.expectedUnitPriceCents) < 0 ||
      seen.has(line.itemNumber)
    )
      return null;
    seen.add(line.itemNumber);
    items.push({
      itemNumber: line.itemNumber,
      quantity: Number(line.quantity),
      expectedUnitPriceCents: Number(line.expectedUnitPriceCents),
    });
  }
  return {
    commandId,
    expectedSubject,
    customerPoNumber,
    requestedShipDate,
    shippingRegion,
    items,
  };
}

export function parseCheckoutReceipt(
  value: unknown,
  commandId: string,
): CheckoutReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.commandId !== commandId ||
    !commandIdPattern.test(commandId) ||
    typeof receipt.orderId !== 'string' ||
    !/^SBL-\d{4}-\d{6}$/.test(receipt.orderId) ||
    typeof receipt.chargeId !== 'string' ||
    !/^CHG-[A-F0-9]{8}-[A-F0-9]{3}$/.test(receipt.chargeId) ||
    typeof receipt.authorizationCode !== 'string' ||
    !/^ACC-[A-F0-9]{8}$/.test(receipt.authorizationCode) ||
    typeof receipt.totalCents !== 'number' ||
    !Number.isSafeInteger(receipt.totalCents) ||
    receipt.totalCents < 0 ||
    typeof receipt.currency !== 'string' ||
    !/^[A-Z]{3}$/i.test(receipt.currency) ||
    typeof receipt.requestedShipDate !== 'string' ||
    !isCalendarDate(receipt.requestedShipDate)
  )
    return null;
  return {
    commandId,
    orderId: receipt.orderId,
    chargeId: receipt.chargeId,
    authorizationCode: receipt.authorizationCode,
    totalCents: receipt.totalCents,
    currency: receipt.currency,
    requestedShipDate: receipt.requestedShipDate,
  };
}

export function parseCheckoutFailure(value: unknown): CheckoutFailure | null {
  if (!value || typeof value !== 'object') return null;
  const { error, code } = value as Record<string, unknown>;
  if (typeof error !== 'string' || !error.trim() || error.length > 1000)
    return null;
  if (code === undefined) return { error };
  if (
    code === 'account_changed' ||
    code === 'price_changed' ||
    code === 'command_conflict'
  )
    return { error, code };
  return null;
}
