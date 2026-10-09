import { describe, expect, it } from 'vitest';

import { formatCurrency } from '@/lib/format';

describe('currency displays', () => {
  it.each([
    [544008, 'USD', '$5,440.08'],
    [544000, 'USD', '$5,440.00'],
    [1, 'USD', '$0.01'],
    [0, 'USD', '$0.00'],
    [-101, 'USD', '-$1.01'],
    [544008, 'EUR', '€5,440.08'],
  ])('preserves integer cents (%i %s)', (cents, currency, display) => {
    expect(formatCurrency(cents, currency)).toBe(display);
  });
});
