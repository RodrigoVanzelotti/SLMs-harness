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
  it.each([
    [0, 0],
    [1, 0],
    [19, 0],
    [20, 1],
    [39, 1],
    [40, 2],
    [32900, 1645],
    [99999, 4999],
    [2147483647, 107374182],
  ])('5%% of %i cents is %i cents', (amount, discount) => {
    expect(percentDiscountMinor(amount, 5)).toBe(discount);
    expect(pixPriceMinor(amount, pricing)).toBe(amount - discount);
  });
});
