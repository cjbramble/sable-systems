import { describe, expect, it } from 'vitest';

import { parseCheckoutInput } from '@/db/shop';

const checkout = {
  customerPoNumber: 'TEST-CALENDAR',
  requestedShipDate: '2031-01-01',
  shippingRegion: 'Great Lakes District',
  items: [{ itemNumber: 'SBL-RPC-12', quantity: 8 }],
};

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
