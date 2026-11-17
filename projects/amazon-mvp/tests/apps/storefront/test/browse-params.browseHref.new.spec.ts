import { describe, expect, it } from 'vitest';
import { browseHref, EMPTY_BROWSE } from '../src/features/browse/browse-params';

describe('browseHref', () => {
  it('writes every parameter in a fixed order', () => {
    expect(
      browseHref(
        {
          ...EMPTY_BROWSE,
          q: 'fone bluetooth',
          category: 'audio',
          brand: 'vortex',
          price: { min: 5000, max: null },
          inStock: true,
          sort: 'newest',
          page: 4,
        },
        { page: 4 },
      ),
    ).toBe(
      '/products?q=fone+bluetooth&category=audio&brand=vortex&price=5000-&inStock=1&sort=newest&page=4',
    );
  });

  it('omits defaults and goes back to page 1 unless the change sets a page', () => {
    expect(browseHref(EMPTY_BROWSE)).toBe('/products');
    expect(browseHref({ ...EMPTY_BROWSE, q: 'fone', page: 4 })).toBe('/products?q=fone');
    expect(browseHref({ ...EMPTY_BROWSE, sort: 'price-asc', page: 3 }, { sort: 'relevance' })).toBe(
      '/products',
    );
    expect(browseHref({ ...EMPTY_BROWSE, page: 3 }, { page: 1 })).toBe('/products');
    expect(browseHref({ ...EMPTY_BROWSE, page: 3 }, { page: 2 })).toBe('/products?page=2');
  });

  it('clears a filter set to an empty value', () => {
    const params = { ...EMPTY_BROWSE, q: 'fone', category: 'audio', inStock: true };
    expect(browseHref(params, { category: '', inStock: false })).toBe('/products?q=fone');
  });

  it('encodes the query like URLSearchParams', () => {
    expect(browseHref({ ...EMPTY_BROWSE, q: 'café & chá' })).toBe(
      '/products?q=caf%C3%A9+%26+ch%C3%A1',
    );
  });

  it('does not modify its arguments', () => {
    const params = { ...EMPTY_BROWSE, q: 'fone', page: 3 };
    browseHref(params, { sort: 'newest' });
    expect(params).toEqual({ ...EMPTY_BROWSE, q: 'fone', page: 3 });
  });
});
