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

  it('groups variants and brand products, and only has brand stories for registered brands', () => {
    expect(variantGroupSlugs('8bitdo-ultimate-2c')).toEqual(['p6', 'p21', 'p22', 'p23']);
    expect(brandSlugs('8BitDo')).toEqual(['p6', 'p21', 'p22', 'p23']);
    expect(brandStory('8BitDo')?.story).toHaveLength(3);
    expect(brandStory('Amazon')).toBeUndefined();
    expect(brandStory(undefined)).toBeUndefined();
  });
});
