import { describe, expect, it } from 'vitest';
import type { CatalogCategoryNode } from '@amazon-mvp/api-contract';
import {
  brandHref,
  brandKey,
  browseHref,
  categoryHref,
  EMPTY_BROWSE,
  parseBrowseParams,
  parsePrice,
  priceLabel,
} from '../src/features/browse/browse-params';
import {
  brandFacet,
  buildCategoryTree,
  categoryTrail,
  departmentFacet,
  listingTitle,
  pageWindow,
  resultsSummary,
} from '../src/features/browse/browse-model';

const NODES: CatalogCategoryNode[] = [
  { slug: 'eletronicos', name: 'Eletrônicos', parentSlug: null },
  { slug: 'audio', name: 'Áudio', parentSlug: 'eletronicos' },
  { slug: 'fones', name: 'Fones de Ouvido', parentSlug: 'audio' },
  { slug: 'wearables', name: 'Wearables', parentSlug: 'eletronicos' },
  { slug: 'livros', name: 'Livros', parentSlug: null },
  { slug: 'orphan', name: 'Órfã', parentSlug: 'missing' },
];

describe('listing view model', () => {
  const tree = buildCategoryTree(NODES);

  it('counts brands of the matched products, most frequent first, skipping unbranded', () => {
    const brands: Record<string, string> = { a: 'Vortex', b: 'Amazon', c: 'Vortex', d: 'Apple' };
    expect(brandFacet(['a', 'b', 'c', 'd', 'x'], (slug) => brands[slug])).toEqual([
      { name: 'Vortex', key: 'vortex', count: 2 },
      { name: 'Amazon', key: 'amazon', count: 1 },
      { name: 'Apple', key: 'apple', count: 1 },
    ]);
  });
});
