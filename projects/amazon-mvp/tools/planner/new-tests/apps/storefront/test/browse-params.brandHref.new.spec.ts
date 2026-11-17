import { describe, expect, it } from 'vitest';
import { brandHref } from '../src/features/browse/browse-params';

describe('brandHref', () => {
  it('links to the listing filtered by the brand key', () => {
    expect(brandHref('8BitDo')).toBe('/products?brand=8bitdo');
    expect(brandHref('Letra Viva')).toBe('/products?brand=letra-viva');
    expect(brandHref('Genérico')).toBe('/products?brand=generico');
    expect(brandHref('')).toBe('/products');
  });
});
