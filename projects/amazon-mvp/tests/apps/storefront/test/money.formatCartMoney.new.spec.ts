import { describe, expect, it } from 'vitest';
import { formatCartMoney } from '../src/features/cart/money';

describe('formatCartMoney', () => {
  it('formats minor units as pt-BR currency, BRL by default', () => {
    expect(formatCartMoney(1099)).toMatch(/^R\$\s10,99$/);
    expect(formatCartMoney(0)).toMatch(/^R\$\s0,00$/);
    expect(formatCartMoney(5)).toMatch(/^R\$\s0,05$/);
    expect(formatCartMoney(123456)).toMatch(/^R\$\s1\.234,56$/);
    expect(formatCartMoney(100000000)).toMatch(/^R\$\s1\.000\.000,00$/);
  });

  it('uses the given currency code', () => {
    expect(formatCartMoney(1000, 'USD')).toMatch(/^US\$\s10,00$/);
    expect(formatCartMoney(1099, 'BRL')).toBe(formatCartMoney(1099));
  });
});
