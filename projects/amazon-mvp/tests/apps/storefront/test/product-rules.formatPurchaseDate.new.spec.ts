import { describe, expect, it } from 'vitest';
import { formatPurchaseDate } from '../src/features/product/product-rules';

describe('formatPurchaseDate', () => {
  it('writes "<day> de <Mês> de <year>" with an unpadded day and a capitalised short month', () => {
    expect(formatPurchaseDate('2026-01-05T15:00:00.000Z')).toBe('5 de Jan de 2026');
    expect(formatPurchaseDate('2026-05-20T12:00:00Z')).toBe('20 de Mai de 2026');
    expect(formatPurchaseDate('2026-09-07T10:00:00-03:00')).toBe('7 de Set de 2026');
  });

  it('uses the calendar day in São Paulo, not in UTC', () => {
    expect(formatPurchaseDate('2027-01-01T02:59:00Z')).toBe('31 de Dez de 2026');
    expect(formatPurchaseDate('2027-01-01T03:00:00Z')).toBe('1 de Jan de 2027');
  });
});
