// Current catalog policy: any retirement marker excludes new orders. This is
// independent of physical stock and does not interpret activity-date intervals.
export function isProductOrderable(activeTo: string | null): boolean {
  return activeTo === null;
}

// The same policy for SQL queries over `products`. Keep the two in step.
export function orderableProductSql(alias: string) {
  return `${alias}.active_to IS NULL`;
}

// A physical product is low on stock at eight case packs or fewer.
export const LOW_STOCK_CASE_PACKS = 8;

export function lowStockSql(available: string, product: string) {
  return `${available} <= ${product}.case_pack * ${LOW_STOCK_CASE_PACKS}`;
}
