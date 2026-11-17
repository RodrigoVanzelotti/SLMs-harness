import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import seedImages from '../../../config/product-images.json';
import productContent from '../../../config/demo-product-content.json';
import { CatalogItem } from '@amazon-mvp/api-contract';
import {
  normalizeProductDetails,
  productPresentation,
} from '../src/features/product/product-presentation';
import demos from '../../../config/demo-products.json';

const product: CatalogItem = {
  id: 'arbitrary-uuid',
  slug: 'any-new-product',
  sku: 'ANY',
  name: 'Any product',
  description: null,
  priceMinor: 12345,
  currency: 'BRL',
  active: true,
  availableQuantity: 3,
  inStock: true,
};
describe('generic product presentation', () => {
  it('does not associate media by an ID or slug collision alone', () => {
    expect(productPresentation({ ...product, slug: demos[0].id }).images).toEqual([]);
    expect(productPresentation({ ...product, id: demos[0].id }).images).toEqual([]);
  });
  it('only displays a previous price above the current authoritative price', () => {
    const demo = demos.find((p) => p.oldPriceMinor)!;
    expect(
      productPresentation({
        ...product,
        slug: demo.id,
        sku: demo.sku,
        priceMinor: demo.oldPriceMinor!,
      }).oldPriceMinor,
    ).toBeUndefined();
  });
});

// These are permanent catalog fixtures; new records retain a safe fallback until curated.
describe('catalog photo coverage', () => {
  it('resolves seed media by SKU and slug while preserving live data', () => {
    for (const entry of seedImages) {
      const data = { ...product, sku: entry.sku, slug: entry.slug };
      expect(productPresentation(data)).toEqual({
        images: [entry.image],
        demo: false,
        oldPriceMinor: undefined,
      });
      expect(productPresentation({ ...data, sku: 'UNRELATED' }).images).toEqual([]);
      expect(productPresentation({ ...data, slug: 'unrelated' }).images).toEqual([]);
      expect(data.priceMinor).toBe(product.priceMinor);
    }
  });
});
