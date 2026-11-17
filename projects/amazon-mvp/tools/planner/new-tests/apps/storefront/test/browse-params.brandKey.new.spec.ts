import { describe, expect, it } from 'vitest';
import { brandKey } from '../src/features/browse/browse-params';

describe('brandKey', () => {
  it('lowercases, strips accents and joins words with single hyphens', () => {
    expect(brandKey('Letra Viva')).toBe('letra-viva');
    expect(brandKey('Genérico')).toBe('generico');
    expect(brandKey('Ácido--Ômega 3')).toBe('acido-omega-3');
    expect(brandKey("L'Oréal Paris")).toBe('l-oreal-paris');
    expect(brandKey('8BitDo')).toBe('8bitdo');
  });

  it('trims leading and trailing separators', () => {
    expect(brandKey('  Já & Cia. ')).toBe('ja-cia');
    expect(brandKey('')).toBe('');
  });
});
