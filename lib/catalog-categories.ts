export const CATALOG_CATEGORIES = [
  'Compute',
  'Cybernetics',
  'Interface',
  'Power',
  'Security',
  'Software',
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export function isCatalogCategory(
  value: string | null,
): value is CatalogCategory {
  return CATALOG_CATEGORIES.includes(value as CatalogCategory);
}
