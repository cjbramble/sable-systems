export const CATALOG_CATEGORIES = [
  'Compute',
  'Cybernetics',
  'Interface',
  'Power',
  'Security',
  'Software',
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
