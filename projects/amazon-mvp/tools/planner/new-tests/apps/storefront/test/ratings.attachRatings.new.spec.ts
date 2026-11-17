import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '@amazon-mvp/api-contract';
import { attachRatings } from '../src/features/product/reviews/ratings';

const item = (id: string): CatalogItem => ({
  id,
  slug: `slug-${id}`,
  sku: `SKU-${id}`,
  name: `Produto ${id}`,
  description: null,
  priceMinor: 1000,
  currency: 'BRL',
  active: true,
  availableQuantity: 5,
  inStock: true,
});

describe('attachRatings', () => {
  it('adds { average, count } to rated records and keeps order and other fields', () => {
    const rated = attachRatings(
      [item('a'), item('b'), item('c')],
      [
        { productId: 'c', average: 3.5, count: 2 },
        { productId: 'a', average: 4.7, count: 48213 },
        { productId: 'zzz', average: 5, count: 1 },
      ],
    );
    expect(rated.map((product) => product.id)).toEqual(['a', 'b', 'c']);
    expect(rated[0]).toEqual({ ...item('a'), rating: { average: 4.7, count: 48213 } });
    expect(rated[1]).not.toHaveProperty('rating');
    expect(rated[2]).toMatchObject({ slug: 'slug-c', rating: { average: 3.5, count: 2 } });
  });

  it('never attaches a rating without reviews or without an average', () => {
    const rated = attachRatings(
      [item('a'), item('b')],
      [
        { productId: 'a', average: null, count: 0 },
        { productId: 'b', average: null, count: 3 },
      ],
    );
    expect(rated[0]).not.toHaveProperty('rating');
    expect(rated[1]).not.toHaveProperty('rating');
    expect(attachRatings([item('a')], [{ productId: 'a', average: 4, count: 0 }])[0]).not.toHaveProperty(
      'rating',
    );
  });

  it('does not modify the records it receives', () => {
    const items = [item('a')];
    attachRatings(items, [{ productId: 'a', average: 4.2, count: 10 }]);
    expect(items[0]).not.toHaveProperty('rating');
    expect(attachRatings([], [{ productId: 'a', average: 4.2, count: 10 }])).toEqual([]);
  });
});
