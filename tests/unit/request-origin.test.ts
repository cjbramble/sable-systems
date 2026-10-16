import { expect, it } from 'vitest';

import { isTrustedMutation } from '@/lib/request-origin';

it.each([
  { origin: undefined, site: undefined, trusted: true },
  { origin: '', site: '', trusted: true },
  { origin: 'https://localhost:8016', site: undefined, trusted: true },
  { origin: 'https://localhost:8016', site: 'same-origin', trusted: true },
  { origin: 'https://localhost:8016', site: 'cross-site', trusted: false },
  { origin: 'https://foreign.example', site: 'same-origin', trusted: false },
  { origin: 'null', site: 'same-origin', trusted: false },
  { origin: 'https://localhost:8017', site: 'same-site', trusted: false },
  { origin: 'http://localhost:8016', site: 'same-site', trusted: false },
  { origin: undefined, site: 'same-origin', trusted: true },
  { origin: undefined, site: 'same-site', trusted: true },
  { origin: undefined, site: 'none', trusted: true },
  { origin: undefined, site: 'cross-site', trusted: false },
  { origin: undefined, site: 'unknown', trusted: false },
])(
  'origin=$origin, fetch site=$site permits mutation=$trusted',
  ({ origin, site, trusted }) => {
    const headers = new Headers();
    if (origin !== undefined) headers.set('Origin', origin);
    if (site !== undefined) headers.set('Sec-Fetch-Site', site);
    expect(
      isTrustedMutation(
        new Request('https://localhost:8016/api/orders', {
          method: 'POST',
          headers,
        }),
      ),
    ).toBe(trusted);
  },
);
