import assert from 'node:assert/strict';
import test from 'node:test';

import { loginHref, safeLoginDestination } from '../lib/auth-navigation.ts';

void test('defaults to the shop and allows known protected routes', () => {
  assert.equal(safeLoginDestination(''), '/shop');
  assert.equal(safeLoginDestination('?next=/shop'), '/shop');
  assert.equal(safeLoginDestination('?next=/support'), '/support');
  assert.equal(safeLoginDestination('?next=/orders'), '/orders');
});

void test('preserves a single valid catalog category', () => {
  const destination = '/shop?category=Cybernetics';
  assert.equal(
    safeLoginDestination(`?next=${encodeURIComponent(destination)}`),
    destination,
  );
});

void test('rejects open redirects, unknown routes, and unexpected query data', () => {
  const rejected = [
    'https://example.com/orders',
    '//example.com/orders',
    '/admin',
    '/orders?customer=WHS-5830',
    '/shop?category=Unknown',
    '/shop?category=Compute&customer=WHS-5830',
  ];

  for (const destination of rejected) {
    assert.equal(
      safeLoginDestination(`?next=${encodeURIComponent(destination)}`),
      '/shop',
      destination,
    );
  }
});

void test('encodes protected destinations when creating a login link', () => {
  assert.equal(
    loginHref('/shop?category=Power'),
    '/login?next=%2Fshop%3Fcategory%3DPower',
  );
});
