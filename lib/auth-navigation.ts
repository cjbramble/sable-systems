import { isCatalogCategory } from './catalog-categories.ts';

const DEFAULT_DESTINATION = '/shop';
const DIRECT_DESTINATIONS = new Set(['/shop', '/support', '/orders']);
const LOCAL_ORIGIN = 'http://sable.local';

export function safeLoginDestination(search: string) {
  const next = new URLSearchParams(search).get('next');
  if (!next) return DEFAULT_DESTINATION;
  if (DIRECT_DESTINATIONS.has(next)) return next;

  let destination: URL;
  try {
    destination = new URL(next, LOCAL_ORIGIN);
  } catch {
    return DEFAULT_DESTINATION;
  }

  const category = destination.searchParams.get('category');
  const queryKeys = Array.from(destination.searchParams.keys());
  if (
    destination.origin === LOCAL_ORIGIN &&
    destination.pathname === '/shop' &&
    queryKeys.length === 1 &&
    queryKeys[0] === 'category' &&
    isCatalogCategory(category)
  ) {
    return `/shop?category=${encodeURIComponent(category)}`;
  }

  return DEFAULT_DESTINATION;
}

export function loginHref(destination: string) {
  return `/login?next=${encodeURIComponent(destination)}`;
}
