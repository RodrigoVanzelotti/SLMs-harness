import { describe, expect, it } from 'vitest';
import { resultsSummary } from '../src/features/browse/browse-model';

describe('resultsSummary', () => {
  it('shows the item range of the page and the total', () => {
    expect(resultsSummary(1, 48, 150)).toBe('1-48 de 150 resultados');
    expect(resultsSummary(2, 48, 150)).toBe('49-96 de 150 resultados');
    expect(resultsSummary(2, 48, 60)).toBe('49-60 de 60 resultados');
    expect(resultsSummary(4, 48, 150)).toBe('145-150 de 150 resultados');
  });

  it('uses pt-BR thousands separators', () => {
    expect(resultsSummary(1, 48, 1500)).toBe('1-48 de 1.500 resultados');
    expect(resultsSummary(21, 48, 1500)).toBe('961-1.008 de 1.500 resultados');
  });

  it('shows only the count when everything fits on the first page', () => {
    expect(resultsSummary(1, 48, 12)).toBe('12 resultados');
    expect(resultsSummary(1, 48, 48)).toBe('48 resultados');
    expect(resultsSummary(1, 48, 0)).toBe('0 resultados');
  });

  it('uses the singular for exactly one result, on any page', () => {
    expect(resultsSummary(1, 48, 1)).toBe('1 resultado');
    expect(resultsSummary(2, 48, 1)).toBe('1 resultado');
  });
});
