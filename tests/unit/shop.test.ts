import { describe, expect, it } from 'vitest';

import { parseCheckoutInput } from '@/db/shop';

const checkout = {
  expectedSubject: { userId: 'USR-MCS-001', customerId: 'WHS-1098' },
  customerPoNumber: 'TEST-CALENDAR',
  requestedShipDate: '2031-01-01',
  shippingRegion: 'Great Lakes District',
  items: [
    { itemNumber: 'SBL-RPC-12', quantity: 8, expectedUnitPriceCents: 68000 },
  ],
};

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
