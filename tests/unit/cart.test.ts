import { describe, expect, it } from 'vitest';
import { reconcileCart, type CartSelections } from '@/lib/cart';
import type { CatalogProduct } from '@/lib/contracts';
import { isProductOrderable } from '@/lib/product-eligibility';

const product: CatalogProduct = {
  itemNumber: 'SBL-RPC-12',
  name: 'Redline Power Cell R12',
  category: 'Power Systems',
  fulfillmentType: 'physical',
  unitPriceCents: 68000,
  unitLabel: 'cell',
  casePack: 8,
  leadTimeDays: 2,
  warrantyMonths: 12,
  availableQuantity: 312,
  inboundQuantity: 0,
  restockDate: null,
};
const cable = {
  ...product,
  itemNumber: 'SBL-SWC-12',
  name: 'Cable',
  casePack: 12,
  unitPriceCents: 1000,
};
const selections: CartSelections = {
  [product.itemNumber]: { name: product.name, quantity: 8 },
  [cable.itemNumber]: { name: cable.name, quantity: 12 },
};

describe('cart reconciliation', () => {
  it('retains every missing selection and refuses a partial total or order', () => {
    const cart = reconcileCart(selections, [cable]);
    expect(
      cart.lines.map(({ itemNumber, quantity }) => ({ itemNumber, quantity })),
    ).toEqual([
      { itemNumber: product.itemNumber, quantity: 8 },
      { itemNumber: cable.itemNumber, quantity: 12 },
    ]);
    expect(cart.lines[0]).toMatchObject({
      name: product.name,
      quantity: 8,
      product: null,
      issue: 'unavailable',
    });
    expect(cart).toMatchObject({
      unitCount: 20,
      totalCents: null,
      canOrder: false,
    });
    const emptyCatalog = reconcileCart(selections, []);
    expect(emptyCatalog.lines).toHaveLength(2);
    expect(emptyCatalog).toMatchObject({
      unitCount: 20,
      totalCents: null,
      canOrder: false,
    });
    // Reconciliation is a view of intent, never a mutation of it.
    expect(selections[product.itemNumber].quantity).toBe(8);
  });

  it('uses current prices and names, while explicit removal reconciles the entire payload', () => {
    const refreshed = reconcileCart(selections, [
      { ...product, name: 'Renamed cell', unitPriceCents: 68001 },
      cable,
    ]);
    expect(refreshed.lines[0].name).toBe('Renamed cell');
    expect(refreshed).toMatchObject({
      unitCount: 20,
      totalCents: 556008,
      canOrder: true,
    });
    const remaining = reconcileCart(
      { [cable.itemNumber]: selections[cable.itemNumber] },
      [cable],
    );
    expect(remaining).toMatchObject({
      unitCount: 12,
      totalCents: 12000,
      canOrder: true,
    });
    expect(
      remaining.lines.map(({ itemNumber, quantity }) => ({
        itemNumber,
        quantity,
      })),
    ).toEqual([{ itemNumber: cable.itemNumber, quantity: 12 }]);
    expect(reconcileCart({}, [product])).toEqual({
      lines: [],
      unitCount: 0,
      totalCents: 0,
      canOrder: false,
    });
  });

  it.each([
    [{ casePack: 12 }, 'case_pack'],
    [{ availableQuantity: 4 }, 'stock'],
    [{ availableQuantity: 0 }, 'stock'],
  ] as const)(
    'preserves requested quantities when eligibility changes: %j',
    (changes, issue) => {
      const cart = reconcileCart(
        { [product.itemNumber]: selections[product.itemNumber] },
        [{ ...product, ...changes }],
      );
      expect(cart.lines[0]).toMatchObject({ quantity: 8, issue });
      expect(cart).toMatchObject({
        unitCount: 8,
        totalCents: 544000,
        canOrder: false,
      });
    },
  );

  it('permits digital quantities without physical stock and resolves restored catalog lines', () => {
    const cart = reconcileCart(
      { [product.itemNumber]: { name: product.name, quantity: 800 } },
      [{ ...product, fulfillmentType: 'license', availableQuantity: null }],
    );
    expect(cart).toMatchObject({ unitCount: 800, canOrder: true });
    expect(cart.lines[0].issue).toBeNull();
    expect(reconcileCart(selections, [product, cable]).canOrder).toBe(true);
  });
});

describe('product orderability', () => {
  it('keeps retirement separate from dates and physical stock', () => {
    expect(isProductOrderable(null)).toBe(true);
    expect(isProductOrderable('2025-06-30')).toBe(false);
    // Existing policy treats any retirement marker as non-orderable.
    expect(isProductOrderable('2099-01-01')).toBe(false);
  });
});
