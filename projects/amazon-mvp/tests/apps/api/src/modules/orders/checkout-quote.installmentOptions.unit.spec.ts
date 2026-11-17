import {
  CartResponse,
  installmentOptions,
  percentDiscountMinor,
  pixPriceMinor,
} from '@amazon-mvp/api-contract';
import { quoteCart } from './checkout-quote';

const cartOf = (unitPriceMinor: number, quantity = 1): CartResponse => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: 'user',
  itemCount: quantity,
  subtotalMinor: unitPriceMinor * quantity,
  currency: 'BRL',
  lines: [
    {
      productId: 'product',
      quantity,
      unitPriceMinor,
      lineTotalMinor: unitPriceMinor * quantity,
      product: {
        id: 'product',
        sku: 'SKU',
        slug: 'product',
        name: 'Product',
        description: null,
        priceMinor: unitPriceMinor,
        currency: 'BRL',
        active: true,
        availableQuantity: 99,
        inStock: true,
      },
    },
  ],
});
const pricing = { pixDiscountPercent: 5, maxInstallments: 10, minInstallmentMinor: 500 };

describe('installmentOptions (interest-free)', () => {
  const rules = { maxInstallments: 10, minInstallmentMinor: 500 };
  it('offers up to the maximum and puts the remainder in the first installment', () => {
    const options = installmentOptions(10000, rules);
    expect(options.map((o) => o.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(options[2]).toEqual({ count: 3, installmentMinor: 3333, firstInstallmentMinor: 3334 });
    for (const o of options)
      expect(o.firstInstallmentMinor + o.installmentMinor * (o.count - 1)).toBe(10000);
  });
  it('stops when an installment would fall below the minimum', () => {
    expect(installmentOptions(1999, rules).map((o) => o.count)).toEqual([1, 2, 3]);
    expect(installmentOptions(499, rules)).toEqual([
      { count: 1, installmentMinor: 499, firstInstallmentMinor: 499 },
    ]);
  });
  it('offers only 1x when installments are disabled', () => {
    expect(installmentOptions(100000, { ...rules, maxInstallments: 1 })).toHaveLength(1);
  });
});
