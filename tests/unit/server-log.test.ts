import { afterEach, expect, it, vi } from 'vitest';

import { logServerError } from '@/lib/server-log';

afterEach(() => {
  vi.restoreAllMocks();
});

it('logs the operation, error type, and message', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  logServerError('checkout', new TypeError('D1_ERROR: database is locked'));

  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[checkout] TypeError: D1_ERROR: database is locked',
  );
});

it('does not log the contents of non-error values', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  logServerError('chat', { cookie: 'sable_session=secret-token' });

  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[chat] Non-error value of type object',
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
});
