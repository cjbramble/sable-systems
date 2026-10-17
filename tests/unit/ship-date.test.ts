import { expect, it } from 'vitest';

import { earliestShipDate } from '@/db/shop';

it.each([
  // Before 12:00 UTC, the previous UTC date is still today at UTC-12.
  ['2026-09-10T00:30:00.000Z', '2026-09-09'],
  ['2026-09-10T11:59:59.999Z', '2026-09-09'],
  ['2026-09-10T12:00:00.000Z', '2026-09-10'],
  ['2026-09-10T23:59:59.999Z', '2026-09-10'],
  // Month, year, and leap-day boundaries.
  ['2026-10-01T03:00:00.000Z', '2026-09-30'],
  ['2027-01-01T06:00:00.000Z', '2026-12-31'],
  ['2028-03-01T00:00:00.000Z', '2028-02-29'],
])('at %s the earliest ship date is %s', (now, expected) => {
  expect(earliestShipDate(now)).toBe(expected);
});
