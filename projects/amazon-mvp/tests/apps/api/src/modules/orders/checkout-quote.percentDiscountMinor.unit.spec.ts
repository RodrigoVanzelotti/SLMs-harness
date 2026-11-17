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

describe('percentDiscountMinor (floor rule)', () => {

  it('handles 0% and 100%', () => {
    expect(percentDiscountMinor(99999, 0)).toBe(0);
    expect(percentDiscountMinor(99999, 100)).toBe(99999);
  });

  it.each([
    [-1, 5],
    [1.5, 5],
    [Number.NaN, 5],
    [100, -1],
    [100, 101],
    [100, 2.5],
  ])('rejects amount %s with rate %s', (amount, percent) => {
    expect(() => percentDiscountMinor(amount, percent)).toThrow(RangeError);
  });
});
