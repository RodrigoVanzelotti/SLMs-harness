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

describe('home cards', () => {
  it('show one card per variant family, linking to the family head', async () => {
    const { PRODUCTS } = await import('../src/features/home/catalog-mock');
    const ids = PRODUCTS.map((product) => product.id);
    expect(ids).toContain('p6');
    for (const sibling of ['p21', 'p22', 'p23']) expect(ids).not.toContain(sibling);
    expect(PRODUCTS.find((product) => product.id === 'p6')?.image?.src).toContain('hortela-1');
  });
});
