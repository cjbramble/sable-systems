import { describe, expect, it } from 'vitest';

import { checkoutCommand } from '../fixtures/checkout';
import { calendarDateIn, parseCheckoutInput } from '@/lib/checkout';

describe('checkout time zone', () => {
  it.each([
    ['UTC', '2026-09-10T10:30:00.000Z', '2026-09-10'],
    ['Pacific/Kiritimati', '2026-09-10T10:30:00.000Z', '2026-09-11'],
    ['Pacific/Honolulu', '2026-09-10T06:30:00.000Z', '2026-09-09'],
    ['Pacific/Pago_Pago', '2027-01-01T05:00:00.000Z', '2026-12-31'],
    // 23:30 on 02-28 in New York (UTC-5) is still before the leap day.
    ['America/New_York', '2028-02-29T04:30:00.000Z', '2028-02-28'],
  ])('in %s at %s the date is %s', (timeZone, instant, expected) => {
    expect(calendarDateIn(timeZone, instant)).toBe(expected);
  });

  it('accepts a valid IANA time zone and omits an absent one', () => {
    const command = checkoutCommand('MCS-TZ');
    expect(parseCheckoutInput({ ...command, timeZone: 'Asia/Tokyo' })).toEqual({
      ...command,
      timeZone: 'Asia/Tokyo',
    });
    expect(parseCheckoutInput(command)).not.toHaveProperty('timeZone');
  });

  it.each(['', 'Mars/Olympus_Mons', 'Not a zone', 'A'.repeat(65), 9, null])(
    'rejects time zone %j',
    (timeZone) => {
      expect(
        parseCheckoutInput({ ...checkoutCommand('MCS-TZ'), timeZone }),
      ).toBeNull();
    },
  );
});
