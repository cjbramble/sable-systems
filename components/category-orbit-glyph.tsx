import {
  Box,
  CircleDot,
  Cpu,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import {
  isCatalogCategory,
  type CatalogCategory,
} from '@/lib/catalog-categories';
import { cn } from '@/lib/utils';

const categoryIcons: Record<CatalogCategory, LucideIcon> = {
  Compute: Cpu,
  Cybernetics: CircleDot,
  Interface: ScanLine,
  Power: Zap,
  Security: ShieldCheck,
  Software: Sparkles,
};

type CategoryOrbitGlyphProps = {
  category: string;
  className?: string;
};

export function CategoryOrbitGlyph({
  category,
  className,
}: CategoryOrbitGlyphProps) {
  const Icon = isCatalogCategory(category) ? categoryIcons[category] : Box;

  return (
    <span className={cn('product-glyph', className)} aria-hidden="true">
      <Icon />
      <i />
      <i />
    </span>
  );
}
