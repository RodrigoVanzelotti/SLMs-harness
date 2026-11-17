import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '@amazon-mvp/api-contract';
import { distinctCards, type RelatedCandidate } from '../src/features/product/related-products';

const item = (id: string): CatalogItem => ({
  id,
  slug: id,
  sku: `SKU-${id}`,
  name: id,
  description: null,
  priceMinor: 1000,
  currency: 'BRL',
  active: true,
  availableQuantity: 5,
  inStock: true,
});
const candidate = (id: string, family?: string, distance = 0): RelatedCandidate => ({
  item: item(id),
  distance,
  facts: { attributes: [], ...(family ? { family } : {}) },
});

describe('distinctCards', () => {
  it('is zero for no candidates', () => {
    expect(distinctCards([])).toBe(0);
  });

  it('counts a variant family once and every family-less record on its own', () => {
    expect(
      distinctCards([
        candidate('run-black', 'run'),
        candidate('run-white', 'run'),
        candidate('single'),
        candidate('cap-red', 'cap'),
      ]),
    ).toBe(3);
  });

  it('counts the same record once even when it appears twice', () => {
    expect(distinctCards([candidate('a', undefined, 0), candidate('a', undefined, 1)])).toBe(1);
  });
});
