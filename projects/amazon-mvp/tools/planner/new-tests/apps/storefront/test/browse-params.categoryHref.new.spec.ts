import { describe, expect, it } from 'vitest';
import { categoryHref } from '../src/features/browse/browse-params';

describe('categoryHref', () => {
  it('links to the listing with only the category set', () => {
    expect(categoryHref('livros')).toBe('/products?category=livros');
    expect(categoryHref('games-e-consoles')).toBe('/products?category=games-e-consoles');
    expect(categoryHref('')).toBe('/products');
  });
});
