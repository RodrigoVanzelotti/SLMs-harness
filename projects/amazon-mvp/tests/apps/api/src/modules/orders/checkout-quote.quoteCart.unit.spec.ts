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

describe('quoteCart', () => {
  it('gives no discount to card payments', () => {
    const quote = quoteCart(cartOf(99999), 'SIMULATED_CARD', pricing);
    expect(quote).toMatchObject({
      subtotalMinor: 99999,
      shippingMinor: 0,
      discountMinor: 0,
      totalMinor: 99999,
      paymentMethod: 'SIMULATED_CARD',
      discountPercent: 0,
    });
  });

  it('applies the configured Pix rate to the whole subtotal', () => {
    // 3 x 1234 = 3702; 5% = 185.1 -> 185 (per-unit rounding would give only 3 x 61).
    const quote = quoteCart(cartOf(1234, 3), 'SIMULATED_PIX', pricing);
    expect(quote).toMatchObject({
      subtotalMinor: 3702,
      discountMinor: 185,
      totalMinor: 3517,
      paymentMethod: 'SIMULATED_PIX',
      discountPercent: 5,
    });
    expect(
      quoteCart(cartOf(1234, 3), 'SIMULATED_PIX', { ...pricing, pixDiscountPercent: 0 }),
    ).toMatchObject({
      discountMinor: 0,
      totalMinor: 3702,
    });
  });

  it('binds payment method and rate into the revision', () => {
    const card = quoteCart(cartOf(1234), 'SIMULATED_CARD', pricing).revision;
    const pix = quoteCart(cartOf(1234), 'SIMULATED_PIX', pricing).revision;
    const otherRate = quoteCart(cartOf(1234), 'SIMULATED_PIX', {
      ...pricing,
      pixDiscountPercent: 10,
    }).revision;
    expect(new Set([card, pix, otherRate]).size).toBe(3);
    expect(quoteCart(cartOf(1234), 'SIMULATED_PIX', pricing).revision).toBe(pix);
    // A card quote does not depend on the Pix rate.
    expect(
      quoteCart(cartOf(1234), 'SIMULATED_CARD', { ...pricing, pixDiscountPercent: 10 }).revision,
    ).toBe(card);
  });
});

describe('installmentOptions (interest-free)', () => {
  const rules = { maxInstallments: 10, minInstallmentMinor: 500 };
  it('is part of card quotes only, computed on the discounted total', () => {
    expect(quoteCart(cartOf(1000), 'SIMULATED_CARD', pricing).installmentOptions).toHaveLength(2);
    expect(quoteCart(cartOf(1000), 'SIMULATED_PIX', pricing).installmentOptions).toEqual([]);
  });
});
