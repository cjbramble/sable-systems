import { afterEach, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ SABLE_LOCAL_DEMO: 'true' }));
vi.mock('cloudflare:workers', () => ({ env: settings }));
import { isLocalDemoRequest } from '@/lib/local-demo';

afterEach(() => {
  settings.SABLE_LOCAL_DEMO = 'true';
});

it.each(['localhost', '127.0.0.1', '[::1]'])(
  'allows an opted-in loopback host %s',
  (host) => {
    expect(
      isLocalDemoRequest(new Request(`http://${host}:8016/api/auth/login`)),
    ).toBe(true);
  },
);

it.each([
  'example.com',
  'localhost.example.com',
  '127.0.0.1.example.com',
  '0.0.0.0',
  '192.168.1.10',
])('rejects non-loopback host %s', (host) => {
  expect(isLocalDemoRequest(new Request(`http://${host}/api/auth/login`))).toBe(
    false,
  );
});

it.each(['', 'false', '1'])(
  'requires explicit local opt-in rather than %s',
  (enabled) => {
    settings.SABLE_LOCAL_DEMO = enabled;
    expect(
      isLocalDemoRequest(new Request('http://127.0.0.1/api/auth/login')),
    ).toBe(false);
  },
);
