import { expect, it } from 'vitest';
import {
  loginHref,
  safeLoginDestination,
  shopDestination,
} from '../../lib/auth-navigation';

it('retains only approved protected destinations and shop categories through login', () => {
  for (const destination of [
    '/shop',
    '/orders',
    '/support',
    '/shop?category=Cybernetics',
    '/shop?category=Power',
  ]) {
    expect(
      safeLoginDestination(loginHref(destination).slice('/login'.length)),
    ).toBe(destination);
  }
  for (const destination of [
    'https://example.com/shop?category=Power',
    '//example.com/shop',
    'javascript:alert(1)',
    '/admin',
    '/support?category=Power',
    '/shop?category=unknown',
    '/shop?category=Power&category=Compute',
    '/shop?category=Power&next=/orders',
  ]) {
    expect(
      safeLoginDestination(loginHref(destination).slice('/login'.length)),
    ).toBe('/shop');
  }
  expect(shopDestination('?category=Cybernetics')).toBe(
    '/shop?category=Cybernetics',
  );
  expect(shopDestination('?category=Power')).toBe('/shop?category=Power');
  for (const search of [
    '',
    '?category=unknown',
    '?category=Power&category=Compute',
    '?category=Power&next=//example.com',
  ]) {
    expect(shopDestination(search)).toBe('/shop');
  }
});
