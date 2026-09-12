'use client';

import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CatalogProduct } from '@/lib/contracts';

export function QuantityControl({
  product,
  quantity,
  disabled = false,
  onChange,
}: {
  product: Pick<CatalogProduct, 'name' | 'casePack' | 'availableQuantity'>;
  quantity: number;
  disabled?: boolean;
  onChange: (delta: number) => void;
}) {
  return (
    <fieldset
      className="quantity-control"
      aria-label={`Quantity for ${product.name}`}
    >
      <Button
        variant="outline"
        size="icon-sm"
        type="button"
        aria-label={`Remove ${product.casePack} ${product.name}`}
        disabled={disabled || quantity === 0}
        onClick={() => onChange(-product.casePack)}
      >
        <Minus />
      </Button>
      <strong aria-live="polite">{quantity}</strong>
      <Button
        size="icon-sm"
        type="button"
        aria-label={`Add ${product.casePack} ${product.name}`}
        disabled={
          disabled ||
          (product.availableQuantity !== null &&
            quantity + product.casePack > product.availableQuantity)
        }
        onClick={() => onChange(product.casePack)}
      >
        <Plus />
      </Button>
    </fieldset>
  );
}
