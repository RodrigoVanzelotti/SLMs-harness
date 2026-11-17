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

describe('listing URL parameters', () => {
  it('reads search, filters, sort and page from the URL', () => {
    expect(
      parseBrowseParams({
        q: '  fone   bluetooth ',
        category: 'eletronicos',
        brand: 'Letra Viva',
        price: '5000-10000',
        inStock: '1',
        sort: 'price-desc',
        page: '3',
      }),
    ).toEqual({
      q: 'fone bluetooth',
      category: 'eletronicos',
      brand: 'letra-viva',
      price: { min: 5000, max: 10000 },
      inStock: true,
      sort: 'price-desc',
      page: 3,
      pageValid: true,
    });
  });

  it('falls back to defaults for unknown values and flags malformed pages', () => {
    const params = parseBrowseParams({ sort: 'rating', price: 'cheap', inStock: 'yes' });
    expect(params).toEqual(EMPTY_BROWSE);
    // The header's "Todos" submits an empty category.
    expect(parseBrowseParams({ category: '', q: 'x' }).category).toBe('');
    for (const page of ['0', '-1', 'abc', '1.5', '10001'])
      expect(parseBrowseParams({ page }).pageValid).toBe(false);
    expect(parseBrowseParams({ page: '2' }).pageValid).toBe(true);
    expect(parseBrowseParams({ q: 'a'.repeat(300) }).q).toHaveLength(100);
    expect(parseBrowseParams({ q: ['first', 'second'] }).q).toBe('first');
  });

  it('builds canonical URLs and resets the page when a filter changes', () => {
    const params = parseBrowseParams({ q: 'fone', category: 'audio', page: '2' });
    expect(browseHref(params, { page: 2 })).toBe('/products?q=fone&category=audio&page=2');
    expect(browseHref(params, { sort: 'price-asc' })).toBe(
      '/products?q=fone&category=audio&sort=price-asc',
    );
    expect(browseHref(params, { price: { min: 0, max: 5000 }, inStock: true })).toBe(
      '/products?q=fone&category=audio&price=0-5000&inStock=1',
    );
    expect(browseHref(EMPTY_BROWSE)).toBe('/products');
    expect(categoryHref('games-e-consoles')).toBe('/products?category=games-e-consoles');
    expect(brandHref('Genérico')).toBe('/products?brand=generico');
    expect(brandKey('Calvin Klein')).toBe('calvin-klein');
    expect(brandKey('8BitDo')).toBe('8bitdo');
  });
});

const NODES: CatalogCategoryNode[] = [
  { slug: 'eletronicos', name: 'Eletrônicos', parentSlug: null },
  { slug: 'audio', name: 'Áudio', parentSlug: 'eletronicos' },
  { slug: 'fones', name: 'Fones de Ouvido', parentSlug: 'audio' },
  { slug: 'wearables', name: 'Wearables', parentSlug: 'eletronicos' },
  { slug: 'livros', name: 'Livros', parentSlug: null },
  { slug: 'orphan', name: 'Órfã', parentSlug: 'missing' },
];
