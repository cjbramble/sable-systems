import { expect, it } from 'vitest';
import {
  supportDateKey,
  supportDateLabel,
  supportTimeLabel,
} from '@/lib/support-time';

it('formats browser-local calendar boundaries, historical years, and DST without losing the stored instant', () => {
  const zone = 'America/New_York';
  const now = new Date('2026-09-03T12:00:00Z');
  expect(supportDateKey('2026-09-03T03:59:00Z', zone)).toBe('2026-09-02');
  expect(supportDateLabel('2026-09-03T03:59:00Z', now, zone)).toBe('Yesterday');
  expect(supportTimeLabel('2026-09-03T03:59:00Z', zone)).toBe('11:59 PM');
  expect(supportDateLabel('2026-09-03T04:01:00Z', now, zone)).toBe('Today');
  expect(supportTimeLabel('2026-09-03T04:01:00Z', zone)).toBe('12:01 AM');
  expect(supportDateLabel('2021-09-03T12:00:00Z', now, zone)).toBe(
    'Sep 3, 2021',
  );
  expect(
    supportDateLabel(
      '2026-03-08T06:30:00Z',
      new Date('2026-03-09T04:30:00Z'),
      zone,
    ),
  ).toBe('Yesterday');
  expect(supportDateKey(null, zone)).toBeNull();
  expect(supportDateLabel(null, now, zone)).toBe('New conversation');
});
