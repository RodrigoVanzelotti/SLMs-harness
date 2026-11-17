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

  it('rebuilds the taxonomy, treating a missing parent as a root', () => {
    expect(tree.children.get(null)?.map((node) => node.slug)).toEqual([
      'eletronicos',
      'livros',
      'orphan',
    ]);
    expect(categoryTrail(tree, 'fones').map((node) => node.slug)).toEqual([
      'eletronicos',
      'audio',
      'fones',
    ]);
    expect(categoryTrail(tree, 'absent')).toEqual([]);
  });
});
