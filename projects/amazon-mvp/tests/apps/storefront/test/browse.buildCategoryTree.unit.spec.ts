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

  it('summarizes the result range like Amazon', () => {
    expect(resultsSummary(1, 48, 150)).toBe('1-48 de 150 resultados');
    expect(resultsSummary(4, 48, 150)).toBe('145-150 de 150 resultados');
    expect(resultsSummary(1, 48, 12)).toBe('12 resultados');
    expect(resultsSummary(1, 48, 1)).toBe('1 resultado');
    expect(resultsSummary(1, 48, 1500)).toBe('1-48 de 1.500 resultados');
  });

  it('titles the listing by search, brand or category', () => {
    expect(listingTitle({ q: 'fone' })).toBe('Resultados para “fone”');
    expect(listingTitle({ q: 'fone', categoryName: 'Áudio' })).toBe(
      'Resultados para “fone” em Áudio',
    );
    expect(listingTitle({ q: '', brandName: 'Vortex' })).toBe('Vortex');
    expect(listingTitle({ q: '', categoryName: 'Livros' })).toBe('Livros');
    expect(listingTitle({ q: '' })).toBe('Todos os produtos');
  });

  it('windows page links around the current page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, 'gap', 20]);
  });
});
