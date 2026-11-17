import { describe, expect, it } from 'vitest';
import { browseKey, EMPTY_BROWSE } from '../src/features/browse/browse-params';

describe('browseKey', () => {
  it('is the canonical URL, keeping the page, plus the page validity', () => {
    expect(browseKey(EMPTY_BROWSE)).toBe('/products#ok');
    expect(browseKey({ ...EMPTY_BROWSE, page: 3 })).toBe('/products?page=3#ok');
    expect(browseKey({ ...EMPTY_BROWSE, q: 'fone', sort: 'price-desc', page: 2 })).toBe(
      '/products?q=fone&sort=price-desc&page=2#ok',
    );
    expect(browseKey({ ...EMPTY_BROWSE, pageValid: false })).toBe('/products#invalid');
  });

  it('changes when the page changes', () => {
    expect(browseKey({ ...EMPTY_BROWSE, page: 2 })).not.toBe(browseKey({ ...EMPTY_BROWSE, page: 3 }));
  });
});
