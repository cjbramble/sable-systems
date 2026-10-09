import { describe, expect, it } from 'vitest';

import {
  parseCheckoutFailure,
  parseCheckoutInput,
  parseCheckoutReceipt,
} from '@/lib/checkout';

const commandId = '32809452-79df-4c50-8d6b-9a23f5823984';
const checkout = {
  commandId,
  expectedSubject: { userId: 'USR-MCS-001', customerId: 'WHS-1098' },
  customerPoNumber: 'MCS-RECOVERY',
  requestedShipDate: '2031-01-01',
  shippingRegion: 'Great Lakes District',
  items: [
    { itemNumber: 'SBL-RPC-12', quantity: 8, expectedUnitPriceCents: 68000 },
  ],
};
const receipt = {
  commandId,
  orderId: 'SBL-2026-899900',
  chargeId: 'CHG-12345678-ABC',
  authorizationCode: 'ACC-12345678',
  totalCents: 544000,
  currency: 'USD',
  requestedShipDate: '2031-01-01',
};

describe('checkout command parsing', () => {
  it.each([undefined, null, '', 'not-a-uuid', 'x'.repeat(100)])(
    'rejects an invalid command ID: %s',
    (commandId) => {
      expect(parseCheckoutInput({ ...checkout, commandId })).toBeNull();
    },
  );
  it('normalizes intent fields without retaining extra client data', () => {
    expect(
      parseCheckoutInput({
        ...checkout,
        commandId: commandId.toUpperCase(),
        customerPoNumber: ' mcs-recovery ',
        requestedShipDate: ' 2031-01-01 ',
        shippingRegion: ' Great Lakes District ',
        totalCents: 1,
      }),
    ).toEqual(checkout);
  });
  it.for([
    [],
    [{ ...checkout.items[0], quantity: -8 }],
    [{ ...checkout.items[0], quantity: 1.5 }],
    [checkout.items[0], checkout.items[0]],
  ])('rejects invalid line collections', (items) => {
    expect(parseCheckoutInput({ ...checkout, items })).toBeNull();
  });
});

describe('checkout receipt decoding', () => {
  it.each(['usd', 'uSd'])(
    'accepts a receipt with currency %s without rewriting the saved value',
    (currency) => {
      const savedReceipt = { ...receipt, currency };
      expect(parseCheckoutReceipt(savedReceipt, commandId)).toEqual(
        savedReceipt,
      );
    },
  );
  it('returns only the validated receipt fields for the expected command', () => {
    expect(
      parseCheckoutReceipt({ ...receipt, extra: true }, commandId),
    ).toEqual(receipt);
  });
  it.each([
    null,
    [],
    {},
    { ...receipt, commandId: crypto.randomUUID() },
    { ...receipt, orderId: '' },
    { ...receipt, chargeId: 123 },
    { ...receipt, authorizationCode: null },
    { ...receipt, totalCents: -1 },
    { ...receipt, totalCents: 0.5 },
    { ...receipt, totalCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, currency: 'dollars' },
    { ...receipt, currency: '123' },
    { ...receipt, currency: '$US' },
    { ...receipt, requestedShipDate: '2031-02-29' },
  ])('rejects malformed or unrelated successful responses', (value) => {
    expect(parseCheckoutReceipt(value, commandId)).toBeNull();
  });
});

describe('checkout failure decoding', () => {
  it('accepts known failures with or without a specific code', () => {
    for (const value of [
      { error: 'Not enough stock.' },
      { error: 'Changed command.', code: 'command_conflict' },
    ]) {
      expect(parseCheckoutFailure(value)).toEqual(value);
    }
  });
  it.each([
    null,
    {},
    { error: '' },
    { error: 123 },
    { error: 'Unknown code', code: 'surprise' },
  ])('rejects unknown failure shapes', (value) => {
    expect(parseCheckoutFailure(value)).toBeNull();
  });
});

describe('checkout reviewed prices', () => {
  it.each([
    undefined,
    null,
    '68000',
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects a missing or invalid expected price: %s',
    (expectedUnitPriceCents) => {
      expect(
        parseCheckoutInput({
          ...checkout,
          items: [{ ...checkout.items[0], expectedUnitPriceCents }],
        }),
      ).toBeNull();
    },
  );

  it.each([0, 68001])(
    'retains a valid reviewed unit price: %i',
    (expectedUnitPriceCents) => {
      const input = {
        ...checkout,
        items: [{ ...checkout.items[0], expectedUnitPriceCents }],
      };
      expect(parseCheckoutInput(input)).toEqual(input);
    },
  );
});

describe('checkout account context', () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { userId: 'USR-MCS-001' },
    { customerId: 'WHS-1098' },
    { userId: '', customerId: 'WHS-1098' },
    { userId: '   ', customerId: 'WHS-1098' },
    { userId: 'USR-MCS-001', customerId: 1098 },
    { userId: 'USR-MCS-001', customerId: 'x'.repeat(129) },
  ])(
    'rejects a missing or malformed expected subject: %j',
    (expectedSubject) => {
      expect(parseCheckoutInput({ ...checkout, expectedSubject })).toBeNull();
    },
  );
});

describe('checkout date parsing', () => {
  it('rejects invalid calendar dates and non-date-only inputs', () => {
    for (const requestedShipDate of [
      '2031-13-01',
      '2031-00-01',
      '2031-01-00',
      '2031-01-32',
      '2031-04-31',
      '2031-02-29',
      '2031-02-30',
      '2100-02-29',
      '2031-1-01',
      '2031-01-1',
      '2031-01-01T00:00:00Z',
      '',
    ]) {
      expect(
        parseCheckoutInput({ ...checkout, requestedShipDate }),
        requestedShipDate,
      ).toBeNull();
    }
  });

  it('accepts real calendar dates, including Gregorian leap-year boundaries', () => {
    for (const requestedShipDate of [
      '2000-02-29',
      '2028-02-29',
      '2031-02-28',
      '2031-04-30',
      '2031-12-31',
    ]) {
      expect(
        parseCheckoutInput({ ...checkout, requestedShipDate }),
        requestedShipDate,
      ).toEqual({ ...checkout, requestedShipDate });
    }
    expect(
      parseCheckoutInput({ ...checkout, requestedShipDate: ' 2031-01-01 ' }),
    ).toEqual(checkout);
  });
});
