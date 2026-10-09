// Current catalog policy: any retirement marker excludes new orders. This is
// independent of physical stock and does not interpret activity-date intervals.
export function isProductOrderable(activeTo: string | null): boolean {
  return activeTo === null;
}
