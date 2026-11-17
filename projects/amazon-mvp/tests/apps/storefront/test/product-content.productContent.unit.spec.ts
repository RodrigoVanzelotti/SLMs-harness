import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '@amazon-mvp/api-contract';

vi.mock('server-only', () => ({}));

import {
  brandSlugs,
  brandStory,
  productContent,
  variantGroupSlugs,
} from '../src/features/product/product-content';
import demos from '../../../config/demo-products.json';
import contents from '../../../config/demo-product-content.json';
import categories from '../../../config/demo-categories.json';
import brands from '../../../config/demo-brands.json';

const PUBLIC = join(process.cwd(), 'public');
const catalogItem = (slug: string, sku: string): CatalogItem => ({
  id: `uuid-${slug}`,
  slug,
  sku,
  name: slug,
  description: null,
  priceMinor: 1000,
  currency: 'BRL',
  active: true,
  availableQuantity: 1,
  inStock: true,
});

describe('productContent', () => {
  it('gives the reference product its own gallery, brand, specs and variant options', () => {
    const content = productContent(catalogItem('p6', 'DEMO-p6'));
    expect(content.images).toHaveLength(9);
    expect(content.images.every((image) => image.src.includes('/hortela-'))).toBe(true);
    expect(content.brand).toBe('8BitDo');
    expect(content.attributes).toEqual([{ label: 'Plataforma', value: 'Windows, Android' }]);
    expect(content.badges).toEqual({ amazonChoice: true, boughtLastMonth: 'Mais de 200 compras' });
    expect(content.variant?.options).toEqual([
      { name: 'Estilo', value: 'Ultimate 2C' },
      { name: 'Cor', value: 'Hortelã' },
    ]);
    // Ratings are not presentation content: they come from the reviews API.
    expect(content).not.toHaveProperty('rating');
    expect(content.details.find((d) => d.label === 'ASIN')?.value).toBe('B0D736BCNM');
  });

  it('never leaks the reference content into other products', () => {
    const echo = productContent(catalogItem('p1', 'DEMO-p1'));
    expect(echo.images).toEqual([demos[0].image]);
    expect(echo.brand).toBe('Amazon');
    expect(echo.variant).toBeUndefined();
    expect(echo.badges).toEqual({ amazonChoice: false, boughtLastMonth: undefined });
    expect(echo.bullets).toEqual([]);

    const peach = productContent(catalogItem('p21', 'DEMO-p21'));
    expect(peach.images[0].src).toContain('/pessego-1');
    expect(peach.badges.amazonChoice).toBe(false);
  });

  it('returns nothing for arbitrary records or a slug whose SKU does not match', () => {
    for (const product of [catalogItem('new-product', 'ANY'), catalogItem('p6', 'OTHER-SKU')]) {
      const content = productContent(product);
      expect(content).toMatchObject({
        images: [],
        brand: undefined,
        attributes: [],
        details: [],
        variant: undefined,
        demo: false,
      });
    }
  });
});
