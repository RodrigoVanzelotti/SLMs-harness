import { describe, expect, it, vi } from 'vitest';
import type { CatalogProductDetails } from '@amazon-mvp/api-contract';

vi.mock('server-only', () => ({}));
const records: Record<string, Partial<CatalogProductDetails> | null> = {
  p1: { name: 'Echo Dot (nome do banco)', priceMinor: 19900, active: true },
  p2: { name: 'JBL', priceMinor: 19990, active: false },
  p3: null,
};
const { listBySlugs } = vi.hoisted(() => ({ listBySlugs: vi.fn() }));
vi.mock('../src/features/product/product-server', () => ({ listBySlugs }));
listBySlugs.mockImplementation(async (slugs: string[]) =>
  slugs.flatMap((slug) =>
    records[slug] ? [{ id: `uuid-${slug}`, slug, sku: `DEMO-${slug}`, ...records[slug] }] : [],
  ),
);

import { resolveHomeProducts } from '../src/features/home/home-catalog';
import {
  ALSO_CONSIDER,
  BEST_SELLERS,
  DEALS_OF_THE_DAY,
  PRODUCTS,
  RECOMMENDED,
} from '../src/features/home/catalog-mock';

describe('Home cards', () => {
  it('show the catalog record (name, price) instead of the fixture copy', async () => {
    const curated = PRODUCTS.filter((product) => ['p1', 'p2', 'p3'].includes(product.id));
    const resolve = await resolveHomeProducts([curated]);
    const cards = resolve(curated);
    // Fixture says R$ 279,00; the database record wins everywhere.
    expect(curated.find((p) => p.id === 'p1')?.price).toBe(279);
    expect(cards).toEqual([
      expect.objectContaining({
        id: 'uuid-p1',
        name: 'Echo Dot (nome do banco)',
        priceMinor: 19900,
      }),
    ]);
  });

  it('drops inactive or missing products rather than showing fixture data', async () => {
    const curated = PRODUCTS.filter((product) => ['p2', 'p3'].includes(product.id));
    expect((await resolveHomeProducts([curated]))(curated)).toEqual([]);
  });

  it('resolves every rail with one batched lookup instead of one request per card', async () => {
    listBySlugs.mockClear();
    const rails = [DEALS_OF_THE_DAY, BEST_SELLERS, RECOMMENDED, ALSO_CONSIDER];
    await resolveHomeProducts(rails);
    expect(listBySlugs).toHaveBeenCalledTimes(1);
    const slugs = listBySlugs.mock.calls[0][0] as string[];
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
