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

  it('lists only departments with results, below the selected category', () => {
    const counts = [
      { slug: 'eletronicos', count: 5 },
      { slug: 'audio', count: 5 },
      { slug: 'fones', count: 4 },
    ];
    const roots = departmentFacet(tree, counts, '');
    expect(roots.selected).toBeNull();
    expect(roots.options.map(({ node, count }) => [node.slug, count])).toEqual([
      ['eletronicos', 5],
    ]);
    const audio = departmentFacet(tree, counts, 'audio');
    expect(audio.trail.map((node) => node.slug)).toEqual(['eletronicos']);
    expect(audio.selected?.slug).toBe('audio');
    expect(audio.options.map(({ node }) => node.slug)).toEqual(['fones']);
  });
});
