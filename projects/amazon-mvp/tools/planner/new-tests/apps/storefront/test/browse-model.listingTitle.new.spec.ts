import { describe, expect, it } from 'vitest';
import { listingTitle } from '../src/features/browse/browse-model';

describe('listingTitle', () => {
  it('titles a search with curly quotes and the category, ignoring the brand', () => {
    expect(listingTitle({ q: 'fone' })).toBe('Resultados para “fone”');
    expect(listingTitle({ q: 'fone', categoryName: 'Áudio' })).toBe('Resultados para “fone” em Áudio');
    expect(listingTitle({ q: 'fone', brandName: 'Vortex' })).toBe('Resultados para “fone”');
    expect(listingTitle({ q: 'fone', brandName: 'Vortex', categoryName: 'Áudio' })).toBe(
      'Resultados para “fone” em Áudio',
    );
  });

  it('falls back to the brand, then the category, then all products', () => {
    expect(listingTitle({ q: '', brandName: 'Vortex' })).toBe('Vortex');
    expect(listingTitle({ q: '', brandName: 'Vortex', categoryName: 'Áudio' })).toBe('Vortex em Áudio');
    expect(listingTitle({ q: '', categoryName: 'Livros' })).toBe('Livros');
    expect(listingTitle({ q: '' })).toBe('Todos os produtos');
  });
});
