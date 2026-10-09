import type { CatalogProduct } from './contracts';

// Preserve customer intent independently of what the latest catalog contains.
export type CartSelections = Record<string, { name: string; quantity: number }>;

type CartLine = {
  itemNumber: string;
  name: string;
  quantity: number;
  product: CatalogProduct | null;
  issue: 'unavailable' | 'case_pack' | 'stock' | null;
};

function lineIssue(
  product: CatalogProduct | null,
  quantity: number,
): CartLine['issue'] {
  if (!product) return 'unavailable';
  if (quantity % product.casePack !== 0) return 'case_pack';
  if (
    product.availableQuantity !== null &&
    quantity > product.availableQuantity
  )
    return 'stock';
  return null;
}

export function reconcileCart(
  selections: CartSelections,
  products: readonly CatalogProduct[],
) {
  const byId = new Map(
    products.map((product) => [product.itemNumber, product]),
  );
  const lines: CartLine[] = Object.entries(selections).map(
    ([itemNumber, selection]) => {
      const product = byId.get(itemNumber) ?? null;
      return {
        itemNumber,
        name: product?.name ?? selection.name,
        quantity: selection.quantity,
        product,
        issue: lineIssue(product, selection.quantity),
      };
    },
  );
  return {
    lines,
    unitCount: lines.reduce((total, line) => total + line.quantity, 0),
    // A partial price is not a total. Never price an unavailable selection at zero.
    totalCents: lines.reduce<number | null>(
      (total, line) =>
        total !== null && line.product
          ? total + line.product.unitPriceCents * line.quantity
          : null,
      0,
    ),
    canOrder: lines.length > 0 && lines.every((line) => line.issue === null),
  };
}
